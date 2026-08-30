import type { ToolDef, ToolArgs, ToolHandlers, ChatMessage } from "./types.ts";
import type { WorkerState, CodeOutput, CodeFile, RunLog } from "../state.ts";
import { markAgentRun } from "../state.ts";
import { status, step, output } from "../pipeline/trace.ts";
import { runAgentTurn, type EngineType } from "../agents_util/engine.ts";
import { chatCompletion } from "../agents_util/llm.ts";
import { getSettings } from "../config/settings.ts";
import { Workspace, sanitizeRepoName } from "../tools/workspace.ts";
import { saveCodeCheckpoint, loadLatestCheckpoint, deleteCheckpoints } from "../agents_util/checkpoint.ts";
import { defaultRepoName, extractTitle } from "../tools/upload.ts";

export const CODE_SYSTEM_PROMPT = `You are the CODE agent for an automated paper-reproduction pipeline.
Implement the paper's claim in PyTorch (or raw Python where the paper specifies).

You write files directly to a project directory on the user's filesystem. Python and common ML libraries are available.

Rules:
1. Implement files ONE AT A TIME following the plan order.
2. Each file does ONE thing (single responsibility principle).
3. After writing files, run the code to verify it works.
4. Read error logs carefully and fix before moving on.
5. Use pure PyTorch unless the paper uses something specific.
6. You MAY use HuggingFace to load and use REAL model weights. Prefer libraries like \`transformers\`, \`TRL\`, or \`pipelines\` (e.g. \`AutoModel\`, \`AutoModelForCausalLM\`, \`AutoTokenizer\`, \`pipeline\`, \`trl.SFTTrainer\`, \`PEFT\` adapters) whenever the reproduction needs actual pre-trained weights or standard training/eval utilities. Write code that calls these libraries to download and use real weights at runtime.
7. Do NOT run pip installs or apt installs. You are only writing code — installation happens elsewhere.
8. When all files are implemented and working, call mark_implementation_complete.

Available tools:
- write_file: Write a file to the project directory (provide file_path and content)
- read_file: Read a file from the project directory
- run_command: Run a shell command in the project directory (provide command, optional timeout)
- list_files: List files in the workspace workspace (optional directory filter)
- mark_implementation_complete: Call this when the implementation is done and working

Start by understanding the plan, then implement files one by one.`;

/**
 * Appended to the CODE system prompt when the turn runs on the trueForge
 * engine: the local write_file/run_command tools do not exist there, so the
 * agent builds inside the trueForge sandbox instead and the pipeline bridges
 * the sandbox artifacts back into the workspace.
 */
export const CODE_TRUEFORGE_ADDENDUM = `

EXECUTION ENVIRONMENT (trueForge sandbox):
You are running inside a trueForge sandbox, not the local polaris workspace. Do NOT call write_file, read_file, run_command, or list_files — they are not available here. Instead:
1. Use the sandbox's built-in file and command tools to create each project file and run commands to verify they work.
2. Every file you create in the sandbox is automatically downloaded into the user's local project directory when you finish. Polaris does not publish to GitHub.
3. When all files are implemented and working, call mark_implementation_complete with files_written listing every file you created (relative paths).`;

export const CODE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file to the workspace workspace. Creates parent directories automatically.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path relative to workspace root" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace workspace.",
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
      name: "list_files",
      description: "List files in the workspace workspace directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory to list (default: root)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_implementation_complete",
      description: "Call this when the implementation is fully done and working. Provide a summary of what was built.",
      parameters: {
        type: "object",
        properties: {
          files_written: {
            type: "array",
            items: { type: "string" },
            description: "List of all files written",
          },
          summary: { type: "string", description: "What was implemented" },
          test_results: { type: "string", description: "Results of running the test harness" },
          caveats: { type: "string", description: "What couldn't be fully implemented and why" },
        },
        required: ["files_written", "summary"],
      },
    },
  },
];

async function generateReadme(arxivId: string, repoName: string, files: CodeFile[]): Promise<string> {
  const s = getSettings();
  try {
    const res = await chatCompletion({
      model: s.modelFor("CODE"),
      temperature: 0.3,
      maxTokens: 2048,
      messages: [
        {
          role: "system",
            content: "You are a technical writer. Write a concise, useful README.md for a local project that reproduces a research paper.",
        },
        {
          role: "user",
          content:
            `Paper: https://arxiv.org/abs/${arxivId}\n` +
            `Repo: ${repoName}\n` +
            `Files:\n${files.map((f) => `- ${f.path}`).join("\n")}\n\n` +
            `Output only the README markdown.`,
        },
      ],
    });
    const content = res.choices?.[0]?.message?.content;
    if (content) return content.trim();
  } catch {
    /* fall through to static readme */
  }
  return `# ${repoName}\n\nPolaris AI reproduction of [arXiv:${arxivId}](https://arxiv.org/abs/${arxivId}).\n\nSee the source files in this repository.\n`;
}

