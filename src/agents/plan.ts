import type { ToolDef, ToolArgs, ToolHandlers, ChatMessage } from "./types.ts";
import type { WorkerState, PlanOutput, CustomKernels } from "../state.ts";
import { markAgentRun } from "../state.ts";
import { status, step } from "../pipeline/trace.ts";
import { runAgentTurn } from "../agents_util/engine.ts";
import { getSettings } from "../config/settings.ts";
import { approvalGate } from "../pipeline/approval.ts";

export const PLAN_SYSTEM_PROMPT = `You are the PLAN agent for an automated paper-reproduction pipeline.
Using the READ + RESEARCH outputs, draft a concrete plan for the CODE agent.

Your plan must include:
- intends_to_prove: what is the paper trying to show (the claim to reproduce)
- proof_method: how the paper claims to prove it (experiments / baselines)
- researched_usage: how the previously-researched cited methods are used here
- deltas_from_base: what they changed vs the base method
- custom_kernels: do they use custom CUDA kernels? if yes provide details
- plan: a todo-list of files to build (each file does one thing), PyTorch/raw-Python

Be specific and codeable. Each plan step should be a concrete file or module to implement.`;

export const PLAN_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "complete_plan",
      description: "Call this with your final plan for the CODE agent. Once called, the PLAN phase is complete.",
      parameters: {
        type: "object",
        properties: {
          intends_to_prove: { type: "string", description: "The claim the paper tries to reproduce" },
          proof_method: { type: "string", description: "How the paper claims to prove it" },
          researched_usage: { type: "string", description: "How cited methods are used in this paper" },
          deltas_from_base: {
            type: "array",
            items: { type: "string" },
            description: "Changes vs the base method",
          },
          custom_kernels: {
            type: "object",
            properties: {
              description: { type: "string" },
              details: { type: "string" },
            },
            description: "Custom CUDA kernel details if any",
          },
          plan: {
            type: "array",
            items: { type: "string" },
            description: "Ordered todo-list of files to build (each file does one thing)",
          },
          output_query: { type: "string", description: "One sentence summary of the plan" },
        },
        required: ["intends_to_prove", "proof_method", "plan", "output_query"],
      },
    },
  },
];

export async function runPlan(state: WorkerState): Promise<Partial<WorkerState>> {
  const jobUuid = state.job_uuid;
  const runs = markAgentRun(state, "PLAN");
  status(jobUuid, "plan");

  const readBlob = JSON.stringify(state.read ?? {}, null, 2).slice(0, 15000);
  const researchBlob = JSON.stringify(state.research ?? {}, null, 2).slice(0, 15000);
  const priorFeedback = String(state.plan_feedback ?? "(none)");

  let data: ToolArgs | null = null;
  const handlers: ToolHandlers = {
    complete_plan: async (args: ToolArgs) => {
      data = args;
      return "Plan recorded. The plan is ready for user approval.";
    },
  };

  const userMessage =
    `READ OUTPUT:\n${readBlob}\n\n` +
    `RESEARCH OUTPUT:\n${researchBlob}\n\n` +
    `USER FEEDBACK ON PRIOR PLAN:\n${priorFeedback}\n\n` +
    `Produce a concrete, codeable plan for implementing this paper.`;

  const conversationHistory: ChatMessage[] = [];
  if (state.orchestrator_feedback) {
    conversationHistory.push({
      role: "user",
      content: `ORCHESTRATOR FEEDBACK on your previous plan:\n${state.orchestrator_feedback}\n\nImprove your plan and call complete_plan.`,
    });
  }

  const s = getSettings();
  const turn = await runAgentTurn({
    agentName: "PLAN",
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userMessage,
    tools: PLAN_TOOLS,
    toolHandlers: handlers,
    jobUuid,
    agentEnum: "PLAN",
    maxTokens: s.AGENT_MAX_STEPS * 4096,
    conversationHistory,
    engine: (state.engine as "local" | "trueforge") ?? "local",
  });
  data = turn.structured;

  if (data == null) return { plan: {}, runs, error: "plan produced nothing" };

  const d = data as Record<string, unknown>;
  const plan: PlanOutput = {
    intends_to_prove: String(d["intends_to_prove"] ?? ""),
    proof_method: String(d["proof_method"] ?? ""),
    researched_usage: String(d["researched_usage"] ?? ""),
    deltas_from_base: (d["deltas_from_base"] as string[]) ?? [],
    custom_kernels: (d["custom_kernels"] as CustomKernels | null) ?? null,
    plan: (d["plan"] as string[]) ?? [],
    ready: true,
    output_query: String(d["output_query"] ?? ""),
  };

  status(jobUuid, "awaiting_user_approval");
  let decision;
  if (state.auto_approve) {
    step(jobUuid, "PLAN", "auto-approved", {
      tool: "/plan/approve",
      conclusion: "auto-approved (non-interactive)",
      output_query: "proceed to CODE",
    });
    decision = { approved: true, feedback: "" };
  } else {
    decision = await approvalGate.await(jobUuid, "PLAN", plan);
  }

  const result: Partial<WorkerState> = { plan, approved: decision.approved, runs };
  if (decision.feedback) result.plan_feedback = decision.feedback;
  return result;
}
