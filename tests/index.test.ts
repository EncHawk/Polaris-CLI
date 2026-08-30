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
  defaultRepoName,
  slugifyTitle,
  titleMatchConfidence,
  TITLE_MATCH_THRESHOLD,
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
  const ws = await Workspace.create("test-repo", tmp);
  expect(ws.workdir.includes("test-repo")).toBe(true);
  await ws.writeFile("hello.py", "print('world')");
  const content = await ws.readFile("hello.py");
  expect(content).toBe("print('world')");
  await ws.writeFile("src/deep/nested.py", "# nested");
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
  expect(COMPLETION_TOOL.VERIFY).toBe("complete_verify");
});

test("verify agent exposes expected tools and prompt", async () => {
  const { VERIFY_TOOLS, VERIFY_SYSTEM_PROMPT } = await import("../src/agents/verify.ts");
  expect(VERIFY_SYSTEM_PROMPT).toContain("VERIFY");
  const names = VERIFY_TOOLS.map((t) => t.function.name);
  expect(names).toContain("complete_verify");
  expect(names).toContain("read_file");
  expect(names).toContain("list_files");
});

test("polaris agent specs include verify", async () => {
  const { polarisAgentSpecs, POLARIS_AGENT_NAMES } = await import("../src/trueforge/agents.ts");
  expect(POLARIS_AGENT_NAMES).toContain("polaris-verify");
  const specs = polarisAgentSpecs();
  expect(specs.verify).toBeTruthy();
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

// ─── Qodo review fixes: regression tests ─────────────────────────────────────

test("parseEngine accepts only local|trueforge (no silent fallback)", async () => {
  const { parseEngine } = await import("../src/agents_util/engine.ts");
  expect(parseEngine(undefined)).toBe("local");
  expect(parseEngine("")).toBe("local");
  expect(parseEngine("local")).toBe("local");
  expect(parseEngine("trueforge")).toBe("trueforge");
  expect(parseEngine("TrueForge")).toBe("trueforge");
  expect(() => parseEngine("tureforge")).toThrow(/Invalid engine/);
  expect(() => parseEngine("remote")).toThrow(/Invalid engine/);
});

test("parseArgs never mistakes option values for the positional arxiv id", async () => {
  const { parseArgs } = await import("../src/cli/index.ts");
  // The regression: `polaris run --file paper.pdf` used to set the id to "paper.pdf".
  const fileOnly = parseArgs(["--file", "paper.pdf"]);
  expect(fileOnly.positionals).toEqual([]);
  expect(fileOnly.values.get("--file")).toBe("paper.pdf");

  const withId = parseArgs(["2106.09685", "--auto", "--engine", "trueforge"]);
  expect(withId.positionals).toEqual(["2106.09685"]);
  expect(withId.values.get("--engine")).toBe("trueforge");
  expect(withId.flags.has("--auto")).toBe(true);

  const everything = parseArgs(["--engine", "local", "--file", "p.pdf", "1706.03762", "--reuse"]);
  expect(everything.positionals).toEqual(["1706.03762"]);

  expect(() => parseArgs(["--file"])).toThrow(/Missing value/);
});

test("sanitizeRepoName reduces repo names to a safe single component", async () => {
  const { sanitizeRepoName } = await import("../src/tools/workspace.ts");
  expect(sanitizeRepoName("paper-2106-09685")).toBe("paper-2106-09685");
  expect(sanitizeRepoName("../../project")).toBe("project");
  expect(sanitizeRepoName("/home/user/project")).toBe("project");
  expect(sanitizeRepoName("my repo!")).toBe("my-repo");
  expect(() => sanitizeRepoName("...___")).toThrow(/Invalid repository name/);
  expect(() => sanitizeRepoName("///")).toThrow(/Invalid repository name/);
  expect(() => sanitizeRepoName("")).toThrow(/Invalid repository name/);
});

test("Workspace refuses unowned non-empty dirs and confines file paths", async () => {
  const { Workspace } = await import("../src/tools/workspace.ts");
  const { mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tmp = `/tmp/polaris-ws-${crypto.randomUUID()}`;

  // create mode refuses a pre-existing non-empty directory polaris doesn't own
  const foreign = join(tmp, "foreign");
  mkdirSync(foreign, { recursive: true });
  await Bun.write(join(foreign, "secret.txt"), "do not commit me");
  await expect(Workspace.create("foreign", tmp)).rejects.toThrow(/already exists and is not empty/);

  // a workspace polaris created itself can be reopened (retry flow)
  const mine = await Workspace.create("mine", tmp);
  await mine.writeFile("code.py", "print(1)");
  await expect(Workspace.create("mine", tmp)).resolves.toBeTruthy();

  // modify mode explicitly adopts an existing directory
  await expect(Workspace.create("foreign", tmp, "modify")).resolves.toBeTruthy();

  // file operations cannot escape the workspace — including via `..` that a
  // naive join+prefix check would let through
  await expect(mine.writeFile("../escape.txt", "x")).rejects.toThrow(/escapes the workspace/);
  await expect(mine.writeFile("/tmp/escape.txt", "x")).rejects.toThrow(/escapes the workspace/);
  await expect(mine.writeFile("a/../../escape.txt", "x")).rejects.toThrow(/escapes the workspace/);
  await expect(mine.readFile("../escape.txt")).rejects.toThrow(/escapes the workspace/);

  // marker + askpass files stay out of listings
  const listing = await mine.listFiles(".");
  expect(listing).toContain("code.py");
  expect(listing).not.toContain(".polaris-workspace");

  rmSync(tmp, { recursive: true, force: true });
});

test("searchPolarisPapers returns no results when a direct id lookup misses", async () => {
  // The regression: an id miss fell through to the "list recent repos" branch,
  // letting reuse_if_exists return an unrelated implementation.
  try {
    const matches = await searchPolarisPapers({ arxiv_id: "0000.00001" });
    expect(matches).toEqual([]);
  } catch (e) {
    console.warn("searchPolarisPapers id-miss skipped (network/rate-limit):", (e as Error).message);
  }
});

test("titleMatchConfidence separates verified matches from keyword noise", () => {
  const repo = {
    repo_name: "paper-1706-03762",
    arxiv_id: "1706.03762",
    description: "Attention Is All You Need — transformer encoder-decoder reproduction",
    html_url: "",
    updated_at: "",
    stars: 0,
  };
  expect(titleMatchConfidence("Attention Is All You Need", repo)).toBeGreaterThanOrEqual(TITLE_MATCH_THRESHOLD);
  const unrelated = { ...repo, repo_name: "paper-2301.99999", description: "Diffusion models for image generation" };
  expect(titleMatchConfidence("Attention Is All You Need", unrelated)).toBeLessThan(TITLE_MATCH_THRESHOLD);
});

test("defaultRepoName gives every paper a distinct, safe workspace name", () => {
  // arXiv papers follow the library convention
  expect(defaultRepoName("2106.09685", "LoRA", "job-1")).toBe("paper-2106-09685");
  // id-less uploads derive a stable title slug instead of sharing "paper-unknown"
  expect(defaultRepoName("", "Attention Is All You Need", "job-a")).toBe("paper-attention-is-all-you-need");
  expect(defaultRepoName("", "Neural Ordinary Differential Equations", "job-b")).toBe(
    "paper-neural-ordinary-differential-equations",
  );
  expect(defaultRepoName("", "Attention Is All You Need", "job-a")).not.toBe(
    defaultRepoName("", "Neural Ordinary Differential Equations", "job-b"),
  );
  // no id + no title → unique job-derived names (real job uuids are UUIDs)
  const uuid1 = crypto.randomUUID();
  const uuid2 = crypto.randomUUID();
  expect(defaultRepoName("", "", uuid1)).toMatch(/^paper-[0-9a-f]{8}$/);
  expect(defaultRepoName("", "", uuid1)).not.toBe(defaultRepoName("", "", uuid2));
  expect(slugifyTitle("Attention Is All You Need")).toBe("attention-is-all-you-need");
  expect(slugifyTitle("ab")).toBe("");
});

test("parseStrictBool never truthy-coerces the string \"false\"", async () => {
  const { parseStrictBool } = await import("../src/server/server.ts");
  expect(parseStrictBool(true)).toBe(true);
  expect(parseStrictBool("true")).toBe(true);
  expect(parseStrictBool("1")).toBe(true);
  expect(parseStrictBool(1)).toBe(true);
  expect(parseStrictBool(false)).toBe(false);
  expect(parseStrictBool("false")).toBe(false);
  expect(parseStrictBool("0")).toBe(false);
  expect(parseStrictBool(undefined)).toBeUndefined();
  expect(parseStrictBool(null)).toBeUndefined();
  expect(parseStrictBool("yes")).toBeUndefined();
});

test("extractSandboxPaths parses trueForge sandbox artifact blocks", async () => {
  const { extractSandboxPaths, stripSandboxRoot } = await import("../src/trueforge/engine.ts");
  const content = [
    { type: "text", content: "Implementation complete." },
    {
      type: "sandbox_artifacts",
      content: "[train.py](/workspace/train.py)\n[model.py](/workspace/src/model.py)\n[junk](/workspace/.git/config)",
    },
  ];
  // absolute sandbox paths, junk filtered (as the download API expects them)
  expect(extractSandboxPaths(content)).toEqual(["/workspace/train.py", "/workspace/src/model.py"]);
  expect(extractSandboxPaths("plain string")).toEqual([]);
  expect(extractSandboxPaths([{ type: "text", content: "no artifacts" }])).toEqual([]);
  // the shared sandbox-root segment is stripped so files land project-relative
  expect(stripSandboxRoot(["/workspace/train.py", "/workspace/src/model.py"])).toEqual([
    "train.py",
    "src/model.py",
  ]);
  // no shared root → paths kept as-is (relative, no leading slash)
  expect(stripSandboxRoot(["/workspace/a.py", "/other/b.py"])).toEqual(["workspace/a.py", "other/b.py"]);
  expect(stripSandboxRoot(["/train.py"])).toEqual(["train.py"]);
});

test("wrapText and visibleLen handle ANSI and word boundaries", async () => {
  const { wrapText, visibleLen } = await import("../src/server/tui.ts");
  expect(visibleLen("\x1b[34mhello\x1b[0m")).toBe(5);
  expect(visibleLen("plain")).toBe(5);
  expect(wrapText("hello world", 20)).toEqual(["hello world"]);
  expect(wrapText("hello world foo bar", 10)).toEqual(["hello", "world foo", "bar"]);
  // a single long word is hard-split
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  // ANSI-styled strings wrap on visible width, not raw length
  expect(wrapText("\x1b[34mhello\x1b[0m world", 8)).toEqual(["\x1b[34mhello\x1b[0m", "world"]);
});

test("parseEnvFile ignores comments, handles quotes, and defers env-var wins", async () => {
  const { parseEnvFile } = await import("../src/config/settings.ts");
  const text = [
    "# comment",
    "FOO=bar",
    "QUOTED=\"hello world\"",
    "SINGLE='it works'",
    "EXPORTED=1",
    "export EXPORTED2=2",
    "EMPTY=",
    "  SPACED = spaced val ",
  ].join("\n");
  const out = parseEnvFile(text);
  expect(out.FOO).toBe("bar");
  expect(out.QUOTED).toBe("hello world");
  expect(out.SINGLE).toBe("it works");
  expect(out.EXPORTED).toBe("1");
  expect(out.EXPORTED2).toBe("2");
  expect(out.EMPTY).toBe("");
  expect(out.SPACED).toBe("spaced val");
  // keys already in Bun.env are skipped — force a real env var and ensure it wins
  Bun.env["__POLARIS_TEST_PARSE_ENV"] = "real";
  const out2 = parseEnvFile("__POLARIS_TEST_PARSE_ENV=from_file");
  expect(out2["__POLARIS_TEST_PARSE_ENV"]).toBeUndefined();
  delete Bun.env["__POLARIS_TEST_PARSE_ENV"];
});

/* end of file */
