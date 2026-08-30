/**
 * Engine dispatcher — Polaris is **forced to use TrueForge**. The local BYOK
 * ReAct loop (`loop.ts`) is retained only for reference/tests; all production
 * runs are routed through the TrueForge harness (`trueforge/engine.ts`).
 * `parseEngine` still accepts "local" as an alias for backward-compat but
 * always resolves to "trueforge".
 */
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { AgentName } from "../state.ts";
import { runAgenticCall } from "./loop.ts";
import { runTrueForgeAgentTurn } from "../trueforge/engine.ts";
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { COMPLETION_TOOL, type ChatMessage, type ToolArgs, type ToolDef, type ToolHandlers } from "../agents/types.ts";

export type EngineType = "trueforge";

/**
 * Parse an engine selector. Polaris is TrueForge-only: any value (including
 * empty / "local") resolves to "trueforge". Only truly unknown values throw
 * so typos are still caught.
 */
export function parseEngine(value: unknown): EngineType {
  if (value == null || value === "") return "trueforge";
  const v = String(value).trim().toLowerCase();
  if (v === "trueforge" || v === "local") return "trueforge";
  throw new Error(`Invalid engine "${String(value)}" — expected "trueforge" (local is aliased to TrueForge)`);
}

export interface AgentTurnParams {
  agentName: string;
  systemPrompt: string;
  userMessage: string;
  tools: ToolDef[];
  toolHandlers: ToolHandlers;
  jobUuid: string;
  agentEnum: AgentName;
  model?: string;
  maxTokens?: number;
  conversationHistory?: ChatMessage[];
  maxIterations?: number;
  engine?: EngineType;
}

export interface AgentTurnResult {
  text: string;
  structured: ToolArgs | null;
  /**
   * Files the engine produced out-of-band (trueForge sandbox artifacts for the
   * CODE agent). The caller bridges them into the pipeline workspace. Text
   * files carry `contents`; binary artifacts carry raw `bytes`.
   */
  sandboxFiles?: Array<{ path: string; contents: string; bytes?: Uint8Array }>;
  /** Set when the out-of-band bridge is incomplete (partial project). */
  sandboxIncomplete?: string;
}

let _tfClient: TrueForge | null = null;
function tfClient(): TrueForge {
  if (!_tfClient) _tfClient = makeTrueForgeClient();
  return _tfClient;
}

function toTfInput(history: ChatMessage[]): TrueForgeApi.TurnInputItem[] {
  const out: TrueForgeApi.TurnInputItem[] = [];
  for (const m of history) {
    if (m.role === "user" && m.content) out.push({ type: "user.message", content: m.content });
  }
  return out;
}

export async function runAgentTurn(p: AgentTurnParams): Promise<AgentTurnResult> {
  // VERIFY must run locally even when engine is trueforge: it needs to read
  // the pipeline's local workspace (Workshop bridged files), not the trueForge
  // sandbox. TrueForge's MCP + sandbox cannot execute local read_file/list_files/run_command
  // handlers, so routing VERIFY through the harness would silently drop its tools.
  if (p.agentEnum === "VERIFY" || p.agentName.toUpperCase() === "VERIFY") {
    const text = await runAgenticCall({
      agentName: p.agentName,
      systemPrompt: p.systemPrompt,
      userMessage: p.userMessage,
      tools: p.tools,
      toolHandlers: p.toolHandlers,
      jobUuid: p.jobUuid,
      agentEnum: p.agentEnum,
      model: p.model,
      maxTokens: p.maxTokens,
      conversationHistory: p.conversationHistory,
      maxIterations: p.maxIterations,
    });
    // Structured output is captured via the verify handler's side-effect (data variable in caller).
    // Return no structured here; caller falls back to handler-captured data.
    return { text, structured: null };
  }

  // Forced TrueForge: all other agent turns go through the harness. The local
  // loop is retained only for VERIFY and unit-test reference.
  const completionTool = COMPLETION_TOOL[p.agentName.toUpperCase()];

  // Always route through TrueForge harness (local is aliased)
  const r = await runTrueForgeAgentTurn(tfClient(), {
    agentName: p.agentName,
    systemPrompt: p.systemPrompt,
    userMessage: p.userMessage,
    jobUuid: p.jobUuid,
    agentEnum: p.agentEnum,
    conversationHistory: toTfInput(p.conversationHistory ?? []),
  });
  return {
    text: r.text,
    structured: r.structured as ToolArgs | null,
    sandboxFiles: r.sandboxFiles,
    sandboxIncomplete: r.sandboxIncomplete,
  };
}
