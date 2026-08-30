/**
 * Pipeline runner — port of worker/main.py::run_one.
 *
 * Builds the WorkerState from a job spec, ensures the paper markdown is present,
 * drives the graph, and emits the terminal status. The polaris backend loaded
 * markdown from a Redis cache; the CLI accepts it inline or fetches a starter
 * markdown from the arxiv abstract page.
 */
import type { WorkerState } from "../state.ts";
import { runGraph } from "./graph.ts";
import { error, status, step } from "./trace.ts";

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

  status(jobUuid, "running");
  step(jobUuid, "SYSTEM", "job-start", {
    tool: "cli:jobs",
    conclusion: "job picked up by polaris-cli",
    output_query: `paper ${job.arxiv_id ?? ""}`,
  });

  let markdown = job.markdown ?? "";
  if (!markdown && job.arxiv_id) {
    markdown = await fetchArxivMarkdown(job.arxiv_id);
  }
  if (!markdown) {
    error(jobUuid, "SYSTEM", "no markdown for paper");
    status(jobUuid, "failed");
    return { job_uuid: jobUuid, paper_id: paperId, status: "failed", error: "no markdown" };
  }

  const state: WorkerState = {
    job_uuid: jobUuid,
    paper_id: paperId,
    user_id: job.user_id ?? "",
    arxiv_id: job.arxiv_id ?? "",
    top_n_citations: job.top_n_citations ?? 8,
    repo_name: job.repo_name ?? "",
    github_url: job.github_url ?? "",
    repo_exists: job.repo_exists ?? false,
    execution_mode: job.execution_mode ?? "create",
    markdown,
    auto_approve: job.auto_approve ?? false,
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
