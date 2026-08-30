import type { ToolDef, ToolArgs, ToolHandlers, ChatMessage } from "./types.ts";
import type { WorkerState, VerifyOutput } from "../state.ts";
import { markAgentRun } from "../state.ts";
import { status, step } from "../pipeline/trace.ts";
import { runAgentTurn, type EngineType } from "../agents_util/engine.ts";
import { Workspace, sanitizeRepoName } from "../tools/workspace.ts";
import { defaultRepoName, extractTitle } from "../tools/upload.ts";

export const VERIFY_SYSTEM_PROMPT = `You are the VERIFY agent for the Polaris paper-reproduction pipeline. Your job is to ensure the implementation actually persisted every signal from the initial paper intake, the plan, and any post-plan suggestions.

You have read-only access to the project workspace plus the READ, PLAN, and user feedback outputs.

Rules:
1. List the files in the workspace.
2. Read every file the plan says should exist (plan[]. entries) — if a file is missing, note it in files_missing.
3. Cross-check deltas_from_base/intends_to_prove/proof_method against file contents: each delta/suggestion should be visible in at least one file (code, comment, or README).
4. Cross-check the initial READ signals (aim, novel_approach, relevant_citations, numbers, built_on) — every relevant_citation and number that the plan marked as an additional query should appear (comment, import, usage, or docs) in the code or README. Record covered ones in initial_queries_covered, missing in missing_signals.
5. Cross-check post-plan suggestions: if the user gave plan_feedback or orchestrator_feedback after the plan, verify those suggestions were also persisted in the workspace (e.g., reviewer feedback incorporated).
6. Run a cheap syntactic check: \`python -m py_compile <file>\` for each .py file you found; skip non-Python.
7. Summarize what passed and what is missing, then call complete_verify with checks_passed=true only if every required signal is present.

Available tools:
- read_file: Read a file from the workspace (provide file_path)
- list_files: List files in the workspace (optional directory)
- run_command: Run a shell command in the workspace (provide command, optional timeout)
- complete_verify: Call when verification is done

Be strict but fair — report missing signals explicitly.`;

export const VERIFY_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path relative to workspace root" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the workspace directory.",
      parameters: {
        type: "object",
        properties: { directory: { type: "string", description: "Directory to list (default: root)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace. Returns stdout + stderr + return code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "integer", description: "Seconds before timeout (default 60)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_verify",
      description: "Call with your verification result once all checks are done.",
      parameters: {
        type: "object",
        properties: {
          plan_signals_covered: {
            type: "array",
            items: { type: "string" },
            description: "Plan signals/deltas that are present in the implementation",
          },
          missing_signals: {
            type: "array",
            items: { type: "string" },
            description: "Plan/initial signals that are missing or not persisted",
          },
          initial_queries_covered: {
            type: "array",
            items: { type: "string" },
            description: "Initial READ / additional-query signals covered",
          },
          files_verified: {
            type: "array",
            items: { type: "string" },
            description: "Files that exist and passed basic checks",
          },
          files_missing: {
            type: "array",
            items: { type: "string" },
            description: "Planned files that are absent",
          },
          checks_passed: { type: "boolean", description: "Overall pass/fail" },
          output_query: { type: "string", description: "One-sentence summary of the verification" },
        },
        required: ["checks_passed", "output_query"],
      },
    },
  },
];

