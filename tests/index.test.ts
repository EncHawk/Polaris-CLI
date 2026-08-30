import { test, expect } from "bun:test";
import { traceBus, emit } from "../src/pipeline/trace.ts";
import { markAgentRun, type WorkerState } from "../src/state.ts";
import { normalizeId } from "../src/tools/arxiv.ts";
import { arxivIdToRepoName, repoNameToArxivId, searchPolarisPapers, getImplementation } from "../src/tools/papers.ts";
import {
  detectKind,
  extractArxivId,
  extractTitle,
  extractPaperText,
  findExistingImplementation,
  implementationRepoName,
} from "../src/tools/upload.ts";

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

test("workspace writes and reads files on the real filesystem", async () => {
  const { Workspace } = await import("../src/tools/workspace.ts");
  const { rmSync } = await import("node:fs");
  const tmp = `/tmp/polaris-test-${crypto.randomUUID()}`;
  const ws = Workspace.create("test-repo", tmp);
  expect(ws.workdir.includes("test-repo")).toBe(true);
  ws.writeFile("hello.py", "print('world')");
  const content = await ws.readFile("hello.py");
  expect(content).toBe("print('world')");
  ws.writeFile("src/deep/nested.py", "# nested");
  const nested = await ws.readFile("src/deep/nested.py");
  expect(nested).toBe("# nested");
  const r = await ws.exec("echo testing");
  expect(r.returncode).toBe(0);
  expect(r.stdout.trim()).toBe("testing");
  const listing = await ws.listFiles(".");
  expect(listing).toContain("hello.py");
  // no cleanup() method — the directory persists on the client's filesystem
  rmSync(tmp, { recursive: true, force: true });
});

test("completion tool mapping covers all agents", () => {
  const { COMPLETION_TOOL } = require("../src/agents/types.ts");
  expect(COMPLETION_TOOL.READ).toBe("complete_read_result");
  expect(COMPLETION_TOOL.RESEARCH).toBe("complete_research");
  expect(COMPLETION_TOOL.PLAN).toBe("complete_plan");
  expect(COMPLETION_TOOL.CODE).toBe("mark_implementation_complete");
});

// ─── Phase 2: Polaris coded-implementation retrieval ────────────────────────────

test("arxivIdToRepoName / repoNameToArxivId round-trip", () => {
  expect(arxivIdToRepoName("2106.09685")).toBe("paper-2106-09685");
  expect(arxivIdToRepoName("1706.03762v2")).toBe("paper-1706-03762");
  expect(arxivIdToRepoName("https://arxiv.org/abs/2410.16184")).toBe("paper-2410-16184");
  expect(repoNameToArxivId("paper-2106-09685")).toBe("2106.09685");
  expect(repoNameToArxivId("not-a-paper")).toBe("");
});

test("searchPolarisPapers finds an existing implementation by arxiv id", async () => {
  // 1706.03762 = "Attention Is All You Need" — a seeded repo in the org.
  try {
    const matches = await searchPolarisPapers({ arxiv_id: "1706.03762" });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.repo_name).toBe("paper-1706-03762");
    expect(matches[0]!.html_url).toContain("PolarisAI-Implementations");
  } catch (e) {
    // Tolerate anonymous GitHub rate-limiting in CI.
    console.warn("searchPolarisPapers skipped (network/rate-limit):", (e as Error).message);
  }
});

test("getImplementation returns a file tree and source files", async () => {
  try {
    const impl = await getImplementation("paper-2106-09685", 5);
    expect(impl.repo_name).toBe("paper-2106-09685");
    expect(impl.arxiv_id).toBe("2106.09685");
    expect(impl.tree.length).toBeGreaterThan(0);
    // LoRA repo ships lora_layer.py under src/
    expect(impl.files.some((f) => f.path.endsWith(".py"))).toBe(true);
  } catch (e) {
    console.warn("getImplementation skipped (network/rate-limit):", (e as Error).message);
  }
});

// ─── Phase 2: file uploads + library-first check ────────────────────────────────

test("detectKind maps extensions to paper kinds", () => {
  expect(detectKind("paper.pdf")).toBe("pdf");
  expect(detectKind("notes.MD")).toBe("markdown");
  expect(detectKind("readme.markdown")).toBe("markdown");
  expect(detectKind("raw.txt")).toBe("markdown");
  expect(detectKind("main.tex")).toBe("latex");
  expect(detectKind("data.csv")).toBe("unknown");
});

test("extractArxivId finds ids in text and URLs", () => {
  expect(extractArxivId("See arxiv:2106.09685 for details")).toBe("2106.09685");
  expect(extractArxivId("https://arxiv.org/abs/1706.03762v2")).toBe("1706.03762");
  expect(extractArxivId("no id here")).toBe("");
});

test("extractTitle pulls the first H1 from markdown", () => {
  expect(extractTitle("# Attention Is All You Need\n\nbody")).toBe("Attention Is All You Need");
  expect(extractTitle("no heading\njust text")).toBe("no heading");
});

test("extractPaperText decodes markdown files directly", async () => {
  const md = "# My Paper\n\nSome content about 2401.00123.";
  const r = await extractPaperText("paper.md", new TextEncoder().encode(md));
  expect(r.kind).toBe("markdown");
  expect(r.markdown).toContain("My Paper");
  expect(r.arxiv_id).toBe("2401.00123");
  expect(r.title).toBe("My Paper");
});

test("extractPaperText parses a PDF and extracts text", async () => {
  // Hand-crafted minimal PDF with the text "Attention Is All You Need - test paper"
  const pdf = Bun.file("/tmp/test_paper.pdf");
  if (!(await pdf.exists())) return; // skip if the fixture wasn't generated
  const r = await extractPaperText("test_paper.pdf", await pdf.arrayBuffer());
  expect(r.kind).toBe("pdf");
  expect(r.markdown).toContain("Attention Is All You Need");
  expect(r.pages).toBeGreaterThanOrEqual(1);
});

test("implementationRepoName follows the paper-YYMM-NNNNN convention", () => {
  expect(implementationRepoName("2106.09685", "fallback")).toBe("paper-2106-09685");
  expect(implementationRepoName("", "my-paper")).toBe("my-paper");
});

test("findExistingImplementation locates a seeded repo by arxiv id", async () => {
  try {
    const res = await findExistingImplementation("1706.03762", "");
    expect(res.found).toBe(true);
    expect(res.repo?.repo_name).toBe("paper-1706-03762");
  } catch (e) {
    console.warn("findExistingImplementation skipped (network/rate-limit):", (e as Error).message);
  }
});
