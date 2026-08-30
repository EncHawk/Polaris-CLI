import type { ToolDef, ToolArgs, ToolHandlers, ChatMessage } from "./types.ts";
import type { WorkerState, ReadOutput } from "../state.ts";
import { markAgentRun } from "../state.ts";
import { status } from "../pipeline/trace.ts";
import { runAgenticCall } from "../agents_util/loop.ts";
import { getSettings } from "../config/settings.ts";

export const READ_SYSTEM_PROMPT = `You are the READ agent for an automated research-paper reproduction pipeline.
Your job is to read the paper's markdown and extract a precise structured understanding.

Rules:
1. Read through the paper markdown carefully before producing any output.
2. Extract: aim, built_on, experiments/ablations, novel_approach (and whether it's codeable), numbers/improvements, and the most relevant citations (with arxiv_id if possible).
3. Be thorough — list every experiment and claim you find.
4. When you have extracted everything, call \`complete_read_result\` with your findings.

The citations you provide will feed the RESEARCH agent which fetches their implementation details. Include the arxiv_id whenever you can spot one in the text.`;

export const READ_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "complete_read_result",
      description: "Call this with your complete READ analysis of the paper. Once called, the READ phase is done.",
      parameters: {
        type: "object",
        properties: {
          aim: { type: "string", description: "What does the paper aim to solve?" },
          built_on: { type: "string", description: "Prior work / base method they built on top of" },
          experiments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                what_yielded: { type: "string" },
              },
            },
            description: "Experiments / ablation studies and what each yielded",
          },
          novel_approach: {
            type: "object",
            properties: {
              description: { type: "string", description: "The novel approach introduced" },
              codeable: { type: "boolean", description: "Whether the approach is implementable in code" },
            },
            required: ["description", "codeable"],
          },
          numbers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                value: { type: "string" },
              },
            },
            description: "Improvements (or demotions) proposed in the paper",
          },
          relevant_citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                arxiv_id: { type: "string" },
                why_relevant: { type: "string" },
              },
            },
            description: "Most relevant citations with arxiv_id if known",
          },
          output_query: { type: "string", description: "One sentence summary of what was found" },
        },
        required: ["aim", "built_on", "novel_approach", "output_query"],
      },
    },
  },
];

export async function runRead(state: WorkerState): Promise<Partial<WorkerState>> {
  const jobUuid = state.job_uuid;
  const markdown = state.markdown ?? "";
  const runs = markAgentRun(state, "READ");
  if (!markdown) return { read: {}, runs, error: "no markdown" };

  status(jobUuid, "read");

  let data: ToolArgs | null = null;
  const handlers: ToolHandlers = {
    complete_read_result: async (args: ToolArgs) => {
      data = args;
      return "Read result recorded. The READ phase is complete.";
    },
  };

  const s = getSettings();
  const userMessage = `PAPER MARKDOWN:\n\n${markdown.slice(0, 60000)}`;

  const conversationHistory: ChatMessage[] = [];
  if (state.orchestrator_feedback) {
    conversationHistory.push({
      role: "user",
      content: `ORCHESTRATOR FEEDBACK on your previous run:\n${state.orchestrator_feedback}\n\nImprove your analysis accordingly.`,
    });
  }

  await runAgenticCall({
    agentName: "READ",
    systemPrompt: READ_SYSTEM_PROMPT,
    userMessage,
    tools: READ_TOOLS,
    toolHandlers: handlers,
    jobUuid,
    agentEnum: "READ",
    maxTokens: s.AGENT_MAX_STEPS * 4096,
    conversationHistory,
  });

  if (data == null) return { read: {}, runs, error: "read produced no output" };

  const d = data as Record<string, unknown>;
  const read: ReadOutput = {
    aim: (d["aim"] as string) ?? "",
    built_on: (d["built_on"] as string) ?? "",
    experiments: (d["experiments"] as ReadOutput["experiments"]) ?? [],
    novel_approach: (d["novel_approach"] as ReadOutput["novel_approach"]) ?? {} as ReadOutput["novel_approach"],
    numbers: (d["numbers"] as ReadOutput["numbers"]) ?? [],
    relevant_citations: (d["relevant_citations"] as ReadOutput["relevant_citations"]) ?? [],
    ready: true,
    output_query: (d["output_query"] as string) ?? "",
  };
  return { read, runs };
}