export async function runVerify(state: WorkerState): Promise<Partial<WorkerState>> {
  const jobUuid = state.job_uuid;
  const runs = markAgentRun(state, "VERIFY");
  status(jobUuid, "verifying");

  // Workspace — same repo as CODE (even though VERIFY has run before, CODE
  // may have bridged sandbox artifacts; re-open the same dir).
  const repoName = sanitizeRepoName(
    state.repo_name || defaultRepoName(state.arxiv_id ?? "", extractTitle(state.markdown ?? ""), jobUuid),
  );
  let workspace: Workspace;
  try {
    workspace = await Workspace.create(repoName, state.output_dir, "modify");
  } catch (e) {
    step(jobUuid, "VERIFY", "workspace-open-failed", {
      tool: "workspace",
      conclusion: (e as Error).message,
    });
    const verify: VerifyOutput = {
      plan_signals_covered: [],
      missing_signals: [`workspace inaccessible: ${(e as Error).message}`],
      initial_queries_covered: [],
      files_verified: [],
      files_missing: [],
      checks_passed: false,
      ready: false,
      output_query: `verify failed: ${(e as Error).message}`,
    };
    return { verify, runs };
  }

  const plan = state.plan ?? {};
  const read = state.read ?? {};
  // Do not silently truncate verification evidence — VERIFY must check every signal.
  // Previous 6k slicing dropped tail entries (planned files, deltas, citations) and could falsely pass.
  // Now we send the full structured blobs (plans are typically <8k; even large ones are <30k, well within LLM limits).
  // If they ever exceed a generous cap, we explicitly mark truncation instead of silently dropping tail data.
  const MAX_VERIFY_BLOB = 25000;
  function formatBlob(obj: unknown, label: string): string {
    const full = JSON.stringify(obj, null, 2);
    if (full.length <= MAX_VERIFY_BLOB) return full;
    const head = full.slice(0, MAX_VERIFY_BLOB);
    return head + `\n...[TRUNCATED: ${label} was ${full.length} chars, truncated to ${MAX_VERIFY_BLOB}. VERIFY must list remaining signals as missing and request manual review.]`;
  }
  const planBlob = formatBlob(
    {
      intends_to_prove: plan.intends_to_prove,
      proof_method: plan.proof_method,
      deltas_from_base: plan.deltas_from_base,
      plan: plan.plan,
      custom_kernels: plan.custom_kernels,
    },
    "PLAN",
  );
  const readBlob = formatBlob(
    {
      aim: read.aim,
      novel_approach: read.novel_approach,
      numbers: read.numbers,
      relevant_citations: read.relevant_citations,
      built_on: read.built_on,
      experiments: read.experiments,
    },
    "READ",
  );

  // Snapshot of what's already on disk (for prompt context).
  let preList = "";
  try {
    preList = await workspace.listFiles(".");
  } catch {
    preList = "(could not list)";
  }

  let data: ToolArgs | null = null;

  const handlers: ToolHandlers = {
    read_file: async (args: ToolArgs) => {
      const p = String(args["file_path"] ?? "");
      try {
        return await workspace.readFile(p);
      } catch (e) {
        return `Error reading ${p}: ${(e as Error).message}`;
      }
    },
    list_files: async (args: ToolArgs) => String(await workspace.listFiles(String(args["directory"] ?? "."))),
    run_command: async (args: ToolArgs) => {
      const cmd = String(args["command"] ?? "");
      const timeout = Number(args["timeout"] ?? 60);
      const r = await workspace.exec(cmd, timeout);
      return JSON.stringify({ stdout: r.stdout.slice(0, 3000), stderr: r.stderr.slice(0, 3000), returncode: r.returncode });
    },
    complete_verify: async (args: ToolArgs) => {
      data = args;
      return "Verification recorded.";
    },
  };

  const feedbackBlob = formatBlob({
    plan_feedback: state.plan_feedback ?? "",
    orchestrator_feedback: state.orchestrator_feedback ?? "",
    code_feedback: (state as unknown as { code_feedback?: string }).code_feedback ?? "",
  }, "FEEDBACK");

  const userMessage =
    `PAPER: https://arxiv.org/abs/${state.arxiv_id ?? ""}\n\n` +
    `READ (initial signals + additional queries):\n${readBlob}\n\n` +
    `PLAN (deltas + intended proof + file list + additional-query usage):\n${planBlob}\n\n` +
    `POST-PLAN SUGGESTIONS (feedback provided after plan was drafted, must also be persisted):\n${feedbackBlob}\n\n` +
    `WORKSPACE (${repoName}) — pre-list:\n${preList}\n\n` +
    `Verify that every plan delta, every initial/additional-query signal, AND every post-plan suggestion is persisted in the workspace files.`;

  const engine: EngineType = state.engine ?? "trueforge";
  const result = await runAgentTurn({
    agentName: "VERIFY",
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    userMessage,
    tools: VERIFY_TOOLS,
    toolHandlers: handlers,
    jobUuid,
    agentEnum: "VERIFY",
    engine,
  });
  data = result.structured ?? data;

  if (!data) {
    step(jobUuid, "VERIFY", "no-output", { tool: "verify", conclusion: "verify produced no structured output" });
    return {
      verify: {
        plan_signals_covered: [],
        missing_signals: ["verify agent did not call complete_verify"],
        initial_queries_covered: [],
        files_verified: [],
        files_missing: [],
        checks_passed: false,
        ready: false,
        output_query: "verify produced nothing",
      },
      runs,
    };
  }

  const d = data as Record<string, unknown>;
  const verify: VerifyOutput = {
    plan_signals_covered: (d["plan_signals_covered"] as string[]) ?? [],
    missing_signals: (d["missing_signals"] as string[]) ?? [],
    initial_queries_covered: (d["initial_queries_covered"] as string[]) ?? [],
    files_verified: (d["files_verified"] as string[]) ?? [],
    files_missing: (d["files_missing"] as string[]) ?? [],
    checks_passed: Boolean(d["checks_passed"]),
    ready: true,
    output_query: String(d["output_query"] ?? (d["checks_passed"] ? "verify passed" : "verify failed")),
  };

  step(jobUuid, "VERIFY", verify.checks_passed ? "passed" : "failed", {
    tool: "verify",
    conclusion: verify.output_query ?? "",
    output_query: `covered: ${verify.plan_signals_covered?.length ?? 0} plan, ${verify.initial_queries_covered?.length ?? 0} initial; missing: ${verify.missing_signals?.length ?? 0}`,
  });

  return { verify, runs };
}
