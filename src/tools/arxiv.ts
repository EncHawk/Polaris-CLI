/**
 * arxiv lookup tool — port of worker/tools/arxiv_citation.py.
 *
 * Uses the public arxiv Atom API. We fetch only abstracts/metadata for the
 * RESEARCH agent (cheap); full PDFs are the READ pipeline's job for the main
 * paper. Minimal regex parser avoids an XML dependency.
 */

export interface ArxivMeta {
  arxiv_id: string;
  title: string;
  abstract: string;
}

export function normalizeId(s: string): string {
  const t = s.trim();
  let m = t.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (m) return m[1]!;
  m = t.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return m ? m[1]! : t;
}

function quoteTitle(s: string): string {
  return s.trim().split(/\s+/).join("%20");
}

function parseFirst(atom: string, requestedId: string | null): ArxivMeta | null {
  const entryMatch = atom.match(/<entry[\s\S]*?<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[0];
  const grab = (tag: string): string =>
    (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "").trim().replace(/\n/g, " ");
  const title = grab("title");
  const summary = grab("summary");
  const idEl = grab("id");
  let aid = requestedId ?? "";
  if (!aid) {
    const m = idEl.match(/abs\/([^/]+?)$/);
    if (m) aid = m[1]!;
  }
  return { arxiv_id: aid, title, abstract: summary };
}

export async function searchId(arxivId: string, timeoutMs = 10_000): Promise<ArxivMeta | null> {
  const aid = normalizeId(arxivId);
  const url = `http://export.arxiv.org/api/query?id_list=${aid}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    if (!r.ok) return null;
    return parseFirst(await r.text(), aid);
  } catch {
    return null;
  }
}

export async function searchTitle(title: string, maxResults = 1, timeoutMs = 10_000): Promise<ArxivMeta | null> {
  const q = title.trim().split(/\s+/).join(" ");
  const url = `http://export.arxiv.org/api/query?search_query=ti:${quoteTitle(q)}&max_results=${maxResults}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    if (!r.ok) return null;
    return parseFirst(await r.text(), null);
  } catch {
    return null;
  }
}
