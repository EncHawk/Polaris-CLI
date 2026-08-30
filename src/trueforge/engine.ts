/**
 * TrueForgeEngine — runs a polaris agent as a trueForge turn (inline AgentSpec)
 * and folds the SDK event stream into our trace bus. The model's ReAct loop,
 * streaming, sandbox (for CODE), and MCP tool routing are handled by trueForge;
 * we extract the agent's structured output from the completion tool call.
 */
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import type { AgentName } from "../state.ts";
import { emit, step } from "../pipeline/trace.ts";
import { COMPLETION_TOOL } from "../agents/types.ts";
import { getSettings } from "../config/settings.ts";
import { polarisModelFqn, POLARIS_MCP_NAME } from "./agents.ts";

export interface TrueForgeTurnParams {
  agentName: string;
  systemPrompt: string;
  userMessage: string;
  jobUuid: string;
  agentEnum: AgentName;
  conversationHistory?: TrueForgeApi.TurnInputItem[];
}

export interface TrueForgeTurnResult {
  text: string;
  structured: Record<string, unknown> | null;
  status: string;
  /**
   * Files the agent created in the trueForge sandbox (from the assistant's
   * `sandbox_artifacts` block), downloaded back so the caller can bridge them
   * into the pipeline workspace. Text files carry `contents`; binary
   * artifacts (images, checkpoints, archives, data) carry raw `bytes` so they
   * aren't corrupted by a lossy UTF-8 round-trip.
   */
  sandboxFiles?: Array<{ path: string; contents: string; bytes?: Uint8Array }>;
  /**
   * Set when the sandbox bridge is incomplete (artifacts beyond the cap, or
   * skipped/failed downloads) so the caller can fail the run instead of
   * publishing a partial project as a success.
   */
  sandboxIncomplete?: string;
}

/** Max sandbox files bridged per turn / max bytes per file. */
const MAX_SANDBOX_FILES = 100;
const MAX_SANDBOX_FILE_BYTES = 2 * 1024 * 1024;
const SANDBOX_SKIP_DIRS = [".git", "node_modules", ".venv", "__pycache__", "dist", "build"];

/**
 * Extract sandbox file paths from the assistant's `sandbox_artifacts` content
 * block. The block lists files as markdown links: `[name](/absolute/path)`.
 * Returns the absolute sandbox paths (as the download API expects them).
 * (The part type isn't in the SDK's public TS surface, so parse defensively.)
 */
export function extractSandboxPaths(content: unknown): string[] {
  const parts = Array.isArray(content) ? content : [];
  const paths: string[] = [];
  for (const part of parts) {
    const p = part as { type?: string; content?: unknown };
    if (p?.type !== "sandbox_artifacts" || typeof p.content !== "string") continue;
    for (const m of p.content.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const raw = m[2]!.trim();
      if (!raw.startsWith("/") || raw.startsWith("/..")) continue;
      if (raw.slice(1).split("/").some((seg) => SANDBOX_SKIP_DIRS.includes(seg))) continue;
      paths.push(raw);
    }
  }
  return [...new Set(paths)];
}

/**
 * Map absolute sandbox paths to project-relative paths. trueForge reports
 * absolute paths (e.g. `/workspace/train.py`); when every artifact sits under
 * one shared leading directory that directory is the sandbox working root —
 * not part of the project — so it's stripped, and files land at their
 * project-relative locations (`train.py`) instead of under an unwanted
 * `workspace/` directory in the published repo.
 */
export function stripSandboxRoot(absPaths: string[]): string[] {
  const rels = absPaths.map((p) => p.replace(/^\/+/, ""));
  if (rels.length > 0 && rels.every((p) => p.includes("/"))) {
    const root = rels[0]!.split("/")[0]!;
    if (root && rels.every((p) => p.startsWith(root + "/"))) {
      return rels.map((p) => p.slice(root.length + 1));
    }
  }
  return rels;
}

