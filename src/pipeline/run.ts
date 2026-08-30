/**
 * Pipeline runner — port of worker/main.py::run_one.
 *
 * Builds the WorkerState from a job spec, ensures the paper markdown is present,
 * drives the graph, and emits the terminal status. The polaris backend loaded
 * markdown from a Redis cache; the CLI accepts it inline, fetches a starter
 * markdown from the arxiv abstract page, or extracts it from an uploaded file.
 *
 * Phase 2 additions:
 *   - Library-first check: before generating, search the PolarisAI-Implementations
 *     org for an existing coded implementation. If found and `reuse_if_exists`,
 *     short-circuit and return the existing repo. Otherwise record the hit so
 *     the CODE agent can reuse it, then generate.
 *   - Engine choice: `engine` ("local" | "trueforge") routes agent execution
 *     to the BYOK ReAct loop or the trueForge harness.
 *   - File uploads: callers pass `markdown` (extracted from a PDF/etc) instead
 *     of (or alongside) an arxiv id.
 */
import type { WorkerState } from "../state.ts";
import { runGraph } from "./graph.ts";
import { error, status, step, output } from "./trace.ts";
import { findExistingImplementation, extractArxivId, extractTitle, defaultRepoName } from "../tools/upload.ts";
import { parseEngine } from "../agents_util/engine.ts";

export interface Job {
  job_uuid?: string;
  paper_id?: string;
  user_id?: string;
  arxiv_id?: string;
  top_n_citations?: number;
  repo_name?: string;
  github_url?: string;
  repo_exists?: boolean;
  execution_mode?: string;
  markdown?: string;
  auto_approve?: boolean;
  /** Execution engine: "local" (BYOK ReAct loop, default) or "trueforge". */
  engine?: string;
  /** If true and an existing library implementation is found, reuse it (skip generation). */
  reuse_if_exists?: boolean;
  /** Directory to create the project in (defaults to POLARIS_OUTPUT_DIR or cwd). */
  output_dir?: string;
}

/** Fetch a starter markdown (title + authors + abstract) from the arxiv abs page. */
export async function fetchArxivMarkdown(arxivId: string): Promise<string> {
  const id = arxivId.trim();
  try {
    const r = await fetch(`https://arxiv.org/abs/${id}`, { redirect: "follow" });
    if (!r.ok) return "";
    const html = await r.text();
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? id;
    const authors = [...html.matchAll(/<meta name="citation_author" content="([^"]+)"/g)].map((m) => m[1]).join(", ");
    const abstract = html.match(/<blockquote class="abstract[^"]*">([\s\S]*?)<\/blockquote>/i)?.[1]
      ?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() ?? "";
    return `# ${title}\n\n**Authors:** ${authors}\n\n**arXiv:** ${id}\n\n## Abstract\n\n${abstract}\n`;
  } catch {
    return "";
  }
}

