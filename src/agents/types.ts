/**
 * Shared OpenAI-format tool + message types used by the agentic loop and agents.
 */

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolDef {
  type: "function";
  function: ToolFunction;
}
export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => Promise<string> | string;
export type ToolHandlers = Record<string, ToolHandler>;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Which completion tool an agent calls to signal "done" with structured output. */
export const COMPLETION_TOOL: Record<string, string> = {
  READ: "complete_read_result",
  RESEARCH: "complete_research",
  PLAN: "complete_plan",
  CODE: "mark_implementation_complete",
};
