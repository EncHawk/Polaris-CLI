/**
 * TUI — a full-screen chat interface for the normal invocation (`polaris run`).
 *
 * Layout (alternate screen buffer):
 *   ┌ header: paper · engine · phase/status ─────────────────┐
 *   │ transcript: agent messages, tool steps, plan cards,     │
 *   │             user lines (scroll with ↑/↓)                │
 *   ├ hints ──────────────────────────────────────────────────┤
 *   │ input line (typed feedback / commands)                  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Chat semantics:
 *   - while the plan awaits approval: Enter on empty/y approves, `n` rejects,
 *     any other typed text is sent as rejection feedback (replan)
 *   - after the run: `:rerun [feedback]`, `:modify <feedback>`, `:url`, `:q`
 *   - Ctrl-C exits immediately (cancels the pipeline)
 *
 * When stdin/stdout are not a TTY (piped output, CI), falls back to the
 * original line-mode stream so `polaris run … | tee log` still works.
 */
import { runOne, type Job } from "../pipeline/run.ts";
import { traceBus, type TraceEvent } from "../pipeline/trace.ts";
import { approvalGate } from "../pipeline/approval.ts";
import type { PlanOutput, WorkerState } from "../state.ts";

const C = {
  SYSTEM: "\x1b[90m",
  READ: "\x1b[34m",
  RESEARCH: "\x1b[35m",
  PLAN: "\x1b[33m",
  CODE: "\x1b[32m",
  VERIFY: "\x1b[32m",
  ORCHESTRATOR: "\x1b[31m",
  USER: "\x1b[36m",
  ACCENT: "\x1b[36m",
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REV = "\x1b[7m";

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Visible width of an ANSI-styled string. */
export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Greedy word-wrap an ANSI-styled string to `width` visible columns. */
export function wrapText(s: string, width: number): string[] {
  if (width < 4) return [s];
  const out: string[] = [];
  let line = "";
  let lineLen = 0;
  for (const word of s.split(" ")) {
    // split words that are alone longer than the width
    const parts: string[] = [];
    let rest = word;
    while (visibleLen(rest) > width) {
      let cut = width;
      while (cut > 1 && visibleLen(rest.slice(0, cut)) > width) cut -= 1;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    for (const part of parts) {
      const wlen = visibleLen(part);
      if (lineLen === 0) {
        line = part;
        lineLen = wlen;
      } else if (lineLen + 1 + wlen <= width) {
        line += " " + part;
        lineLen += 1 + wlen;
      } else {
        out.push(line);
        line = part;
        lineLen = wlen;
      }
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function ts(t: string): string {
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

function truncateStyled(s: string, width: number): string {
  if (visibleLen(s) <= width) return s;
  let cut = width;
  while (cut > 1 && visibleLen(s.slice(0, cut)) > width) cut -= 1;
  return s.slice(0, cut) + RESET;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-mode fallback (non-TTY)
// ─────────────────────────────────────────────────────────────────────────────

function renderTraceLine(ev: TraceEvent): string {
  const c = C[ev.agent] ?? "";
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

async function runLineTui(job: Job): Promise<void> {
  console.log(`\n${BOLD}Polaris AI${RESET} ${DIM}— paper reproduction pipeline (line mode)${RESET}\n`);
  console.log(`${DIM}Paper: ${job.arxiv_id ?? (job.markdown ? "uploaded file" : "??")} · engine ${job.engine ?? "local"}${RESET}\n`);

  let approvalHandled = false;
  const unsub = traceBus.subscribe(jobUuid(job), (ev) => {
    console.log(renderTraceLine(ev));
    if (ev.kind === "AWAIT_USER" && !approvalHandled && !job.auto_approve) {
      approvalHandled = true;
      promptApprovalLineMode(jobUuid(job)).catch(() => {});
    }
  });
  const final = await runOne(job);
  unsub();
  printFinalLineMode(final);
}

function printFinalLineMode(final: WorkerState): void {
  const code = final.code;
  if (final.error || code?.push_error) {
    console.log(`\n${C.ORCHESTRATOR}${BOLD}FAILED${RESET}: ${final.error ?? code?.push_error ?? "unknown"}\n`);
  } else if (code?.github_url) {
    console.log(`\n${C.CODE}${BOLD}DONE${RESET} → ${code.github_url}\n`);
  } else {
    console.log(`\n${BOLD}Done${RESET} (status: ${final.status ?? "done"})\n`);
  }
}

async function promptApprovalLineMode(jobUuid: string): Promise<void> {
  const plan = approvalGate.hasPending(jobUuid);
  if (!plan) return;
  console.log(`\n${C.PLAN}${BOLD}Plan ready for approval:${RESET}\n`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\n${DIM}Approve? [Y]es / [n]o / [f]eedback${RESET}`);
  for await (const line of signalLines()) {
    const t = line.trim().toLowerCase();
    if (t === "" || t === "y" || t === "yes") {
      approvalGate.resolve(jobUuid, { approved: true, feedback: "" });
      console.log(`${C.CODE}Approved — proceeding to CODE${RESET}\n`);
      return;
    }
    if (t === "n" || t === "no") {
      approvalGate.resolve(jobUuid, { approved: false, feedback: "" });
      console.log(`${C.ORCHESTRATOR}Rejected — replanning${RESET}\n`);
      return;
    }
    if (t === "f" || t === "feedback") {
      console.log(`${DIM}Enter feedback then press Enter:${RESET}`);
      for await (const fb of signalLines()) {
        approvalGate.resolve(jobUuid, { approved: false, feedback: fb.trim() });
        console.log(`${C.ORCHESTRATOR}Feedback sent — replanning${RESET}\n`);
        return;
      }
    }
    console.log(`${DIM}Press Y to approve, N to reject, or F for feedback${RESET}`);
  }
}

function jobUuid(job: Job): string {
  return job.job_uuid ?? (job.job_uuid = crypto.randomUUID());
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-screen chat TUI
// ─────────────────────────────────────────────────────────────────────────────

type Mode = "running" | "approval" | "done";

interface FollowUp {
  type: "quit" | "rerun" | "modify" | "none";
  feedback: string;
}

class ChatTui {
  private lines: string[] = [];
  private view = 0; // rows scrolled up from the bottom; 0 = stick to bottom
  private input = "";
  private mode: Mode = "running";
  private hints = "running… · ↑↓ scroll · Ctrl-C cancel";
  private headerLeft = "Polaris";
  private headerRight = "";
  private pendingApproval: string | null = null;
  private commandResolver: ((cmd: string) => void) | null = null;
  private disposed = false;
  private escBuf = "";
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private resizeHandler: (() => void) | null = null;
  private renderQueued = false;

  constructor(private baseJob: Job) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    process.stdin.setRawMode?.(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"); // alt screen, hide cursor, clear
    this.render();
    this.resizeHandler = () => this.render();
    try {
      process.stdout.on("resize", this.resizeHandler);
    } catch {
      /* resize events unsupported — fine */
    }
    this.reader = Bun.stdin.stream().getReader();
    this.readKeys().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      process.stdout.off?.("resize", this.resizeHandler!);
    } catch {
      /* ignore */
    }
    try {
      this.reader?.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
  }

  private async readKeys(): Promise<void> {
    while (!this.disposed) {
      const { done, value } = await this.reader!.read();
      if (done) break;
      this.handleChunk(this.decoder.decode(value, { stream: true }));
    }
  }

  // ── transcript ───────────────────────────────────────────────────────────

  add(raw: string): void {
    const { width } = this.size();
    for (const l of wrapText(raw.replace(/\s+$/, ""), Math.max(width - 2, 20))) {
      this.lines.push(l);
    }
    if (this.view !== 0) this.view = 0; // new output unsticks the scroll
    this.render();
  }

  addBlock(lines: string[]): void {
    const { width } = this.size();
    for (const b of lines) {
      for (const l of wrapText(b.replace(/\s+$/, ""), Math.max(width - 2, 20))) {
        this.lines.push(l);
      }
    }
    this.render();
  }

  setHeader(left: string, right: string): void {
    this.headerLeft = left;
    this.headerRight = right;
    this.render();
  }

  setHeaderRight(right: string): void {
    this.headerRight = right;
    this.render();
  }

  setHints(h: string): void {
    this.hints = h;
    this.render();
  }

  // ── trace handling ───────────────────────────────────────────────────────

  onTrace(ev: TraceEvent): void {
    const c = C[ev.agent] ?? "";
    const time = `${DIM}${ts(ev.ts)}${RESET}`;
    switch (ev.kind) {
      case "STATUS":
        this.setHeaderRight(ev.conclusion);
        this.add(`${C.SYSTEM}${time} ${BOLD}${ev.conclusion}${RESET}`);
        return;
      case "ERROR":
        this.add(`${C.ORCHESTRATOR}${time} ${BOLD}✗ ${ev.agent}${RESET} ${ev.conclusion}`);
        return;
      case "OUTPUT":
        this.add(`${c}${time} ${BOLD}● ${ev.agent}${RESET} ${ev.conclusion}${ev.output_query ? ` ${DIM}→ ${ev.output_query}${RESET}` : ""}`);
        return;
      case "AWAIT_USER": {
        const plan = ev.output_query ? (JSON.parse(ev.output_query) as PlanOutput) : approvalGate.hasPending(ev.job_uuid);
        this.showApproval(ev.job_uuid, plan);
        return;
      }
      default: {
        const tool = ev.tool ? ` ${DIM}[${ev.tool}]${RESET}` : "";
        const step = ev.step ? `${BOLD}${ev.step}:${RESET} ` : "";
        this.add(`${c}${time} ${BOLD}${ev.agent.padEnd(10)}${RESET} ${step}${ev.conclusion}${tool}`);
      }
    }
  }

  showApproval(jobUuid: string, plan: PlanOutput | null): void {
    if (!plan || this.pendingApproval) return;
    this.pendingApproval = jobUuid;
    this.mode = "approval";
    const { width } = this.size();
    const inner = Math.max(width - 6, 30);
    const box: string[] = [];
    const row = (s: string) => box.push(`${C.PLAN}│${RESET} ` + s);
    box.push(`${C.PLAN}╭─ PLAN — awaiting your approval ${"─".repeat(Math.max(inner - 33, 3))}╮${RESET}`);
    for (const [label, val] of [
      ["prove", plan.intends_to_prove ?? ""],
      ["method", plan.proof_method ?? ""],
    ] as const) {
      const wrapped = wrapText(val, inner - 10);
      wrapped.forEach((w, i) =>
        row(`${i === 0 ? `${BOLD}${label.padEnd(8)}${RESET} ` : `${" ".repeat(9)}`}${w}`),
      );
    }
    if (plan.deltas_from_base?.length) {
      row(`${BOLD}deltas  ${RESET} `);
      for (const d of plan.deltas_from_base.slice(0, 8)) {
        for (const [i, w] of wrapText(`• ${d}`, inner - 4).entries()) {
          row(`${i === 0 ? "" : "  "}${w}`);
        }
      }
    }
    if (plan.plan?.length) {
      row(`${BOLD}files   ${RESET} `);
      for (const [i, f] of plan.plan.slice(0, 15).entries()) {
        for (const [j, w] of wrapText(`${i + 1}. ${f}`, inner - 4).entries()) {
          row(`${j === 0 ? "" : "  "}${w}`);
        }
      }
      if (plan.plan.length > 15) row(`${DIM}… ${plan.plan.length - 15} more${RESET}`);
    }
    box.push(`${C.PLAN}╰${"─".repeat(inner + 2)}╯${RESET}`);
    this.addBlock(box);
    this.setHints("⏎ approve · n reject · type feedback + ⏎ replan");
  }

  onUserLine(text: string): void {
    this.add(`${C.USER}${BOLD}[you]${RESET} ${text}`);
  }

  setDone(final: WorkerState): void {
    this.mode = "done";
    this.pendingApproval = null;
    const code = final.code;
    if (final.error || code?.push_error) {
      this.setHeaderRight("failed");
      this.add(`${C.ORCHESTRATOR}${BOLD}✗ FAILED${RESET} ${final.error ?? code?.push_error ?? "unknown"}`);
    } else if (code?.github_url) {
      this.setHeaderRight("done");
      this.add(
        `${C.CODE}${BOLD}● DONE${RESET} ${code.github_url} ${DIM}(${(code.files ?? []).length} files · ${code.repo_name ?? ""})${RESET}`,
      );
    } else {
      this.setHeaderRight(final.status ?? "done");
      this.add(`${BOLD}● Done${RESET} ${DIM}status: ${final.status ?? "done"}${RESET}`);
    }
    this.setHints(":rerun [feedback] · :modify <feedback> · :url · :q quit");
  }

  /** Resolves on the next submitted input while in `done` mode. */
  readCommand(): Promise<string> {
    return new Promise((resolve) => {
      this.commandResolver = resolve;
    });
  }

  // ── key handling ─────────────────────────────────────────────────────────

  private handleChunk(decoded: string): void {
    for (const ch of decoded) {
      if (this.escBuf) {
        this.escBuf += ch;
        if (this.escBuf === "\x1b[A") this.scroll(-1);
        else if (this.escBuf === "\x1b[B") this.scroll(1);
        if (this.escBuf.length >= 3 || /[A-D~]/.test(ch)) this.escBuf = "";
        continue;
      }
      if (ch === "\x1b") {
        this.escBuf = "\x1b";
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        this.submit();
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        this.input = this.input.slice(0, -1);
        this.render();
        continue;
      }
      if (ch === "\x03") {
        this.dispose();
        process.exit(130);
      }
      if (ch === "\t" || ch < " ") continue;
      this.input += ch;
      this.render();
    }
  }

  private submit(): void {
    const text = this.input.trim();
    this.input = "";
    if (this.mode === "approval" && this.pendingApproval) {
      const uuid = this.pendingApproval;
      if (text === "" || /^y(es)?$/i.test(text)) {
        approvalGate.resolve(uuid, { approved: true, feedback: "" });
        this.onUserLine("y (approve)");
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl-C cancel");
      } else if (/^n(o)?$/i.test(text)) {
        approvalGate.resolve(uuid, { approved: false, feedback: "" });
        this.onUserLine("n (reject)");
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl-C cancel");
      } else {
        approvalGate.resolve(uuid, { approved: false, feedback: text });
        this.onUserLine(text);
        this.add(`${C.ORCHESTRATOR}feedback sent — replanning${RESET}`);
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl-C cancel");
      }
      this.render();
      return;
    }
    if (this.mode === "done") {
      const r = this.commandResolver;
      if (r) {
        this.commandResolver = null;
        if (text) this.onUserLine(text);
        r(text);
      }
      this.render();
      return;
    }
    // running: echo as a chat line (noted for the approval prompt)
    if (text) this.onUserLine(text);
    this.render();
  }

  private scroll(delta: number): void {
    const { rows } = this.size();
    const body = Math.max(rows - 3, 1);
    this.view = Math.min(Math.max(this.view + delta, 0), Math.max(this.lines.length - body, 0));
    this.render();
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private size(): { width: number; rows: number } {
    return {
      width: Math.max(process.stdout.columns ?? 80, 40),
      rows: Math.max(process.stdout.rows ?? 24, 10),
    };
  }

  render(): void {
    if (this.disposed) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.paint();
    });
  }

  private paint(): void {
    if (this.disposed) return;
    const { width, rows } = this.size();
    const body = Math.max(rows - 3, 1);
    const out: string[] = [];
    // header
    const left = ` ${C.ACCENT}${BOLD}Polaris${RESET} ${DIM}${this.headerLeft}${RESET}`;
    const right = `${DIM}${this.headerRight}${RESET} `;
    const leftLen = visibleLen(left);
    const rightLen = visibleLen(right);
    const pad = Math.max(width - leftLen - rightLen, 1);
    out.push(`\x1b[H\x1b[2K${left}${" ".repeat(pad)}${right}`);
    // transcript
    const start = Math.max(this.lines.length - body - this.view, 0);
    const visible = this.lines.slice(start, start + body);
    for (let i = 0; i < body; i++) {
      const l = visible[i];
      out.push(`\x1b[2K${l ?? ""}`);
      if (l == null) continue;
    }
    if (this.view > 0) {
      out[1] = `\x1b[2K${DIM}↑ ${this.view} more lines (↓ to scroll down)${RESET}`;
    }
    // hints + input
    out.push(`\x1b[2K${DIM}${truncateStyled(this.hints, width)}${RESET}`);
    const inputPrefix = `${C.USER}${BOLD}▸${RESET} `;
    const room = Math.max(width - visibleLen(inputPrefix) - 1, 1);
    const shown = this.input.length > room ? this.input.slice(this.input.length - room) : this.input;
    out.push(`\x1b[2K${inputPrefix}${shown}${REV} ${RESET}`);
    process.stdout.write(out.join("\n") + "\x1b[J");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function isInteractive(): boolean {
  return (
    !!process.stdin.isTTY &&
    !!process.stdout.isTTY &&
    typeof process.stdin.setRawMode === "function" &&
    Bun.env.TERM !== "dumb" &&
    Bun.env.TERM !== undefined
  );
}

/**
 * Run the pipeline with the chat TUI (or line-mode fallback). After a run
 * completes the interface stays open: the user can rerun with plan feedback,
 * modify the produced repo with code feedback, or quit.
 */
export async function runTui(job: Job): Promise<void> {
  const uuid = jobUuid(job);
  if (!isInteractive()) return runLineTui(job);

  const tui = new ChatTui(job);
  await tui.start();
  let current: Job = { ...job, job_uuid: uuid };
  let lastFinal: WorkerState | null = null;

  try {
    for (;;) {
      const runUuid = jobUuid(current);
      current.job_uuid = runUuid;
      tui.setHeader(
        `${current.arxiv_id ?? (current.markdown ? "uploaded paper" : "??")} · engine ${current.engine ?? "local"}${current.reuse_if_exists ? " · reuse" : ""}`,
        "starting",
      );
      tui.setHints("running… · ↑↓ scroll · Ctrl-C cancel");
      tui.add(`${DIM}job ${runUuid}${RESET}`);

      const unsub = traceBus.subscribe(runUuid, (ev) => tui.onTrace(ev));
      let final: WorkerState;
      try {
        final = await runOne(current);
      } finally {
        unsub();
      }
      lastFinal = final;
      tui.setDone(final);

      // chat loop: wait for a post-run command
      let followUp: FollowUp = { type: "none", feedback: "" };
      while (followUp.type === "none") {
        const cmd = await tui.readCommand();
        followUp = interpretCommand(cmd, tui, lastFinal);
      }
      if (followUp.type === "quit") {
        traceBus.clear(runUuid);
        printExitSummary(lastFinal);
        return;
      }
      traceBus.clear(runUuid);
      current = buildFollowUpJob(job, current, lastFinal!, followUp);
      tui.add(`${C.SYSTEM}${BOLD}── new run ──${RESET}`);
    }
  } finally {
    tui.dispose();
  }
}

function interpretCommand(cmd: string, tui: ChatTui, final: WorkerState | null): FollowUp {
  const [head, ...rest] = cmd.trim().split(/\s+/);
  const feedback = rest.join(" ").trim();
  switch ((head ?? "").toLowerCase()) {
    case "":
    case ":q":
    case ":quit":
    case "q":
      return { type: "quit", feedback: "" };
    case ":rerun":
      return { type: "rerun", feedback };
    case ":modify":
      if (!final?.code?.repo_name) {
        tui.add(`${C.ORCHESTRATOR}nothing to modify — no repo was produced${RESET}`);
        return { type: "none", feedback: "" };
      }
      return { type: "modify", feedback };
    case ":url":
      if (final?.code?.github_url) tui.add(`${C.CODE}${final.code.github_url}${RESET}`);
      else tui.add(`${C.ORCHESTRATOR}no github url for this run${RESET}`);
      return { type: "none", feedback: "" };
    case ":help":
      tui.add(`${DIM}:rerun [feedback] — run the pipeline again (optionally with plan feedback)${RESET}`);
      tui.add(`${DIM}:modify <feedback> — re-run against the produced repo with CODE feedback${RESET}`);
      tui.add(`${DIM}:url — show the repo url · :q — quit${RESET}`);
      return { type: "none", feedback: "" };
    default:
      tui.add(`${C.ORCHESTRATOR}unknown command "${head}" — try :help${RESET}`);
      return { type: "none", feedback: "" };
  }
}

function buildFollowUpJob(base: Job, last: Job, final: WorkerState, followUp: FollowUp): Job {
  const job: Job = {
    ...base,
    job_uuid: crypto.randomUUID(),
    arxiv_id: last.arxiv_id,
    markdown: last.markdown,
    engine: last.engine,
    reuse_if_exists: false, // follow-ups always regenerate
    auto_approve: base.auto_approve,
    output_dir: last.output_dir,
  };
  if (followUp.type === "rerun") {
    if (followUp.feedback) job.plan_feedback = followUp.feedback;
    return job;
  }
  // modify: rerun against the produced repo; CODE gets the feedback
  const repoName = final.code?.repo_name ?? "";
  return {
    ...job,
    repo_name: repoName,
    repo_exists: true,
    execution_mode: "modify",
    code_feedback: followUp.feedback || "apply the user's requested changes",
  };
}

function printExitSummary(final: WorkerState | null): void {
  const code = final?.code;
  if (final && (final.error || code?.push_error)) {
    console.log(`${C.ORCHESTRATOR}${BOLD}FAILED${RESET}: ${final.error ?? code?.push_error ?? "unknown"}\n`);
  } else if (code?.github_url) {
    console.log(`${C.CODE}${BOLD}DONE${RESET} → ${code.github_url}\n`);
  } else {
    console.log(`${BOLD}Bye.${RESET}\n`);
  }
}
