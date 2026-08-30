/**
 * Engine dispatcher — one entry point per agent turn that routes to either:
 *   - the local BYOK ReAct loop (`loop.ts`), or
 *   - the trueForge harness (`engine.ts`) when `engine === "trueforge"`.
 *
 * Both paths return a normalized `{ text, structured }` so the agents don't care
 * which engine ran. For the local engine we intercept the completion tool call
 * to capture the structured args (which agents previously captured via a
 * closure); for trueForge the structured output comes back from the SDK stream.
 */
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { AgentName } from "../state.ts";
import { runAgenticCall } from "./loop.ts";
import { runTrueForgeAgentTurn } from "../trueforge/engine.ts";
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { COMPLETION_TOOL, type ChatMessage, type ToolArgs, type ToolDef, type ToolHandlers } from "../agents/types.ts";

export type EngineType = "local" | "trueforge";

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
  const engine: EngineType = p.engine ?? "local";
  const completionTool = COMPLETION_TOOL[p.agentName.toUpperCase()];

  if (engine === "trueforge") {
    const r = await runTrueForgeAgentTurn(tfClient(), {
      agentName: p.agentName,
      systemPrompt: p.systemPrompt,
      userMessage: p.userMessage,
      jobUuid: p.jobUuid,
      agentEnum: p.agentEnum,
      conversationHistory: toTfInput(p.conversationHistory ?? []),
    });
    return { text: r.text, structured: r.structured as ToolArgs | null };
  }

  // Local engine — wrap the completion tool handler to capture structured args.
  let structured: ToolArgs | null = null;
  const wrapped: ToolHandlers = {};
  for (const [name, handler] of Object.entries(p.toolHandlers)) {
    if (name === completionTool) {
      wrapped[name] = async (args: ToolArgs) => {
        structured = args;
        return handler(args);
      };
    } else {
      wrapped[name] = handler;
    }
  }

  const text = await runAgenticCall({
    agentName: p.agentName,
    systemPrompt: p.systemPrompt,
    userMessage: p.userMessage,
    tools: p.tools,
    toolHandlers: wrapped,
    jobUuid: p.jobUuid,
    agentEnum: p.agentEnum,
    model: p.model,
    maxTokens: p.maxTokens,
    conversationHistory: p.conversationHistory,
    maxIterations: p.maxIterations,
  });
  return { text, structured };
}