export async function runCode(state: WorkerState): Promise<Partial<WorkerState>> {
  const jobUuid = state.job_uuid;
  const runs = markAgentRun(state, "CODE");
  status(jobUuid, "coding");
  const s = getSettings();
  const userId = state.user_id ?? "";
  const paperId = state.paper_id ?? "";

  const plan = state.plan ?? {};
  const read = state.read ?? {};
  const planBlob = JSON.stringify(plan, null, 2).slice(0, 8000);
  const readBlob = JSON.stringify(
    { aim: read.aim, novel_approach: read.novel_approach, numbers: read.numbers },
    null, 2,
  ).slice(0, 4000);

  // One canonical local workspace name, sanitized up front. Papers without an arXiv id derive
  // a stable title slug (or a unique job-derived name) instead of all sharing
  // one "paper-unknown" workspace.
  const repoName = sanitizeRepoName(
    state.repo_name || defaultRepoName(state.arxiv_id ?? "", extractTitle(state.markdown ?? ""), jobUuid),
  );
  const executionModeRaw = state.execution_mode ?? "create";
  const executionMode = (["create", "modify", "run"] as const).includes(
    executionModeRaw as "create" | "modify" | "run",
  )
    ? (executionModeRaw as "create" | "modify" | "run")
    : "create";
  const existing = !!state.repo_exists || executionMode === "modify" || executionMode === "run";
  const engine: EngineType = state.engine ?? "trueforge";
  const workspace = await Workspace.create(repoName, state.output_dir, existing ? "modify" : executionMode);
  const accumulatedLogs: RunLog[] = [];

  if (executionMode === "run") {
    const runResult = await workspace.exec("python reproduce.py");
    step(jobUuid, "CODE", "run-existing-repo", {
      tool: "workspace",
      conclusion: `rc=${runResult.returncode} ${runResult.stderr.slice(0, 160) || runResult.stdout.slice(0, 160)}`,
      output_query: "python reproduce.py",
    });
    output(jobUuid, "CODE", `existing project run rc=${runResult.returncode}`, workspace.workdir);
    return {
      code: {
        files: [],
        run_logs: [{ step: "run-existing", stdout: runResult.stdout.slice(0, 3000), stderr: runResult.stderr.slice(0, 3000) }],
        notes: "Ran the existing repository without modifying it.",
        ready: runResult.returncode === 0,
        output_query: workspace.workdir,
        repo_name: repoName,
        workspace_path: workspace.workdir,
      } as CodeOutput,
      runs,
    };
  }

  const checkpoint = loadLatestCheckpoint(jobUuid);
  let checkpointContext = "";
  if (checkpoint) {
    for (const [path, content] of Object.entries(checkpoint)) {
      await workspace.writeFile(path, content);
      step(jobUuid, "CODE", "checkpoint-restore", {
        tool: "checkpoint",
        conclusion: `restored ${path} from checkpoint`,
      });
    }
    checkpointContext =
      "\n\nAlready implemented files from previous checkpoint:\n" + JSON.stringify(checkpoint, null, 2).slice(0, 4000);
  }

  let data: ToolArgs | null = null;
  const codeFiles: CodeFile[] = [];

  const handlers: ToolHandlers = {
    write_file: async (args: ToolArgs) => {
      const path = String(args["file_path"] ?? "");
      const content = String(args["content"] ?? "");
      try {
        await workspace.writeFile(path, content);
      } catch (e) {
        return `Error writing ${path}: ${(e as Error).message}`;
      }
      codeFiles.push({ path, contents: content });
      const allFiles: Record<string, string> = {};
      for (const f of codeFiles) allFiles[f.path] = f.contents;
      saveCodeCheckpoint(userId, paperId, jobUuid, allFiles);
      return `Written ${path}`;
    },
    read_file: async (args: ToolArgs) => {
      const path = String(args["file_path"] ?? "");
      try {
        return await workspace.readFile(path);
      } catch (e) {
        return `Error reading ${path}: ${(e as Error).message}`;
      }
    },
    run_command: async (args: ToolArgs) => {
      const cmd = String(args["command"] ?? "");
      const timeout = Number(args["timeout"] ?? 120);
      const r = await workspace.exec(cmd, timeout);
      const log: RunLog = {
        step: `run-${accumulatedLogs.length + 1}`,
        stdout: r.stdout.slice(0, 3000),
        stderr: r.stderr.slice(0, 3000),
      };
      accumulatedLogs.push(log);
      return JSON.stringify({ stdout: r.stdout.slice(0, 3000), stderr: r.stderr.slice(0, 3000), returncode: r.returncode });
    },
    list_files: async (args: ToolArgs) => {
      const directory = String(args["directory"] ?? ".");
      return await workspace.listFiles(directory);
    },
    mark_implementation_complete: async (args: ToolArgs) => {
      data = args;
      return "Implementation marked as complete.";
    },
  };

  const userMessage =
    `ARXIV PAPER: https://arxiv.org/abs/${state.arxiv_id ?? ""}\n\n` +
    `PLAN:\n${planBlob}\n\n` +
    `READ (context):\n${readBlob}` +
    `${checkpointContext}`;

  const conversationHistory: ChatMessage[] = [];
  if (state.orchestrator_feedback) {
    conversationHistory.push({
      role: "user",
      content: `ORCHESTRATOR FEEDBACK on your previous run:\n${state.orchestrator_feedback}\n\nFix the issues and call mark_implementation_complete when done.`,
    });
  }

  const result = await runAgentTurn({
    agentName: "CODE",
    systemPrompt: CODE_SYSTEM_PROMPT + (engine === "trueforge" ? CODE_TRUEFORGE_ADDENDUM : ""),
    userMessage,
    tools: CODE_TOOLS,
    toolHandlers: handlers,
    jobUuid,
    agentEnum: "CODE",
    maxTokens: s.AGENT_MAX_STEPS * 8192,
    conversationHistory,
    engine,
  });
  data = result.structured;

  // trueForge engine: bridge the sandbox artifacts into the pipeline workspace
  // so the files are persisted and checkpointed exactly like
  // locally-written files. Binary artifacts keep their raw bytes (no lossy
  // UTF-8 round-trip); only text files go into the JSON checkpoint.
  for (const f of result.sandboxFiles ?? []) {
    try {
      await workspace.writeFile(f.path, f.bytes ?? f.contents);
      if (!codeFiles.some((cf) => cf.path === f.path)) {
        codeFiles.push({ path: f.path, contents: f.bytes ? "" : f.contents });
      }
      if (!f.bytes) {
        const allFiles: Record<string, string> = {};
        for (const cf of codeFiles) if (cf.contents) allFiles[cf.path] = cf.contents;
        saveCodeCheckpoint(userId, paperId, jobUuid, allFiles);
      }
    } catch (e) {
      step(jobUuid, "CODE", "sandbox-bridge-write-failed", {
        tool: "workspace",
        conclusion: `could not write ${f.path}: ${(e as Error).message}`,
      });
    }
  }

  if (codeFiles.length > 0) {
    const paths = new Set(codeFiles.map((f) => f.path));
    if (!paths.has("README.md")) {
      const readme = await generateReadme(state.arxiv_id ?? "", repoName, codeFiles);
      await workspace.writeFile("README.md", readme);
      codeFiles.push({ path: "README.md", contents: readme });
      step(jobUuid, "CODE", "readme-injected", {
        tool: "llm:BYOK(OpenAI-compatible)",
        conclusion: "generated README.md",
        output_query: "README.md",
      });
    }
  }

  deleteCheckpoints(jobUuid);

  // A partial sandbox bridge (artifacts over the cap, or skipped/failed
  // downloads) must surface as a run failure — leaving a local project that's
  // missing required source/assets as a success would be worse than failing.
  const d = (data ?? {}) as Record<string, unknown>;
  const code: CodeOutput = {
    files: codeFiles,
    run_logs: accumulatedLogs,
    notes: String(d["summary"] ?? d["caveats"] ?? ""),
    ready: data != null && codeFiles.length > 0 && !result.sandboxIncomplete,
    output_query: String(d["summary"] ?? (result.sandboxIncomplete ?? "code produced output")),
    repo_name: repoName,
    workspace_path: workspace.workdir,
  };
  return { code, runs };
}
