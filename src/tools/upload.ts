/**
 * File intake + text extraction (Phase 2 — file uploads).
 *
 * Accepts an uploaded paper file (PDF / Markdown / plain-text / LaTeX) and
 * returns markdown text that the pipeline READ agent consumes. PDFs are parsed
 * with `unpdf` (server-side pdf.js); text-like formats are decoded directly.
 *
 * Also extracts an arxiv id from the text (when present) so the pipeline can
 * name the output repo and check the Polaris library for an existing coded
 * implementation before generating from scratch.
 *
 * Used by:
 *   - the agent-server (POST /api/run with a multipart file, POST /api/upload)
 *   - the CLI (`polaris run --file path/to/paper.pdf`)
 *   - the MCP server (external agents pass extracted markdown through polaris_run)
 */
import { extractText } from "unpdf";
import { searchPolarisPapers, arxivIdToRepoName, type PaperRepo } from "./papers.ts";
import { normalizeId } from "./arxiv.ts";
import { getSettings } from "../config/settings.ts";

export type PaperKind = "pdf" | "markdown" | "text" | "latex" | "unknown";

export interface ExtractResult {
  kind: PaperKind;
  filename: string;
  markdown: string;
  pages: number;
  chars: number;
  arxiv_id: string;
  title: string;
}

const TEXT_EXT = [".md", ".markdown", ".txt", ".text"];
const LATEX_EXT = [".tex", ".latex"];

export function detectKind(filename: string): PaperKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (TEXT_EXT.some((e) => lower.endsWith(e))) return "markdown";
  if (LATEX_EXT.some((e) => lower.endsWith(e))) return "latex";
  return "unknown";
}

/** Pull the first arXiv id out of arbitrary text (handles abs/pdf URLs + bare ids). */
export function extractArxivId(text: string): string {
  const m = text.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  return m ? normalizeId(m[1]!) : "";
}

/** Best-effort paper title from markdown (first H1, else first non-empty line). */
export function extractTitle(md: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1) return h1.replace(/[*_`]/g, "").slice(0, 200);
  const line = md.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("**") && !l.startsWith("Source:"));
  return line ? line.slice(0, 200) : "";
}

function wrapAsMarkdown(filename: string, body: string, kind: PaperKind): string {
  if (kind === "latex") {
    const title = filename.replace(/\.(tex|latex)$/i, "");
    return `# ${title}\n\n**Source:** uploaded LaTeX file \`${filename}\`\n\n\`\`\`latex\n${body}\n\`\`\`\n`;
  }
  if (body.trimStart().startsWith("#")) return body;
  const title = filename.replace(/\.(md|markdown|txt|text)$/i, "");
  return `# ${title}\n\n${body}\n`;
}

/**
 * Extract markdown text from an uploaded paper file.
 * `bytes` is the raw file content; `filename` is used to pick the parser.
 */
export async function extractPaperText(filename: string, bytes: ArrayBuffer | Uint8Array): Promise<ExtractResult> {
  const kind = detectKind(filename);
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  let md = "";
  let pages = 1;

  if (kind === "pdf") {
    const out = await extractText(buf, { mergePages: true });
    const text = out.text ?? "";
    pages = out.totalPages ?? 1;
    md = text.trim()
      ? `# ${filename.replace(/\.pdf$/i, "")}\n\n**Source:** uploaded PDF \`${filename}\`\n\n${text}\n`
      : "";
  } else if (kind === "unknown") {
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    md = wrapAsMarkdown(filename, body, "text");
  } else {
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    md = wrapAsMarkdown(filename, body, kind);
  }

  return {
    kind,
    filename,
    markdown: md.slice(0, getSettings().MAX_PAPER_CHARS),
    pages,
    chars: md.length,
    arxiv_id: extractArxivId(md),
    title: extractTitle(md),
  };
}

/** Read a paper file from the local filesystem and extract its text. */
export async function extractPaperFile(path: string): Promise<ExtractResult> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`File not found: ${path}`);
  const name = path.split("/").pop() ?? path;
  const bytes = await f.arrayBuffer();
  return extractPaperText(name, bytes);
}

