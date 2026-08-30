import { test, expect } from "bun:test";
import { traceBus, emit } from "../src/pipeline/trace.ts";
import { markAgentRun, type WorkerState } from "../src/state.ts";
import { normalizeId } from "../src/tools/arxiv.ts";

test("trace bus emits and replays history", () => {
  const job = crypto.randomUUID();
  const received: string[] = [];
  emit(job, "SYSTEM", "STEP", { step: "test", conclusion: "hello" });
  const unsub = traceBus.subscribe(job, (ev) => received.push(ev.step), 0);
  expect(received).toEqual(["test"]);
  emit(job, "READ", "STEP", { step: "thinking" });
  expect(received).toEqual(["test", "thinking"]);
  unsub();
  traceBus.clear(job);
});

test("markAgentRun increments per-agent counters", () => {
  const state: WorkerState = { job_uuid: "x", runs: {} };
  let runs = markAgentRun(state, "READ");
  expect(runs).toEqual({ READ: 1 });
  state.runs = runs;
  runs = markAgentRun(state, "READ");
  expect(runs).toEqual({ READ: 2 });
  state.runs = runs;
  runs = markAgentRun(state, "CODE");
  expect(runs).toEqual({ READ: 2, CODE: 1 });
});

test("normalizeId extracts arxiv IDs from URLs and bare strings", () => {
  expect(normalizeId("2301.12345")).toBe("2301.12345");
  expect(normalizeId("2301.12345v2")).toBe("2301.12345");
  expect(normalizeId("https://arxiv.org/abs/2403.09876")).toBe("2403.09876");
  expect(normalizeId("arxiv:2410.00123v1")).toBe("2410.00123");
});

test("approval gate awaits and resolves", async () => {
  const { approvalGate } = await import("../src/pipeline/approval.ts");
  const job = crypto.randomUUID();
  const plan = { intends_to_prove: "test", plan: ["a"], ready: true, output_query: "q" };
  const pending = approvalGate.await(job, "PLAN", plan);
  expect(approvalGate.hasPending(job)).toEqual(plan);
  approvalGate.resolve(job, { approved: true, feedback: "" });
  const decision = await pending;
  expect(decision.approved).toBe(true);
  expect(approvalGate.hasPending(job)).toBeNull();
});

test("checkpoint save/load/delete round-trips locally", () => {
  const { saveCodeCheckpoint, loadLatestCheckpoint, deleteCheckpoints } = require("../src/agents_util/checkpoint.ts");
  const job = `test-${crypto.randomUUID()}`;
  saveCodeCheckpoint("user", "paper", job, { "main.py": "print('hi')", "utils.py": "# helpers" });
  const loaded = loadLatestCheckpoint(job);
  expect(loaded).toEqual({ "main.py": "print('hi')", "utils.py": "# helpers" });
  deleteCheckpoints(job);
  expect(loadLatestCheckpoint(job)).toBeNull();
});

test("sandbox local fallback writes and reads files", async () => {
  const { Sandbox } = await import("../src/tools/sandbox.ts");
  const sbx = Sandbox.create("test-job");
  expect(sbx.isReal).toBe(false);
  sbx.writeFile("hello.py", "print('world')");
  const content = await sbx.readFile("hello.py");
  expect(content).toBe("print('world')");
  const r = await sbx.exec("echo testing");
  expect(r.returncode).toBe(0);
  expect(r.stdout.trim()).toBe("testing");
  sbx.cleanup();
});

test("completion tool mapping covers all agents", () => {
  const { COMPLETION_TOOL } = require("../src/agents/types.ts");
  expect(COMPLETION_TOOL.READ).toBe("complete_read_result");
  expect(COMPLETION_TOOL.RESEARCH).toBe("complete_research");
  expect(COMPLETION_TOOL.PLAN).toBe("complete_plan");
  expect(COMPLETION_TOOL.CODE).toBe("mark_implementation_complete");
});
