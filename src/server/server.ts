/**
 * Agent server — a single Bun.serve exposing:
 *   - REST API: POST /api/run, GET /api/jobs/:id, POST /api/jobs/:id/approve
 *   - SSE:      GET /api/jobs/:id/stream   (live trace events)
 *   - Web page: GET /                      (HTML imports + React UI)
 *   - MCP:      /* /mcp                    (polaris MCP server)
 *
 * This is the opencode-style single agent-server: one process, TUI + web + API.
 */
import index from "./web/index.html";
import { runOne } from "../pipeline/run.ts";
import { traceBus, type TraceEvent } from "../pipeline/trace.ts";
import { approvalGate } from "../pipeline/approval.ts";
import { mcpRouteHandler } from "../mcp/server.ts";
import { getSettings } from "../config/settings.ts";
import { searchPolarisPapers, getImplementation, getImplementationFile, arxivIdToRepoName } from "../tools/papers.ts";
import { extractPaperText, type ExtractResult } from "../tools/upload.ts";
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { startTrueForgeServer, isTrueForgeRunning, type TrueForgeServer } from "../trueforge/server.ts";
import { provisionTrueForge } from "../trueforge/provision.ts";
import { parseEngine, type EngineType } from "../agents_util/engine.ts";

export interface ServerOptions {
  port?: number;
  startTrueForge?: boolean;
  mcpSecret?: string;
}

interface RunningJob {
  jobUuid: string;
  promise: Promise<unknown>;
  arxivId: string;
  source: string;
}

const jobs = new Map<string, RunningJob>();
let tfServer: TrueForgeServer | null = null;

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const s = getSettings();
  const port = opts.port ?? s.POLARIS_PORT;
  const mcpSecret = opts.mcpSecret ?? Bun.env["POLARIS_MCP_SECRET"];

  // Optionally boot + provision a trueForge harness alongside the server.
  // A configured remote harness (POLARIS_TRUEFORGE_BASE_URL) must already be
  // running and is only (re)provisioned when an externally reachable MCP URL
  // (POLARIS_MCP_PUBLIC_URL) is set — a localhost MCP URL would resolve on the
  // remote host. A locally managed harness runs on POLARIS_TRUEFORGE_PORT (so
  // it never collides with the agent-server port) and is provisioned with our
  // own /mcp route.
  if (opts.startTrueForge) {
    if (s.TRUEFORGE_BASE_URL) {
      const remoteUrl = s.TRUEFORGE_BASE_URL;
      if (!(await isTrueForgeRunning(remoteUrl))) {
        throw new Error(
          `trueForge is not reachable at ${remoteUrl} — start it (npx @truefoundry/trueforge) ` +
            `or unset POLARIS_TRUEFORGE_BASE_URL so polaris can boot one locally.`,
        );
      }
      if (s.POLARIS_MCP_PUBLIC_URL) {
        console.log(`[polaris] provisioning remote trueForge at ${remoteUrl} (MCP → ${s.POLARIS_MCP_PUBLIC_URL}) …`);
        await provisionTrueForge(makeTrueForgeClient(remoteUrl), {
          mcpUrl: s.POLARIS_MCP_PUBLIC_URL,
          mcpSecret,
        });
      } else {
        console.log(
          `[polaris] using remote trueForge at ${remoteUrl} as provisioned ` +
            `(set POLARIS_MCP_PUBLIC_URL to an externally reachable polaris MCP URL to re-provision)`,
        );
      }
    } else {
      const tfPort = s.TRUEFORGE_PORT;
      const localTf = `http://localhost:${tfPort}`;
      const running = await isTrueForgeRunning(localTf);
      if (!running) {
        console.log(`[polaris] starting local trueForge harness on :${tfPort} …`);
        tfServer = await startTrueForgeServer({ port: tfPort });
      }
      const client = makeTrueForgeClient(localTf);
      const mcpUrl = `http://localhost:${port}/mcp`;
      console.log(`[polaris] provisioning trueForge (model provider + MCP → ${mcpUrl} + agents) …`);
      await provisionTrueForge(client, { mcpUrl, mcpSecret });
      console.log(`[polaris] trueForge ready at ${tfServer?.baseUrl ?? localTf} (chat UI + API)`);
    }
  }

  const mcpHandler = mcpRouteHandler(mcpSecret);

  const server = Bun.serve({
    port,
    routes: {
      "/": index,
      "/mcp": mcpHandler,
    },
    fetch(req): Response | Promise<Response> {
      return apiRouter(req);
    },
    development: { hmr: true, console: true },
  });

  const tfUrl = tfServer ? tfServer.baseUrl : s.TRUEFORGE_BASE_URL || `http://localhost:${s.TRUEFORGE_PORT}`;
  console.log(`\n  Polaris agent-server listening on http://localhost:${server.port}`);
  console.log(`  Web UI:        http://localhost:${server.port}`);
  console.log(`  trueForge UI:  ${tfUrl}`);
  console.log(`  MCP endpoint:  http://localhost:${server.port}/mcp`);
  console.log(`  API:           http://localhost:${server.port}/api`);
  console.log(`  Paper library: http://localhost:${server.port}/api/papers  (org: ${s.POLARIS_PAPERS_ORG})\n`);
}

