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
            lastText = (done.output.content as string) ?? lastText;
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

  return { text: lastText, structured, status };
}