export interface LibraryCheckResult {
  found: boolean;
  repo: PaperRepo | null;
  candidates: PaperRepo[];
  reason: string;
}

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "for", "in", "on", "to", "with", "from",
  "by", "is", "are", "as", "at", "its", "this", "that", "via", "using", "toward", "towards",
]);

/** Content-bearing tokens of a title (lowercased, punctuation stripped, stopwords removed). */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w));
}

/**
 * How strongly a library repo matches a paper title: the fraction of the
 * title's content tokens present in the repo name + description. 1 = every
 * token present. Used to decide whether a keyword-search hit is really the
 * same paper (vs. an unrelated repo that merely mentions some words).
 */
export function titleMatchConfidence(title: string, repo: PaperRepo): number {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return 0;
  const hay = `${repo.repo_name} ${repo.description}`.toLowerCase();
  let hits = 0;
  for (const w of tokens) if (hay.includes(w)) hits++;
  return hits / tokens.length;
}

/** Minimum title-token overlap before a keyword-search hit counts as "found". */
export const TITLE_MATCH_THRESHOLD = 0.8;

/**
 * Check the Polaris coded-implementation library for an existing reproduction.
 * Tries a direct arxiv-id lookup first (exact), then a title/keyword search.
 * A keyword hit only counts as `found` when the repo's metadata strongly
 * matches the paper title (verified identity) — fuzzy hits come back as
 * candidates only, so `reuse_if_exists` can never short-circuit to an
 * unrelated implementation.
 */
export async function findExistingImplementation(
  arxivId: string,
  title: string,
): Promise<LibraryCheckResult> {
  const aid = normalizeId(arxivId);
  if (aid) {
    try {
      const direct = await searchPolarisPapers({ arxiv_id: aid, limit: 1 });
      if (direct.length > 0) {
        return { found: true, repo: direct[0]!, candidates: direct, reason: `matched arxiv id ${aid}` };
      }
    } catch {
      /* network/rate-limit — fall through to title search */
    }
  }
  const q = title.trim();
  if (!q) return { found: false, repo: null, candidates: [], reason: "no arxiv id and no title to search" };
  try {
    const matches = await searchPolarisPapers({ query: q, limit: 5 });
    if (matches.length > 0) {
      const best = matches[0]!;
      const confidence = titleMatchConfidence(q, best);
      if (confidence >= TITLE_MATCH_THRESHOLD) {
        return {
          found: true,
          repo: best,
          candidates: matches,
          reason: `title matched ${best.repo_name} (${Math.round(confidence * 100)}% token overlap)`,
        };
      }
      return {
        found: false,
        repo: null,
        candidates: matches,
        reason: `title search returned candidates but none verified (best: ${best.repo_name}, ${Math.round(confidence * 100)}% token overlap < ${Math.round(TITLE_MATCH_THRESHOLD * 100)}%)`,
      };
    }
  } catch {
    /* ignore */
  }
  return { found: false, repo: null, candidates: [], reason: "no existing implementation found" };
}

/** Repo name for a generated implementation, following the library convention. */
export function implementationRepoName(arxivId: string, fallback: string): string {
  const aid = normalizeId(arxivId);
  return aid ? arxivIdToRepoName(aid) : fallback;
}

/** Slugify a paper title into a GitHub-safe repo-name fragment. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length >= 4 ? slug : "";
}

/**
 * Default repo/workspace name for a run. Papers with an arXiv id follow the
 * `paper-YYMM-NNNNN` library convention; uploaded papers without one derive a
 * stable sanitized name from the title; papers with neither get a unique
 * job-derived suffix so id-less runs never share one workspace.
 */
export function defaultRepoName(arxivId: string, title: string, jobUuid: string): string {
  const aid = normalizeId(arxivId);
  if (aid) return arxivIdToRepoName(aid);
  const slug = slugifyTitle(title);
  return slug ? `paper-${slug}` : `paper-${jobUuid.replace(/-/g, "").slice(0, 8)}`;
}
