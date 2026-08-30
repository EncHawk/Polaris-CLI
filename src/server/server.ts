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
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { startTrueForgeServer, isTrueForgeRunning, type TrueForgeServer } from "../trueforge/server.ts";
import { provisionTrueForge } from "../trueforge/provision.ts";

export interface ServerOptions {
  port?: number;
  startTrueForge?: boolean;
  mcpSecret?: string;
}

interface RunningJob {
  jobUuid: string;
  promise: Promise<unknown>;
  arxivId: string;
}

const jobs = new Map<string, RunningJob>();
let tfServer: TrueForgeServer | null = null;

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const s = getSettings();
  const port = opts.port ?? s.TRUEFORGE_PORT;
  const mcpSecret = opts.mcpSecret ?? Bun.env["POLARIS_MCP_SECRET"];

  // Optionally boot + provision a local trueForge harness alongside the server.
  if (opts.startTrueForge) {
    const running = await isTrueForgeRunning(`http://localhost:${port}`);
    if (!running) {
      console.log(`[polaris] starting local trueForge harness on :${port} …`);
      tfServer = await startTrueForgeServer({ port });
    }
    const client = makeTrueForgeClient(`http://localhost:${port}`);
    const mcpUrl = `http://localhost:${port}/mcp`;
    console.log(`[polaris] provisioning trueForge (model provider + MCP + agents) …`);
    await provisionTrueForge(client, { mcpUrl, mcpSecret });
    console.log(`[polaris] trueForge ready at ${tfServer?.baseUrl ?? `http://localhost:${port}`} (chat UI + API)`);
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

  const tfUrl = tfServer ? tfServer.baseUrl : `http://localhost:${port}`;
  console.log(`\n  Polaris agent-server listening on http://localhost:${server.port}`);
  console.log(`  Web UI:        http://localhost:${server.port}`);
  console.log(`  trueForge UI:  ${tfUrl}`);
  console.log(`  MCP endpoint:  http://localhost:${server.port}/mcp`);
  console.log(`  API:           http://localhost:${server.port}/api\n`);
}

async function apiRouter(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /api/run — start a paper reproduction
  if (path === "/api/run" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const arxivId = String(body["arxiv_id"] ?? "");
    if (!arxivId) return json({ error: "arxiv_id is required" }, 400);
    const jobUuid = crypto.randomUUID();
    const job: RunningJob = {
      jobUuid,
      arxivId,
      promise: runOne({
        job_uuid: jobUuid,
        arxiv_id: arxivId,
        repo_name: body["repo_name"] ? String(body["repo_name"]) : undefined,
        execution_mode: body["execution_mode"] ? String(body["execution_mode"]) : undefined,
        top_n_citations: body["top_n_citations"] ? Number(body["top_n_citations"]) : undefined,
      }),
    };
    jobs.set(jobUuid, job);
    // don't await — run in background
    job.promise.catch(() => {});
    return json({ job_uuid: jobUuid, arxiv_id: arxivId });
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
    return json({ jobs: [...jobs.values()].map((j) => ({ job_uuid: j.jobUuid, arxiv_id: j.arxivId })) });
  }

  // GET /api/pending — jobs awaiting plan approval
  if (path === "/api/pending" && req.method === "GET") {
    const pending = approvalGate.pendingJobs().map((id) => ({ job_uuid: id, plan: approvalGate.hasPending(id) }));
    return json({ pending });
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