export async function runTrueForgeAgentTurn(
  client: TrueForge,
  p: TrueForgeTurnParams,
): Promise<TrueForgeTurnResult> {
  const s = getSettings();
  const completionTool = COMPLETION_TOOL[p.agentName.toUpperCase()];
  const isCode = p.agentName.toUpperCase() === "CODE";

  const spec: TrueForgeApi.AgentSpec = {
    model: { name: polarisModelFqn() },
    instructions: p.systemPrompt,
    mcpServers: [{ name: POLARIS_MCP_NAME, preload: true, enableTools: ["@all"] }],
    config: {
      iterationLimit: Math.max(s.AGENT_MAX_STEPS * 4, 16),
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: false },
      ...(isCode ? { sandbox: { enabled: true } } : {}),
    },
  };

  const { data: session } = await client.sessions.create({ agent: { spec } });

  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const input: TrueForgeApi.TurnInputItem[] = [
    ...(p.conversationHistory ?? []),
    { type: "user.message", content: p.userMessage },
  ];
  const stream = await client.sessions.createTurnStream(session.id, { input });

  let lastText = "";
  let status = "running";
  let turnId = "";
  const sandboxPaths = new Set<string>();

  for await (const { data: event } of stream.withMetadata()) {
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
      if (event.type === "model.message.delta" && event.content) {
        emit(p.jobUuid, p.agentEnum, "STEP", {
          step: "thinking",
          conclusion: event.content.slice(0, 200),
        });
      }
      continue;
    }
    events.set(event.id, event);

    switch (event.type) {
      case "turn.created":
        turnId = event.turnId;
        step(p.jobUuid, p.agentEnum, "turn-created", { tool: "trueforge" });
        break;
      case "mcp.initialize":
        step(p.jobUuid, p.agentEnum, "mcp-init", {
          tool: "trueforge:mcp",
          conclusion: (event.mcpServers ?? []).map((m) => m.name).join(", "),
        });
        break;
      case "model.message":
        if (event.content && typeof event.content === "string") lastText = event.content;
        for (const path of extractSandboxPaths(event.content)) sandboxPaths.add(path);
        if (event.toolCalls?.length) {
          for (const tc of event.toolCalls) {
            step(p.jobUuid, p.agentEnum, `tool-call:${tc.toolInfo.name}`, {
              tool: tc.toolInfo.name,
              output_query: `[${p.agentName}] -> ${tc.toolInfo.name}`,
            });
          }
        }
        break;
      case "tool.response":
        step(p.jobUuid, p.agentEnum, `tool-result:${event.toolCallId}`, {
          tool: "mcp",
          conclusion: (event.content ?? "").slice(0, 300),
        });
        break;
      case "tool.approval_required":
        step(p.jobUuid, p.agentEnum, "approval-required", { tool: "trueforge:approval" });
        break;
      case "tool.response_required":
        step(p.jobUuid, p.agentEnum, "question-required", { tool: "trueforge:question" });
        break;
      case "sandbox.created":
        step(p.jobUuid, p.agentEnum, "sandbox-created", { tool: "trueforge:sandbox" });
        break;
      case "thread.created":
        step(p.jobUuid, p.agentEnum, "subagent-start", { conclusion: event.title });
        break;
      case "thread.done":
        step(p.jobUuid, p.agentEnum, "subagent-done", { conclusion: event.title });
        break;
      case "turn.done":
        status = event.state.status;
        if (status === "done") {
          const done = event.state as TrueForgeApi.TurnStateDone;
          if (done.output?.type === "model.message") {
            if (typeof done.output.content === "string") lastText = done.output.content;
            for (const path of extractSandboxPaths(done.output.content)) sandboxPaths.add(path);
          }
        }
        step(p.jobUuid, p.agentEnum, "completed", {
          conclusion: `trueforge turn ${status}`,
          output_query: `[${p.agentName}] finished`,
        });
        break;
      default:
        break;
    }
  }

  // Extract structured output from the completion tool call (merged event).
  let structured: Record<string, unknown> | null = null;
  if (completionTool) {
    for (const ev of events.values()) {
      if (ev.type !== "model.message") continue;
      const call = ev.toolCalls?.find((tc) => tc.toolInfo.name === completionTool);
      if (call) {
        try {
          structured = JSON.parse(call.function.arguments || "{}");
        } catch {
          structured = null;
        }
        break;
      }
    }
  }

  // Bridge sandbox output back into the pipeline: download every artifact the
  // CODE agent created in the trueForge sandbox so the caller can persist and
  // publish it. Without this, files stay stranded in the sandbox and the run
  // reports "code produced no output". Downloads use the absolute sandbox
  // paths (as the API requires); the workspace gets project-relative paths.
  // Binary artifacts keep their raw bytes; a partial bridge is surfaced via
  // `sandboxIncomplete` instead of being published as a complete project.
  const sandboxFiles: Array<{ path: string; contents: string; bytes?: Uint8Array }> = [];
  let bridgeMissing = 0;
  const missingPaths: string[] = [];
  if (sandboxPaths.size > 0 && turnId) {
    const all = [...sandboxPaths];
    const originals = all.slice(0, MAX_SANDBOX_FILES);
    const projectPaths = stripSandboxRoot(originals);
    for (let i = 0; i < originals.length; i++) {
      const absPath = originals[i]!;
      const projectPath = projectPaths[i]!;
      try {
        const resp = await client.sessions.downloadSandboxFile(session.id, turnId, { path: absPath });
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > MAX_SANDBOX_FILE_BYTES) {
          bridgeMissing++;
          missingPaths.push(projectPath);
          step(p.jobUuid, p.agentEnum, "sandbox-bridge-skip", {
            tool: "trueforge:sandbox",
            conclusion: `skipped ${projectPath} (${buf.byteLength} bytes > ${MAX_SANDBOX_FILE_BYTES})`,
          });
          continue;
        }
        let contents = "";
        let bytes: Uint8Array | undefined;
        try {
          contents = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch {
          // Not valid UTF-8 → binary artifact; keep raw bytes.
          bytes = new Uint8Array(buf);
        }
        sandboxFiles.push(bytes ? { path: projectPath, contents: "", bytes } : { path: projectPath, contents });
      } catch (e) {
        bridgeMissing++;
        missingPaths.push(projectPath);
        step(p.jobUuid, p.agentEnum, "sandbox-bridge-skip", {
          tool: "trueforge:sandbox",
          conclusion: `failed to download ${projectPath}: ${(e as Error).message}`,
        });
      }
    }
    if (sandboxFiles.length > 0) {
      step(p.jobUuid, p.agentEnum, "sandbox-bridged", {
        tool: "trueforge:sandbox",
        conclusion: `downloaded ${sandboxFiles.length} file(s) into the pipeline workspace`,
        output_query: sandboxFiles.map((f) => f.path).join(", ").slice(0, 300),
      });
    }
  }
  let sandboxIncomplete: string | undefined;
  if (sandboxPaths.size > 0) {
    const total = sandboxPaths.size;
    if (total > MAX_SANDBOX_FILES || bridgeMissing > 0) {
      sandboxIncomplete =
        `sandbox bridge incomplete: bridged ${sandboxFiles.length} of ${total} artifacts` +
        (total > MAX_SANDBOX_FILES ? ` (capped at ${MAX_SANDBOX_FILES})` : "") +
        (bridgeMissing > 0 ? ` — missing: ${missingPaths.slice(0, 10).join(", ")}` : "");
      step(p.jobUuid, p.agentEnum, "sandbox-bridge-incomplete", {
        tool: "trueforge:sandbox",
        conclusion: sandboxIncomplete,
      });
    }
  }

  return { text: lastText, structured, status, sandboxFiles, sandboxIncomplete };
}
