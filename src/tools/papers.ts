/**
 * Polaris coded-implementation retrieval — Phase 2.
 *
 * Reads the coded paper reproductions hosted in the PolarisAI-Implementations
 * GitHub org (repos named `paper-YYMM-NNNNN`). The MCP layer exposes this so
 * coding agents (claude-code, codex, …) can retrieve the right implementation
 * for a paper or citation instead of writing everything from scratch.
 *
 * Uses the GitHub REST API. Authenticated when a token is configured (higher
 * rate limit); anonymous otherwise (60 req/h shared limit).
 */
import { getSettings } from "../config/settings.ts";
import { normalizeId } from "./arxiv.ts";

export interface PaperRepo {
  repo_name: string;
  arxiv_id: string;
  description: string;
  html_url: string;
  updated_at: string;
  stars: number;
}

export interface PaperFile {
  path: string;
  type: "blob" | "tree";
  size: number;
}

export interface ImplementationFile {
  path: string;
  content: string;
}

/** `2106.09685` -> `paper-2106-09685`. */
export function arxivIdToRepoName(arxivId: string): string {
  const aid = normalizeId(arxivId);
  return `paper-${aid.replace(".", "-")}`;
}

/** `paper-2106-09685` -> `2106.09685` (empty string if not a paper repo). */
export function repoNameToArxivId(repoName: string): string {
  const m = repoName.match(/^paper-(\d{4})-(\d{4,5})$/);
  return m ? `${m[1]}.${m[2]}` : "";
}

function authHeaders(): Record<string, string> {
  const s = getSettings();
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (s.POLARIS_PAPERS_TOKEN) h.Authorization = `Bearer ${s.POLARIS_PAPERS_TOKEN}`;
  return h;
}

function org(): string {
  return getSettings().POLARIS_PAPERS_ORG;
}

function apiBase(): string {
  return getSettings().GITHUB_API_URL.replace(/\/$/, "");
}

async function ghFetch(url: string, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: authHeaders(), signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(to);
  }
}

interface GhRepoJson {
  name: string;
  description: string | null;
  html_url: string;
  updated_at: string;
  stargazers_count: number;
}

function toPaperRepo(r: GhRepoJson): PaperRepo {
  return {
    repo_name: r.name,
    arxiv_id: repoNameToArxivId(r.name),
    description: r.description ?? "",
    html_url: r.html_url,
    updated_at: r.updated_at,
    stars: r.stargazers_count ?? 0,
  };
}

