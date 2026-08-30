/**
 * Pipeline graph driver — port of worker/graph.py.
 *
 * LangGraph wiring: READ -> (gate) -> RESEARCH -> (gate) -> PLAN -> APPROVE ->
 * CODE -> (gate) -> END. We re-implement the conditional edges as an explicit
 * driver (no langgraph dependency). A too-strict orchestrator is force-advanced
 * after MAX_GATE_RETRIES or when an agent's output stops changing.
 */
import type { WorkerState, AgentName } from "../state.ts";
import { error, status, step } from "./trace.ts";
import { orchesgate } from "../agents/orchestrator.ts";
import { runRead } from "../agents/read.ts";
import { runResearch } from "../agents/research.ts";
import { runPlan } from "../agents/plan.ts";
import { runCode } from "../agents/code.ts";

const MAX_GATE_RETRIES = 2;
const END = "__end__";

function hashOutput(output: unknown): string {
  if (!output) return "";
  try {
    return JSON.stringify(output, Object.keys(output as object).sort());
  } catch {
    return JSON.stringify(output);
  }
}

function isStuckRepeat(state: WorkerState, agent: string, output: unknown): boolean {
  const prev = state._prev_agent_outputs?.[agent] ?? "";
  return !!prev && prev === hashOutput(output);
}

function recordOutputHash(state: WorkerState, agent: string, output: unknown): void {
  state._prev_agent_outputs = { ...(state._prev_agent_outputs ?? {}), [agent]: hashOutput(output) };
}

function runsOf(state: WorkerState, agent: string): number {
  return state.runs?.[agent] ?? 0;
}

function failed(state: WorkerState): void {
  const message = state.error ?? "agent stopped without producing usable output";
  error(state.job_uuid, "ORCHESTRATOR", message);
  status(state.job_uuid, "failed");
  state.status = "failed";
}

type Node = "read" | "research" | "plan" | "code" | "failed" | typeof END;

async function runNode(state: WorkerState, node: Exclude<Node, typeof END | "failed">): Promise<void> {
  step(state.job_uuid, "SYSTEM", `enter-${node}`, { tool: "graph", conclusion: node });
  let update: Partial<WorkerState>;
  switch (node) {
    case "read":
      update = await runRead(state);
      break;
    case "research":
      update = await runResearch(state);
      break;
    case "plan":
      update = await runPlan(state);
      break;
    case "code":
      update = await runCode(state);
      break;
  }
  Object.assign(state, update);
  const out = state[node as keyof WorkerState];
  state.history = [...(state.history ?? []), {
    agent: node.toUpperCase() as AgentName,
    step: node,
    conclusion: out ? "produced output" : "empty",
  }];
}

async function gateRead(state: WorkerState): Promise<Node> {
  const readOut = state.read;
  if (runsOf(state, "READ") >= MAX_GATE_RETRIES || isStuckRepeat(state, "READ", readOut)) {
    delete state.orchestrator_feedback;
    if (!state.read) return "failed";
    recordOutputHash(state, "READ", readOut);
    return "research";
  }
  const passed = await orchesgate(state, "READ");
  recordOutputHash(state, "READ", readOut);
  return passed ? "research" : "read";
}

async function gateResearch(state: WorkerState): Promise<Node> {
  const researchOut = state.research;
  if (runsOf(state, "RESEARCH") >= MAX_GATE_RETRIES || isStuckRepeat(state, "RESEARCH", researchOut)) {
    delete state.orchestrator_feedback;
    if (!researchOut || !researchOut.citations) return "failed";
    recordOutputHash(state, "RESEARCH", researchOut);
    return "plan";
  }
  const passed = await orchesgate(state, "RESEARCH");
  recordOutputHash(state, "RESEARCH", researchOut);
  return passed ? "plan" : "research";
}

async function gatePlan(state: WorkerState): Promise<Node> {
  const planOut = state.plan;
  if (!planOut) return "failed";
  if (state.approved) return "code";
  if (isStuckRepeat(state, "PLAN", planOut)) {
    recordOutputHash(state, "PLAN", planOut);
    return "code";
  }
  recordOutputHash(state, "PLAN", planOut);
  // A rejection with feedback gets one bounded re-plan; a bare rejection is terminal.
  if (state.plan_feedback && runsOf(state, "PLAN") < MAX_GATE_RETRIES) return "plan";
  return "failed";
}

async function gateCode(state: WorkerState): Promise<Node> {
  const codeOut = state.code;
  if (runsOf(state, "CODE") >= MAX_GATE_RETRIES || isStuckRepeat(state, "CODE", codeOut)) {
    delete state.orchestrator_feedback;
    if (!state.code) return "failed";
    recordOutputHash(state, "CODE", codeOut);
    return END;
  }
  const passed = await orchesgate(state, "CODE");
  recordOutputHash(state, "CODE", codeOut);
  return passed ? END : "code";
}

const GATES: Record<Exclude<Node, typeof END | "failed">, (s: WorkerState) => Promise<Node>> = {
  read: gateRead,
  research: gateResearch,
  plan: gatePlan,
  code: gateCode,
};

/** Drive the pipeline to completion and return the final state. */
export async function runGraph(initialState: WorkerState): Promise<WorkerState> {
  const state: WorkerState = { ...initialState };
  let node: Node = "read";
  let guard = 0;
  while (node !== END && guard < 200) {
    guard += 1;
    if (node === "failed") {
      failed(state);
      return state;
    }
    await runNode(state, node);
    node = await GATES[node](state);
  }
  if (guard >= 200) {
    error(state.job_uuid, "SYSTEM", "pipeline exceeded recursion limit");
    status(state.job_uuid, "failed");
    state.status = "failed";
  }
  return state;
}
