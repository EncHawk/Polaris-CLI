/**
 * Orchestrator gate — port of worker/agents/orchestrator.py.
 *
 * After each agent the orchestrator inspects that agent's structured output and
 * judges whether it's good enough to advance. Be honest and conservative:
 * missing fields, empty lists, or vague answers => loop (up to MAX_GATE_RETRIES).
 */
import type { WorkerState, AgentName } from "../state.ts";
import { getSettings } from "../config/settings.ts";
import { step } from "../pipeline/trace.ts";
import { chatCompletion } from "../agents_util/llm.ts";
import type { ToolDef } from "../agents/types.ts";

const ORCH_SYSTEM_PROMPT = `You are the ORCHESTRATOR for an automated paper-reproduction pipeline.
One upstream agent has just finished its run.  Decide if its structured output is
good enough to advance to the next agent.  Be honest and conservative: missing
fields, empty lists where there should be claims, or vague answers => loop.
Return:
  - pass_to_next : bool, true => advance, false => rerun the just-finished agent
  - reason       : short justification
  - output_query : one-sentence note for the next iteration (if looped)
Doing better than perfectly-vague inputs is enough to start; don't nitpick.`;

const VERDICT_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "record_verdict",
    description: "Record your gate verdict for the agent that just finished.",
    parameters: {
      type: "object",
      properties: {
        pass_to_next: { type: "boolean", description: "true => advance, false => rerun" },
        reason: { type: "string", description: "Short justification" },
        output_query: { type: "string", description: "One-sentence note for the next iteration if looped" },
      },
      required: ["pass_to_next", "reason"],
    },
  },
};

interface Verdict {
  pass_to_next: boolean;
  reason: string;
  output_query: string;
}

const AGENT_STATE_FIELD: Record<string, keyof WorkerState> = {
  READ: "read",
  RESEARCH: "research",
  PLAN: "plan",
  CODE: "code",
};

/** Returns [passToNext, feedbackMessage]. */
export async function verify(jobUuid: string, agentName: string, agentOutput: unknown): Promise<[boolean, string]> {
  if (!agentOutput) return [false, "agent produced no output"];
  const s = getSettings();
  const model = s.modelFor("ORCHESTRATOR");
  try {
    const res = await chatCompletion({
      model,
      temperature: 0,
      maxTokens: 1024,
      tools: [VERDICT_TOOL],
      toolChoice: { type: "function", function: { name: "record_verdict" } },
      messages: [
        { role: "system", content: ORCH_SYSTEM_PROMPT },
        {
          role: "user",
          content: `AGENT just finished: ${agentName}\nITS OUTPUT:\n${JSON.stringify(agentOutput).slice(0, 12000)}\nVERIFY against its exit criteria.`,
        },
      ],
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return [true, ""];
    const v = JSON.parse(call.function.arguments || "{}") as Partial<Verdict>;
    const passToNext = Boolean(v.pass_to_next);
    const feedback = v.output_query || v.reason || "";
    step(jobUuid, "ORCHESTRATOR", "verify", {
      tool: "llm:BYOK(OpenAI-compatible)",
      conclusion: `${passToNext ? "pass" : "loop"}: ${v.reason ?? ""}`,
      output_query: feedback,
    });
    return [passToNext, feedback];
  } catch (e) {
    step(jobUuid, "ORCHESTRATOR", "verify-error", {
      tool: "llm:BYOK(OpenAI-compatible)",
      conclusion: `verifier failed: ${(e as Error).message} -> advancing`,
    });
    return [true, ""];
  }
}

/** Reads the last-staged agent's output from state and runs verify(). */
export async function orchesgate(state: WorkerState, agentName: string): Promise<boolean> {
  const jobUuid = state.job_uuid;
  const field = AGENT_STATE_FIELD[agentName];
  const out = field ? (state[field] as unknown) : undefined;
  if (!out) {
    state.orchestrator_feedback = `The ${agentName} agent produced no output. Rerun with more thorough analysis.`;
    step(jobUuid, "ORCHESTRATOR", "verify-skipped", {
      tool: "state",
      conclusion: `${agentName} produced no output; retrying once`,
    });
    return false;
  }
  const [passed, feedback] = await verify(jobUuid, agentName, out);
  if (feedback) state.orchestrator_feedback = feedback;
  else delete state.orchestrator_feedback;
  return passed;
}
