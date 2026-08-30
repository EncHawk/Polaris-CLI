/**
 * Cloudflare Worker entry for Polaris MCP — bare tools only (no TrueForge).
 * Host this at POLARIS_MCP_PUBLIC_URL for remote TrueForge harnesses.
 * Uses WebStandard transport so it works on Workers (no Bun APIs).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchId, searchTitle } from "../tools/arxiv.ts";

function createWorkerMcp() {
  const server = new McpServer(
    { name: "polaris", version: "0.1.0" },
    { instructions: "Polaris MCP (Worker) — completion signals + arxiv lookup. No polaris_extract (TrueForge required)." },
  );

  server.registerTool(
    "complete_read_result",
    {
      description: "Call this with your complete READ analysis of the paper. Once called, the READ phase is done.",
      inputSchema: {
        aim: z.string().describe("What does the paper aim to solve?"),
        built_on: z.string().describe("Prior work / base method they built on top of"),
        experiments: z.array(z.object({ name: z.string(), what_yielded: z.string() })).describe("Experiments / ablation studies and what each yielded"),
        novel_approach: z.object({ description: z.string(), codeable: z.boolean().describe("Whether the approach is implementable in code") }).describe("The novel approach introduced"),
        numbers: z.array(z.object({ claim: z.string(), value: z.string() })).describe("Improvements (or demotions) proposed in the paper"),
        relevant_citations: z.array(z.object({ arxiv_id: z.string(), why_relevant: z.string() })).describe("Most relevant citations with arxiv_id if known"),
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
        citations: z.array(z.object({ arxiv_id: z.string(), what_it_claims: z.string(), how_used: z.string() })).describe("Citation analyses"),
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
        custom_kernels: z.object({ description: z.string(), details: z.string() }).nullable().describe("Custom CUDA kernel details if any"),
        plan: z.array(z.string()).describe("Ordered todo-list of files to build (each file does one thing)"),
        output_query: z.string(),
      },
    },
    async () => ({ content: [{ type: "text", text: "Plan recorded. The plan is ready for user approval." }] }),
  );

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
      const aid = (args as any).arxiv_id ?? "";
      const title = (args as any).title ?? "";
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

  return server;
}

export default {
  async fetch(req: Request, env: Record<string, string>): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const secret = (env as any).POLARIS_MCP_SECRET ?? "";
    if (secret) {
      const provided = req.headers.get("x-polaris-secret");
      if (provided !== secret) return new Response("Unauthorized", { status: 401 });
    }
    const server = createWorkerMcp();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    await server.close();
    return res;
  },
};