/** List every coded-implementation repo in the org (paginated). */
export async function listPolarisRepos(): Promise<PaperRepo[]> {
  const o = org();
  const out: PaperRepo[] = [];
  let page = 1;
  for (;;) {
    const r = await ghFetch(`${apiBase()}/orgs/${o}/repos?per_page=100&page=${page}&sort=updated&type=public`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GitHub list org repos failed: ${r.status}`);
    const arr = (await r.json()) as GhRepoJson[];
    for (const repo of arr) {
      if (repo.name.startsWith("paper-")) out.push(toPaperRepo(repo));
    }
    const link = r.headers.get("link") ?? "";
    if (!link.includes('rel="next"')) break;
    page += 1;
    if (page > 20) break;
  }
  return out;
}

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const term of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (!term) continue;
    if (t.includes(term)) s += 1;
    if (t.startsWith(term)) s += 1;
  }
  return s;
}

export interface SearchOpts {
  arxiv_id?: string;
  query?: string;
  limit?: number;
}

/**
 * Retrieve the right coded implementation for a paper.
 *  - If `arxiv_id` is given, do a direct repo lookup (`paper-YYMM-NNNNN`).
 *  - Otherwise use GitHub's search API (indexes repo names, descriptions, AND
 *    README contents) so topic queries like "attention transformer" match the
 *    right reproduction. Falls back to a local rank over the repo list if the
 *    search API is unavailable.
 * Returns matching repos with arXiv links so the agent (or user) can pick one.
 */
export async function searchPolarisPapers(opts: SearchOpts): Promise<PaperRepo[]> {
  const limit = opts.limit ?? 10;
  const aid = opts.arxiv_id ? normalizeId(opts.arxiv_id) : "";
  if (aid) {
    const r = await ghFetch(`${apiBase()}/repos/${org()}/${arxivIdToRepoName(aid)}`);
    if (r.ok) return [toPaperRepo((await r.json()) as GhRepoJson)];
  }
  const q = (opts.query ?? "").trim();
  if (!q) {
    const repos = await listPolarisRepos();
    return repos.slice(0, limit);
  }
  // GitHub search API — searches names, descriptions, and READMEs across the org.
  try {
    const r = await ghFetch(
      `${apiBase()}/search/repositories?q=${encodeURIComponent(q)}+in:name,description,readme+org:${org()}&per_page=${limit}&sort=updated`,
    );
    if (r.ok) {
      const j = (await r.json()) as { items: GhRepoJson[] };
      return (j.items ?? [])
        .filter((repo) => repo.name.startsWith("paper-"))
        .map(toPaperRepo)
        .slice(0, limit);
    }
  } catch {
    /* fall through to local rank */
  }
  const repos = await listPolarisRepos();
  return repos
    .map((rp) => ({ rp, s: score(`${rp.repo_name} ${rp.description} ${rp.arxiv_id}`, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.rp);
}

/** Recursive file tree for an implementation repo. */
export async function getImplementationTree(repoName: string): Promise<PaperFile[]> {
  const o = org();
  const r = await ghFetch(`${apiBase()}/repos/${o}/${repoName}/git/trees/HEAD?recursive=1`);
  if (!r.ok) throw new Error(`GitHub tree fetch failed for ${repoName}: ${r.status}`);
  const j = (await r.json()) as { tree: Array<{ path: string; type: string; size?: number }> };
  return (j.tree ?? []).map((n) => ({
    path: n.path,
    type: (n.type === "tree" ? "tree" : "blob") as "blob" | "tree",
    size: n.size ?? 0,
  }));
}

/** Fetch a single file's decoded content from an implementation repo. */
export async function getImplementationFile(repoName: string, filePath: string): Promise<string> {
  const o = org();
  const r = await ghFetch(`${apiBase()}/repos/${o}/${repoName}/contents/${filePath}`);
  if (!r.ok) throw new Error(`GitHub file fetch failed for ${repoName}:${filePath}: ${r.status}`);
  const j = (await r.json()) as { content?: string; encoding?: string };
  if (j.encoding === "base64" && j.content) {
    return atob(j.content.replace(/\n/g, ""));
  }
  return j.content ?? "";
}

const CODE_EXT = [".py", ".ts", ".tsx", ".js", ".jsx", ".sh", ".ipynb", ".toml", ".yaml", ".yml", ".cfg", ".txt"];
const SKIP_DIRS = ["node_modules", ".git", "__pycache__", ".venv", "dist", "build"];

function isCodeFile(path: string): boolean {
  if (SKIP_DIRS.some((d) => path.startsWith(d + "/"))) return false;
  return CODE_EXT.some((e) => path.endsWith(e)) || path === "requirements.txt";
}

/**
 * Retrieve the full implementation for a repo: file tree + contents of every
 * code/source file. This is what coding agents read to reuse an existing
 * coded implementation. `maxFiles` caps the number of file bodies fetched.
 */
export async function getImplementation(repoName: string, maxFiles = 40): Promise<{
  repo_name: string;
  arxiv_id: string;
  html_url: string;
  tree: PaperFile[];
  files: ImplementationFile[];
}> {
  const o = org();
  const tree = await getImplementationTree(repoName);
  const blobs = tree.filter((f) => f.type === "blob" && isCodeFile(f.path)).slice(0, maxFiles);

  const files: ImplementationFile[] = [];
  for (const f of blobs) {
    try {
      const content = await getImplementationFile(repoName, f.path);
      files.push({ path: f.path, content });
    } catch {
      /* skip unreadable files */
    }
  }

  const r = await ghFetch(`${apiBase()}/repos/${o}/${repoName}`);
  const meta = r.ok ? ((await r.json()) as GhRepoJson) : null;

  return {
    repo_name: repoName,
    arxiv_id: repoNameToArxivId(repoName),
    html_url: meta?.html_url ?? `https://github.com/${o}/${repoName}`,
    tree,
    files,
  };
}

/** Convenience: retrieve an implementation by arxiv id instead of repo name. */
export async function getImplementationByArxiv(arxivId: string, maxFiles?: number) {
  return getImplementation(arxivIdToRepoName(arxivId), maxFiles);
}
