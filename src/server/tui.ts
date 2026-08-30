/**
 * TUI — live ANSI streaming of pipeline traces in the terminal.
 *
 * Prints one line per trace event with agent-colored prefixes. When the PLAN
 * agent signals it's awaiting approval, the TUI prompts the user inline
 * (Approve / Reject / feedback) and resolves the approval gate.
 */
import { runOne, type Job } from "../pipeline/run.ts";
import { traceBus, type TraceEvent } from "../pipeline/trace.ts";
import { approvalGate } from "../pipeline/approval.ts";

const COLORS: Record<string, string> = {
  SYSTEM: "\x1b[90m",
  READ: "\x1b[34m",
  RESEARCH: "\x1b[35m",
  PLAN: "\x1b[33m",
  CODE: "\x1b[32m",
  ORCHESTRATOR: "\x1b[31m",
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function ts(t: string): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false });
}

function renderTrace(ev: TraceEvent): string {
  const c = COLORS[ev.agent] ?? "";
  const kindTag = ev.kind === "STEP" ? "" : `${DIM}${ev.kind}${RESET} `;
  const toolTag = ev.tool ? `${DIM}[${ev.tool}]${RESET}` : "";
  const conclusion = ev.conclusion ? ` ${ev.conclusion}` : "";
  const oq = ev.output_query && ev.kind === "OUTPUT" ? ` → ${ev.output_query}` : "";
  return `${c}${ts(ev.ts)}${RESET} ${c}${BOLD}${ev.agent.padEnd(12)}${RESET} ${kindTag}${ev.step ? `${ev.step}:` : ""}${conclusion} ${toolTag}${oq}`;
}

async function* signalLines(): AsyncGenerator<string> {
  const lineBuf: string[] = [];
  const decoder = new TextDecoder();

  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf.push(...decoder.decode(value).split("\n"));
    while (lineBuf.length > 1) {
      yield lineBuf.shift()!;
    }
  }
  if (lineBuf.length) yield lineBuf[0]!;
}

export async function runTui(job: Job): Promise<void> {
  const jobUuid = job.job_uuid ?? crypto.randomUUID();
  job.job_uuid = jobUuid;

  console.log(`\n${BOLD}Polaris AI${RESET} ${DIM}— paper reproduction pipeline${RESET}\n`);
  console.log(`${DIM}Job: ${jobUuid}${RESET}`);
  console.log(`${DIM}Paper: ${job.arxiv_id ?? (job.markdown ? "uploaded file" : "??")}${RESET}`);
  console.log(`${DIM}Engine: ${job.engine ?? "local"}${job.reuse_if_exists ? " · reuse-if-exists" : ""}${RESET}\n`);

  let approvalHandled = false;

  const unsub = traceBus.subscribe(jobUuid, (ev) => {
    console.log(renderTrace(ev));
    if (ev.kind === "AWAIT_USER" && !approvalHandled && !job.auto_approve) {
      approvalHandled = true;
      promptApproval(jobUuid).catch(() => {});
    }
  });

  const result = runOne(job);

  // Stream traces while the pipeline runs. When it finishes, print the result.
  const final = await result;
  unsub();

  const code = final.code;
  if (final.error || code?.push_error) {
    console.log(`\n${COLORS.ORCHESTRATOR}${BOLD}FAILED${RESET}: ${final.error ?? code?.push_error ?? "unknown"}\n`);
  } else if (code?.github_url) {
    console.log(`\n${COLORS.CODE}${BOLD}DONE${RESET} → ${code.github_url}\n`);
  } else {
    console.log(`\n${BOLD}Done${RESET} (status: ${final.status ?? "done"})\n`);
  }
}

async function promptApproval(jobUuid: string): Promise<void> {
  const plan = approvalGate.hasPending(jobUuid);
  if (!plan) return;
  console.log(`\n${COLORS.PLAN}${BOLD}Plan ready for approval:${RESET}\n`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\n${DIM}Approve? [Y]es / [n]o / [f]eedback${RESET}`);

  for await (const line of signalLines()) {
    const t = line.trim().toLowerCase();
    if (t === "" || t === "y" || t === "yes") {
      approvalGate.resolve(jobUuid, { approved: true, feedback: "" });
      console.log(`${COLORS.CODE}Approved — proceeding to CODE${RESET}\n`);
      return;
    }
    if (t === "n" || t === "no") {
      approvalGate.resolve(jobUuid, { approved: false, feedback: "" });
      console.log(`${COLORS.ORCHESTRATOR}Rejected — replanning${RESET}\n`);
      return;
    }
    if (t === "f" || t === "feedback") {
      console.log(`${DIM}Enter feedback then press Enter:${RESET}`);
      for await (const fb of signalLines()) {
        approvalGate.resolve(jobUuid, { approved: false, feedback: fb.trim() });
        console.log(`${COLORS.ORCHESTRATOR}Feedback sent — replanning${RESET}\n`);
        return;
      }
    }
    console.log(`${DIM}Press Y to approve, N to reject, or F for feedback${RESET}`);
  }
}