async function apiRouter(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /api/upload — extract text from an uploaded file (preview, no pipeline run)
  if (path === "/api/upload" && req.method === "POST") {
    const parsed = await parsePaperUpload(req);
    if (parsed.error || !parsed.result) return json({ error: parsed.error }, parsed.status ?? 400);
    const r = parsed.result;
    return json({
      kind: r.kind,
      filename: r.filename,
      arxiv_id: r.arxiv_id,
      title: r.title,
      pages: r.pages,
      chars: r.chars,
      markdown_preview: r.markdown.slice(0, 2000),
    });
  }

  // POST /api/run — start a paper reproduction
  // Accepts JSON ({ arxiv_id, markdown, engine, reuse_if_exists, … }) OR multipart
  // (file field "paper" + optional text fields).
  if (path === "/api/run" && req.method === "POST") {
    const parsed = await parseRunRequest(req);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const { arxivId, markdown, engine, reuseIfExists, repoName, executionMode, topN, source } = parsed;
    const jobUuid = crypto.randomUUID();
    const job: RunningJob = {
      jobUuid,
      arxivId,
      source,
      promise: runOne({
        job_uuid: jobUuid,
        arxiv_id: arxivId,
        markdown,
        engine,
        reuse_if_exists: reuseIfExists,
        repo_name: repoName,
        execution_mode: executionMode,
        top_n_citations: topN,
      }),
    };
    jobs.set(jobUuid, job);
    job.promise.catch(() => {});
    return json({ job_uuid: jobUuid, arxiv_id: arxivId, source, engine });
  }

  // GET /api/jobs/:id — job status
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const id = jobMatch[1]!;
    const st = traceBus.getStatus(id);
    const plan = approvalGate.hasPending(id);
    return json({
      job_uuid: id,
      status: st?.status ?? "unknown",
      github_url: st?.github_url,
      awaiting_approval: plan ? { plan } : null,
    });
  }

  // POST /api/jobs/:id/approve — resolve plan approval
  const approveMatch = path.match(/^\/api\/jobs\/([^/]+)\/approve$/);
  if (approveMatch && req.method === "POST") {
    const id = approveMatch[1]!;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ok = approvalGate.resolve(id, {
      approved: body["approved"] !== false,
      feedback: String(body["feedback"] ?? ""),
    });
    if (!ok) return json({ error: "no pending approval for this job" }, 404);
    return json({ ok: true });
  }

  // GET /api/jobs/:id/stream — SSE trace stream (live + replay)
  const streamMatch = path.match(/^\/api\/jobs\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const id = streamMatch[1]!;
    return sseStream(id);
  }

  // GET /api/jobs — list jobs
  if (path === "/api/jobs" && req.method === "GET") {
    return json({ jobs: [...jobs.values()].map((j) => ({ job_uuid: j.jobUuid, arxiv_id: j.arxivId, source: j.source })) });
  }

  // GET /api/pending — jobs awaiting plan approval
  if (path === "/api/pending" && req.method === "GET") {
    const pending = approvalGate.pendingJobs().map((id) => ({ job_uuid: id, plan: approvalGate.hasPending(id) }));
    return json({ pending });
  }

  // ─── Polaris coded-implementation library (Phase 2) ─────────────────────────
  // GET /api/papers — search/list implementations (query params: arxiv_id, query, limit)
  if (path === "/api/papers" && req.method === "GET") {
    const arxivId = url.searchParams.get("arxiv_id") ?? undefined;
    const query = url.searchParams.get("query") ?? undefined;
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
    try {
      const papers = await searchPolarisPapers({ arxiv_id: arxivId, query, limit });
      return json({ org: getSettings().POLARIS_PAPERS_ORG, count: papers.length, papers });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  // GET /api/papers/:repo — file tree + code contents (query param: file=single path)
  const paperMatch = path.match(/^\/api\/papers\/([^/]+)$/);
  if (paperMatch && req.method === "GET") {
    const repo = paperMatch[1]!;
    const singleFile = url.searchParams.get("file");
    try {
      if (singleFile) {
        const content = await getImplementationFile(repo, singleFile);
        return json({ repo_name: repo, path: singleFile, content });
      }
      const impl = await getImplementation(repo);
      return json(impl);
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  // GET /api/papers/by-arxiv/:id — convenience lookup by arxiv id
  const arxivMatch = path.match(/^\/api\/papers\/by-arxiv\/([^/]+)$/);
  if (arxivMatch && req.method === "GET") {
    const repoName = arxivIdToRepoName(arxivMatch[1]!);
    try {
      const impl = await getImplementation(repoName);
      return json(impl);
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseStream(jobUuid: string): Response {
  const encoder = new TextEncoder();
  const queue: TraceEvent[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const unsubscribe = traceBus.subscribe(jobUuid, (ev) => {
    if (closed) return;
    if (controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    } else {
      queue.push(ev);
    }
  });

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      for (const ev of queue) ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      queue.length = 0;
    },
    cancel() {
      closed = true;
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ─── Upload parsing helpers ─────────────────────────────────────────────────────
// Bun.formData() parses multipart bodies. We accept either a JSON body (with
// inline markdown) or a multipart upload with a "paper" file field.
// Bodies larger than POLARIS_MAX_UPLOAD_MB are rejected with 413 BEFORE being
// buffered, and the extracted text is capped at POLARIS_MAX_PAPER_CHARS, so an
// oversized upload can't exhaust memory or blow up the LLM input.

interface ParsedUpload {
  error?: string;
  status?: number;
  result?: ExtractResult;
}

/** Reject requests whose declared body size already exceeds the upload cap. */
function bodyTooLarge(req: Request): boolean {
  const declared = Number(req.headers.get("content-length") ?? 0);
  return declared > getSettings().MAX_UPLOAD_BYTES;
}

function uploadTooLargeError(): { error: string; status: number } {
  return { error: `upload exceeds the ${Math.floor(getSettings().MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit`, status: 413 };
}

/**
 * Strictly parse a boolean form/json value. Accepts true/"true"/1/"1" and
 * false/"false"/0/"0"; any other value (including the truthy-but-wrong string
 * "false" under loose coercion) is rejected so callers never misread intent.
 */
export function parseStrictBool(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return undefined;
}

async function parsePaperUpload(req: Request): Promise<ParsedUpload> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return { error: "expected multipart/form-data with a 'paper' file field", status: 400 };
  }
  if (bodyTooLarge(req)) return uploadTooLargeError();
  try {
    const form = await req.formData();
    const file = form.get("paper");
    if (!file || !(file instanceof File)) {
      return { error: "no 'paper' file field in upload", status: 400 };
    }
    if (file.size > getSettings().MAX_UPLOAD_BYTES) return uploadTooLargeError();
    const bytes = await file.arrayBuffer();
    const result = await extractPaperText(file.name, bytes);
    return { result };
  } catch (e) {
    return { error: `upload parse failed: ${(e as Error).message}`, status: 400 };
  }
}

interface ParsedRun {
  error?: string;
  status?: number;
  arxivId: string;
  markdown?: string;
  engine: EngineType;
  reuseIfExists: boolean;
  repoName?: string;
  executionMode?: string;
  topN?: number;
  source: string;
}

function invalidEngineError(value: string): { error: string; status: number } {
  return { error: `invalid engine "${value}" — expected "local" or "trueforge"`, status: 400 };
}

async function parseRunRequest(req: Request): Promise<ParsedRun> {
  const ct = req.headers.get("content-type") ?? "";
  const s = getSettings();

  // Multipart: a file + optional text fields
  if (ct.includes("multipart/form-data")) {
    if (bodyTooLarge(req)) return { ...uploadTooLargeError(), arxivId: "", engine: "local", reuseIfExists: false, source: "upload" };
    try {
      const form = await req.formData();
      const file = form.get("paper");
      let markdown: string | undefined;
      let source = "json";
      if (file && file instanceof File) {
        if (file.size > s.MAX_UPLOAD_BYTES) {
          return { ...uploadTooLargeError(), arxivId: "", engine: "local", reuseIfExists: false, source: "upload" };
        }
        const bytes = await file.arrayBuffer();
        const result = await extractPaperText(file.name, bytes);
        markdown = result.markdown;
        source = `upload:${file.name}`;
      }
      const arxivId = String(form.get("arxiv_id") ?? "");
      if (!arxivId && !markdown) {
        return { error: "provide an arxiv_id or a 'paper' file", status: 400, arxivId: "", engine: "local", reuseIfExists: false, source };
      }
      const engineRaw = String(form.get("engine") ?? "local");
      let engine: EngineType;
      try {
        engine = parseEngine(engineRaw);
      } catch {
        return { ...invalidEngineError(engineRaw), arxivId, markdown, engine: "local", reuseIfExists: false, source };
      }
      const reuseRaw = form.get("reuse_if_exists");
      const reuse = reuseRaw == null ? false : parseStrictBool(reuseRaw);
      if (reuse === undefined) {
        return { error: `invalid reuse_if_exists "${String(reuseRaw)}" — expected true/false/1/0`, status: 400, arxivId, markdown, engine, reuseIfExists: false, source };
      }
      return {
        arxivId,
        markdown,
        engine,
        reuseIfExists: reuse,
        repoName: form.get("repo_name") ? String(form.get("repo_name")) : undefined,
        executionMode: form.get("execution_mode") ? String(form.get("execution_mode")) : undefined,
        topN: form.get("top_n_citations") ? Number(form.get("top_n_citations")) : undefined,
        source,
      };
    } catch (e) {
      return { error: `multipart parse failed: ${(e as Error).message}`, status: 400, arxivId: "", engine: "local", reuseIfExists: false, source: "error" };
    }
  }

  // JSON body
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const arxivId = String(body["arxiv_id"] ?? "");
  const markdown = body["markdown"] ? String(body["markdown"]) : undefined;
  if (!arxivId && !markdown) {
    return { error: "provide an arxiv_id or markdown", status: 400, arxivId: "", engine: "local", reuseIfExists: false, source: "json" };
  }
  const engineRaw = String(body["engine"] ?? "local");
  let engine: EngineType;
  try {
    engine = parseEngine(engineRaw);
  } catch {
    return { ...invalidEngineError(engineRaw), arxivId, markdown, engine: "local", reuseIfExists: false, source: "json" };
  }
  // Strict boolean parsing: `Boolean("false")` would be true — never coerce.
  const reuse = body["reuse_if_exists"] == null ? false : parseStrictBool(body["reuse_if_exists"]);
  if (reuse === undefined) {
    return { error: `invalid reuse_if_exists "${String(body["reuse_if_exists"])}" — expected true/false/1/0`, status: 400, arxivId, markdown, engine, reuseIfExists: false, source: "json" };
  }
  return {
    arxivId,
    markdown,
    engine,
    reuseIfExists: reuse,
    repoName: body["repo_name"] ? String(body["repo_name"]) : undefined,
    executionMode: body["execution_mode"] ? String(body["execution_mode"]) : undefined,
    topN: body["top_n_citations"] ? Number(body["top_n_citations"]) : undefined,
    source: markdown ? "json:markdown" : "json:arxiv",
  };
}
