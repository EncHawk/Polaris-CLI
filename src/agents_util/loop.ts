/**
 * ReAct agentic loop — port of worker/agents_util/agentic_loop.py.
 *
 * One long-horizon call per agent. The model internally loops
 * (think → tool_call → observe → think → done); we just execute tool calls as
 * they arrive and feed results back. At max_iterations we force the completion
 * tool so an agent can never spin silently.
 */
import { getSettings } from "../config/settings.ts";
import type { AgentName } from "../state.ts";
import { emit, step } from "../pipeline/trace.ts";
import type { ChatMessage, ToolArgs, ToolDef, ToolHandlers } from "../agents/types.ts";
import { COMPLETION_TOOL } from "../agents/types.ts";
import { chatCompletionStream } from "./llm.ts";

export interface AgenticCallParams {
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
}

export async function runAgenticCall(p: AgenticCallParams): Promise<string> {
  const s = getSettings();
  const model = p.model || s.modelFor(p.agentName.toUpperCase());
  const maxIterations = p.maxIterations ?? s.AGENT_MAX_STEPS;
  const completionTool = COMPLETION_TOOL[p.agentName.toUpperCase()];

  const messages: ChatMessage[] = [{ role: "system", content: p.systemPrompt }];
  if (p.conversationHistory) messages.push(...p.conversationHistory);
  messages.push({ role: "user", content: p.userMessage });

  let iteration = 0;
  for (;;) {
    iteration += 1;
    const toolCallsThisTurn: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    let currentText = "";

    if (iteration === maxIterations) {
      messages.push({
        role: "user",
        content:
          `CRITICAL: This is your final opportunity to produce a result. ` +
          `You MUST call \`${completionTool}\` now with everything you have. ` +
          `Do NOT call any other tools. Produce your complete output immediately.`,
      });
    }

    emit(p.jobUuid, p.agentEnum, "STEP", {
      step: `thinking-iter-${iteration}`,
      output_query: `[${p.agentName}] model reasoning, iteration ${iteration}`,
    });

    for await (const chunk of chatCompletionStream({
      model,
      messages,
      tools: p.tools,
      maxTokens: p.maxTokens ?? s.AGENT_MAX_STEPS * 4096,
    })) {
      const delta = chunk.delta;
      if (!delta) continue;
      if (delta.content) currentText += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue;
          const idx = tc.index;
          while (toolCallsThisTurn.length <= idx) {
            toolCallsThisTurn.push({ id: "", type: "function", function: { name: "", arguments: "" } });
          }
          if (tc.id) toolCallsThisTurn[idx]!.id = tc.id;
          if (tc.function) {
            if (tc.function.name) toolCallsThisTurn[idx]!.function.name += tc.function.name;
            if (tc.function.arguments) toolCallsThisTurn[idx]!.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    if (toolCallsThisTurn.length === 0) {
      emit(p.jobUuid, p.agentEnum, "STEP", {
        step: "completed",
        conclusion: currentText.slice(0, 200),
        output_query: `[${p.agentName}] finished after ${iteration} iteration(s)`,
      });
      return currentText;
    }

    const hasCompletion =
      !!completionTool && toolCallsThisTurn.some((tc) => tc.function.name === completionTool);

    messages.push({
      role: "assistant",
      content: currentText || null,
      tool_calls: toolCallsThisTurn,
    });

    for (const tc of toolCallsThisTurn) {
      const toolName = tc.function.name;
      let toolArgs: ToolArgs = {};
      try {
        toolArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        toolArgs = {};
      }

      step(p.jobUuid, p.agentEnum, `tool-call:${toolName}`, {
        tool: toolName,
        output_query: `[${p.agentName}] -> ${toolName}(${Object.keys(toolArgs).join(", ")})`,
      });

      const handler = p.toolHandlers[toolName];
      let resultStr: string;
      if (handler) {
        try {
          const result = await handler(toolArgs);
          resultStr = typeof result === "string" ? result : JSON.stringify(result);
        } catch (e) {
          resultStr = `Tool error: ${(e as Error).message}`;
        }
      } else {
        resultStr = `Unknown tool: ${toolName}`;
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });

      emit(p.jobUuid, p.agentEnum, "STEP", {
        step: `tool-result:${toolName}`,
        tool: toolName,
        conclusion: resultStr.slice(0, 300),
      });
    }

    if (iteration >= maxIterations && !hasCompletion) {
      emit(p.jobUuid, p.agentEnum, "STEP", {
        step: "max-iterations-reached",
        conclusion: `Agent reached max ${maxIterations} iterations without calling ${completionTool}`,
        output_query: `[${p.agentName}] forced conclusion after ${iteration} iteration(s)`,
      });
      return currentText || `(forced conclusion after ${iteration} iterations)`;
    }
  }
}