export async function runOne(job: Job): Promise<WorkerState> {
  const jobUuid = job.job_uuid ?? crypto.randomUUID();
  const paperId = job.paper_id ?? "";

  // Reject unknown engines up front with a clear error instead of silently
  // running the local loop for a typo'd `--engine tureforge`.
  let engine: WorkerState["engine"];
  try {
    engine = parseEngine(job.engine);
  } catch (e) {
    const msg = (e as Error).message;
    error(jobUuid, "SYSTEM", msg);
    status(jobUuid, "failed");
    return { job_uuid: jobUuid, paper_id: paperId, status: "failed", error: msg };
  }

  status(jobUuid, "running");
  step(jobUuid, "SYSTEM", "job-start", {
    tool: "cli:jobs",
    conclusion: "job picked up by polaris-cli",
    output_query: `paper ${job.arxiv_id ?? ""} engine=${engine}`,
  });

  let markdown = job.markdown ?? "";
  let arxivId = job.arxiv_id ?? "";

  // File uploads may carry the arxiv id + title inside the extracted text.
  if (!arxivId && markdown) arxivId = extractArxivId(markdown);
  if (!markdown && arxivId) markdown = await fetchArxivMarkdown(arxivId);
  if (!markdown) {
    error(jobUuid, "SYSTEM", "no markdown for paper (provide an arxiv id or upload a file)");
    status(jobUuid, "failed");
    return { job_uuid: jobUuid, paper_id: paperId, status: "failed", error: "no markdown" };
  }

  // ── Library-first check ──────────────────────────────────────────────────────
  // Search the Polaris coded-implementation library for an existing reproduction.
  // If one exists and reuse is enabled, short-circuit. Otherwise record the hit
  // so the CODE agent can reuse the existing implementation while still running.
  let libraryHit: WorkerState["library_hit"] = null;
  const title = extractTitle(markdown);
  try {
    const check = await findExistingImplementation(arxivId, title);
    if (check.found && check.repo) {
      libraryHit = {
        repo_name: check.repo.repo_name,
        html_url: check.repo.html_url,
        arxiv_id: check.repo.arxiv_id,
      };
      step(jobUuid, "SYSTEM", "library-check", {
        tool: "papers:search",
        conclusion: `existing implementation found: ${check.repo.repo_name} (${check.reason})`,
        output_query: check.repo.html_url,
      });
      if (job.reuse_if_exists) {
        output(jobUuid, "SYSTEM", `Reusing existing implementation ${check.repo.repo_name}`, check.repo.html_url);
        status(jobUuid, "done", { github_url: check.repo.html_url, reused: true });
        return {
          job_uuid: jobUuid,
          paper_id: paperId,
          arxiv_id: arxivId,
          markdown,
          status: "done",
          error: null,
          code: { github_url: check.repo.html_url, repo_name: check.repo.repo_name, ready: true, output_query: check.repo.html_url },
          library_hit: libraryHit,
        };
      }
    } else {
      step(jobUuid, "SYSTEM", "library-check", {
        tool: "papers:search",
        conclusion: `no existing implementation (${check.reason}) — will generate`,
      });
    }
  } catch (e) {
    step(jobUuid, "SYSTEM", "library-check", {
      tool: "papers:search",
      conclusion: `library check skipped: ${(e as Error).message}`,
    });
  }

  const state: WorkerState = {
    job_uuid: jobUuid,
    paper_id: paperId,
    user_id: job.user_id ?? "",
    arxiv_id: arxivId,
    top_n_citations: job.top_n_citations ?? 8,
    // Default name: paper-YYMM-NNNNN for arXiv papers, title slug (or unique
    // job-derived name) for id-less uploads — never a shared "paper-unknown".
    repo_name: job.repo_name || defaultRepoName(arxivId, title, jobUuid),
    github_url: job.github_url ?? "",
    repo_exists: job.repo_exists ?? false,
    execution_mode: job.execution_mode ?? "create",
    markdown,
    auto_approve: job.auto_approve ?? false,
    engine,
    output_dir: job.output_dir,
    library_hit: libraryHit,
    iteration: {},
    runs: {},
    history: [],
    status: "queued",
    error: null,
  };

  let final: WorkerState;
  try {
    final = await runGraph(state);
  } catch (e) {
    error(jobUuid, "SYSTEM", `pipeline crashed: ${(e as Error).message}`);
    status(jobUuid, "failed");
    return { ...state, status: "failed", error: (e as Error).message };
  }

  if (final.error) {
    error(jobUuid, "SYSTEM", String(final.error));
    status(jobUuid, "failed");
  } else if (final.code?.push_error) {
    error(jobUuid, "CODE", final.code.push_error);
    status(jobUuid, "failed");
  } else {
    const ghUrl = final.code?.github_url ?? "";
    status(jobUuid, "done", { github_url: ghUrl });
  }
  step(jobUuid, "SYSTEM", "job-end", {
    tool: "graph",
    conclusion: "pipeline finished",
    output_query: final.status ?? "done",
  });
  return final;
}
