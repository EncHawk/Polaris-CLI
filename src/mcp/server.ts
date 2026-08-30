/**
 * Polaris MCP server — **broker for document extraction** (READ → RESEARCH → PLAN).
 * TrueForge is the forced harness; the MCP is only a broker so an external
 * model can delegate paper extraction + planning to Polaris.
 *
 * Exposed tools (intentionally limited to READ/PLAN):
 *   - complete_read_result / complete_research / complete_plan  (signal tools for TrueForge agents)
 *   - search_arxiv                                            (citation lookup for RESEARCH)
 *   - polaris_extract                                         (broker: extracts READ + PLAN via TrueForge)
 *
 * CODE / VERIFY and the full `polaris_run` pipeline are **not** exposed —
 * the calling model does the implementation itself after receiving the plan.
 * This keeps the MCP surface minimal and lets the user's own agent handle CODE.
 *
 * Runs as a streamable-HTTP server (Bun-compatible Web Standard transport) so it
 * works behind any MCP client.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchId, searchTitle } from "../tools/arxiv.ts";
import { runExtraction } from "../pipeline/run.ts";
import { getSettings } from "../config/settings.ts";
import { extractPaperText } from "../tools/upload.ts";

const SERVER_INFO = { name: "polaris", version: "0.1.0" };

export interface McpServerOptions {
  secret?: string;
}

export function createPolarisMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Polaris AI extraction broker (READ → RESEARCH → PLAN via TrueForge). Agents call complete_read_result / complete_research / complete_plan to submit structured output and search_arxiv for citation metadata. External models call polaris_extract to delegate document extraction + planning to Polaris (TrueForge harness) and then implement CODE themselves.",
  });

  // ─── Completion signal tools (args carry the structured output) ──────────────
  server.registerTool(
    "complete_read_result",
    {
      description: "Call this with your complete READ analysis of the paper. Once called, the READ phase is done.",
      inputSchema: {
        aim: z.string().describe("What does the paper aim to solve?"),
        built_on: z.string().describe("Prior work / base method they built on top of"),
        experiments: z
          .array(z.object({ name: z.string(), what_yielded: z.string() }))
          .describe("Experiments / ablation studies and what each yielded"),
        novel_approach: z
          .object({
            description: z.string(),
            codeable: z.boolean().describe("Whether the approach is implementable in code"),
          })
          .describe("The novel approach introduced"),
        numbers: z
          .array(z.object({ claim: z.string(), value: z.string() }))
          .describe("Improvements (or demotions) proposed in the paper"),
        relevant_citations: z
          .array(z.object({ arxiv_id: z.string(), why_relevant: z.string() }))
          .describe("Most relevant citations with arxiv_id if known"),
        output_query: z.string().describe("One sentence summary of what was found"),
      },
    },
    async () => ({ content: [{ type: "text", text: "Read result recorded. The READ phase is complete." }] }),
  );

  server.registerTool(
    "complete_research",
    {
      description: "Call this when you have analyzed all citations. Submits the final research results.",
      inputSchema: {
        citations: z
          .array(
            z.object({
              arxiv_id: z.string(),
              what_it_claims: z.string(),
              how_used: z.string(),
            }),
          )
          .describe("Citation analyses"),
        output_query: z.string().describe("One sentence summary of the research findings"),
      },
    },
    async () => ({ content: [{ type: "text", text: "Research results recorded." }] }),
  );

  server.registerTool(
    "complete_plan",
    {
      description: "Call this with your final plan for the CODE agent. Once called, the PLAN phase is complete.",
      inputSchema: {
        intends_to_prove: z.string(),
        proof_method: z.string(),
        researched_usage: z.string(),
        deltas_from_base: z.array(z.string()),
        custom_kernels: z
          .object({ description: z.string(), details: z.string() })
          .nullable()
          .describe("Custom CUDA kernel details if any"),
        plan: z.array(z.string()).describe("Ordered todo-list of files to build (each file does one thing)"),
        output_query: z.string(),
      },
    },
    async () => ({ content: [{ type: "text", text: "Plan recorded. The plan is ready for user approval." }] }),
  );

  // ─── arxiv lookup (used by the RESEARCH agent) ───────────────────────────────
  server.registerTool(
    "search_arxiv",
    {
      description: "Look up an arxiv paper by ID or title to get its abstract and metadata.",
      inputSchema: {
        arxiv_id: z.string().optional().describe("Arxiv ID (e.g. 2301.12345)"),
        title: z.string().optional().describe("Paper title to search by (if arxiv_id is unknown)"),
      },
    },
    async (args) => {
      const aid = args.arxiv_id ?? "";
      const title = args.title ?? "";
      if (aid) {
        const meta = await searchId(aid);
        if (meta) return { content: [{ type: "text", text: JSON.stringify(meta) }] };
      }
      if (title) {
        const meta = await searchTitle(title);
        if (meta) return { content: [{ type: "text", text: JSON.stringify(meta) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ arxiv_id: aid, title: "", abstract: "Not found" }) }] };
    },
  );

  // ─── Broker: document extraction + planning via TrueForge ───────────────────
  // The user's own agent calls this to delegate READ → RESEARCH → PLAN to Polaris.
  // It runs the harness (forced TrueForge) up to PLAN and returns the structured
  // extraction so the model can do CODE itself. This is the only "run" tool
  // exposed externally — CODE/VERIFY are intentionally not brokered.
  server.registerTool(
    "polaris_extract",
    {
      description:
        "Broker document extraction via Polaris (TrueForge harness). " +
        "Takes an arXiv ID or raw paper markdown (or base64 PDF) and runs the Polaris READ → RESEARCH → PLAN pipeline on TrueForge, returning the structured extraction (aim, novel approach, experiments, citations, deltas, and the code plan). " +
        "The calling model then implements CODE itself. This is the sole extraction entrypoint; Polaris does not expose CODE/VERIFY over MCP.",
      inputSchema: {
        arxiv_id: z.string().optional().describe("ArXiv paper id, e.g. 2301.12345 (required if markdown not given)"),
        markdown: z.string().optional().describe("Paper text as markdown (e.g. extracted from PDF). Pass instead of arxiv_id."),
        pdf_base64: z.string().optional().describe("Raw PDF as base64 (alternative to markdown) — server will extract text"),
        top_n_citations: z.number().optional().describe("Max citations to research (default 8)"),
      },
    },
    async (args) => {
      const s = getSettings();
      if (!s.POLARIS_API_KEY) {
        return {
          isError: true,
          content: [{ type: "text", text: "POLARIS_API_KEY is not set on the Polaris host (BYOK required)." }],
        };
      }
      if (!args.arxiv_id && !args.markdown && !args.pdf_base64) {
        return { isError: true, content: [{ type: "text", text: "Provide either arxiv_id, markdown, or pdf_base64." }] };
      }
      try {
        let markdown = args.markdown;
        if (!markdown && args.pdf_base64) {
          const buf = Buffer.from(args.pdf_base64, "base64");
          const extracted = await extractPaperText("paper.pdf", buf);
          markdown = extracted.markdown;
        }
        const final = await runExtraction({
          arxiv_id: args.arxiv_id,
          markdown,
          engine: "trueforge",
          top_n_citations: args.top_n_citations,
          auto_approve: true,
        } as any);
        const out = {
          status: final.status,
          arxiv_id: final.arxiv_id,
          read: final.read,
          research: final.research,
          plan: final.plan,
          error: final.error ?? undefined,
          // Explicitly omit code/verify — caller does those via its own harness
        };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `polaris_extract failed: ${(e as Error).message}` }] };
      }
    },
  );

  void opts;
  return server;
}

/**
 * Mount the polaris MCP server on a Bun.serve route map. Returns the route
 * handler for `/mcp`. Stateless mode: each request gets a fresh server +
 * transport bound together (our tools are stateless functions, so no sticky
 * sessions are needed).
 */
export function mcpRouteHandler(secret?: string): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (secret) {
      const provided = req.headers.get("x-polaris-secret");
      if (provided !== secret) return new Response("Unauthorized", { status: 401 });
    }
    const server = createPolarisMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    await server.close();
    return res;
  };
}
