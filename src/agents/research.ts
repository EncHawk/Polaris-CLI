import type { ToolDef, ToolArgs, ToolHandlers, ChatMessage } from "./types.ts";
import type { WorkerState, ResearchOutput, ResearchCitation, RelevantCitation } from "../state.ts";
import { markAgentRun } from "../state.ts";
import { status } from "../pipeline/trace.ts";
import { runAgentTurn, type EngineType } from "../agents_util/engine.ts";
import { getSettings } from "../config/settings.ts";
import { searchId, searchTitle } from "../tools/arxiv.ts";
import { searchPolarisPapers } from "../tools/papers.ts";

export const RESEARCH_SYSTEM_PROMPT = `You are the RESEARCH agent for an automated paper-reproduction pipeline.
The READ agent has already extracted a list of relevant citations from the paper.

Your job:
1. For each citation, use the \`search_arxiv\` tool to fetch its abstract and metadata.
2. Check whether a citation already has a coded implementation in the Polaris library using \`search_polaris_papers\` (pass the citation's arxiv_id). If one exists, note its repo_name and GitHub URL in how_used so the CODE agent can reuse it.
3. Analyze what each citation claims and how the main paper uses it.
4. When you have analyzed ALL citations, call \`complete_research\` with your findings.

Be thorough but concise. Cover every citation the READ agent surfaced.
If a citation lacks an arxiv_id, try searching by title.`;

export const RESEARCH_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_arxiv",
      description: "Look up an arxiv paper by ID or title to get its abstract and metadata.",
      parameters: {
        type: "object",
        properties: {
          arxiv_id: { type: "string", description: "Arxiv ID (e.g. 2301.12345)" },
          title: { type: "string", description: "Paper title to search by (if arxiv_id is unknown)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_polaris_papers",
      description:
        "Search the Polaris coded-implementation library for an existing reproduction of a paper. " +
        "Pass a citation's arxiv_id to check if it already has a coded implementation that the CODE agent can reuse.",
      parameters: {
        type: "object",
        properties: {
          arxiv_id: { type: "string", description: "ArXiv ID to look up directly" },
          query: { type: "string", description: "Free-text search over repo names and descriptions" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_research",
      description: "Call this when you have analyzed all citations. Submits the final research results.",
      parameters: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                arxiv_id: { type: "string" },
                what_it_claims: { type: "string", description: "What the cited paper does and claims" },
                how_used: { type: "string", description: "How the main paper uses this citation (note any existing Polaris implementation repo_name/url here)" },
              },
            },
          },
          output_query: { type: "string", description: "One sentence summary of the research findings" },
        },
        required: ["citations", "output_query"],
      },
    },
  },
];

export async function runResearch(state: WorkerState): Promise<Partial<WorkerState>> {
  const jobUuid = state.job_uuid;
  const runs = markAgentRun(state, "RESEARCH");
  status(jobUuid, "research");

  const read = state.read ?? {};
  let cits: RelevantCitation[] = read.relevant_citations ?? [];
  const s = getSettings();
  const topN = state.top_n_citations ?? s.ARXIV_MAX_CITATIONS;
  cits = cits.slice(0, Math.min(topN, s.ARXIV_MAX_CITATIONS));

  const citationsContext = JSON.stringify(cits, null, 2).slice(0, 20000);
  const novel = JSON.stringify(read.novel_approach ?? {}).slice(0, 2000);
  const aim = String(read.aim ?? "").slice(0, 2000);

  let data: ToolArgs | null = null;
  const handlers: ToolHandlers = {
    search_arxiv: async (args: ToolArgs) => {
      const aid = String(args["arxiv_id"] ?? "");
      const title = String(args["title"] ?? "");
      if (aid) {
        const meta = await searchId(aid);
        if (meta) return JSON.stringify(meta);
      }
      if (title) {
        const meta = await searchTitle(title);
        if (meta) return JSON.stringify(meta);
      }
      return JSON.stringify({ arxiv_id: aid, title: "", abstract: "Not found" });
    },
    search_polaris_papers: async (args: ToolArgs) => {
      try {
        const matches = await searchPolarisPapers({
          arxiv_id: args["arxiv_id"] ? String(args["arxiv_id"]) : undefined,
          query: args["query"] ? String(args["query"]) : undefined,
          limit: 5,
        });
        if (matches.length === 0) {
          return JSON.stringify({ found: 0, message: "No existing coded implementation for this paper." });
        }
        return JSON.stringify({
          found: matches.length,
          implementations: matches.map((m) => ({
            arxiv_id: m.arxiv_id,
            repo_name: m.repo_name,
            html_url: m.html_url,
            description: m.description,
          })),
        });
      } catch (e) {
        return JSON.stringify({ found: 0, error: (e as Error).message });
      }
    },
    complete_research: async (args: ToolArgs) => {
      data = args;
      return "Research results recorded.";
    },
  };

  const userMessage =
    `MAIN PAPER AIM:\n${aim}\n\n` +
    `MAIN PAPER NOVEL APPROACH:\n${novel}\n\n` +
    `CITATIONS TO RESEARCH:\n${citationsContext}\n\n` +
    `Search arxiv for each citation and analyze what it claims and how the main paper uses it.`;

  const conversationHistory: ChatMessage[] = [];
  if (state.orchestrator_feedback) {
    conversationHistory.push({
      role: "user",
      content: `ORCHESTRATOR FEEDBACK on your previous run:\n${state.orchestrator_feedback}\n\nComplete your research now — analyze all citations and call complete_research.`,
    });
  }

  const result = await runAgentTurn({
    agentName: "RESEARCH",
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    userMessage,
    tools: RESEARCH_TOOLS,
    toolHandlers: handlers,
    jobUuid,
    agentEnum: "RESEARCH",
    maxTokens: s.AGENT_MAX_STEPS * 4096,
    conversationHistory,
    engine: (state.engine as EngineType) ?? "trueforge",
  });
  data = result.structured;

  const notes: ResearchCitation[] = [];
  if (data) {
    const d = data as Record<string, unknown>;
    for (const n of (d["citations"] as Array<Record<string, unknown>>) ?? []) {
      notes.push({
        arxiv_id: String(n["arxiv_id"] ?? ""),
        what_it_claims: String(n["what_it_claims"] ?? ""),
        how_used: String(n["how_used"] ?? ""),
      });
    }
  }

  if (notes.length === 0 && cits.length) {
    for (const c of cits) {
      notes.push({ arxiv_id: c.arxiv_id, what_it_claims: "citation analysis unavailable", how_used: "" });
    }
  }

  const research: ResearchOutput = {
    citations: notes,
    ready: notes.length > 0,
    output_query: data
      ? String((data as Record<string, unknown>)["output_query"] ?? "research complete")
      : "research produced no output",
  };
  return { research, runs };
}
