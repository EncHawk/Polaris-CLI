/**
 * Polaris MCP server — exposes the polaris agent tools over MCP so:
 *   - trueForge agents (read/research/plan/code) can call the completion tools
 *     and `search_arxiv` through trueForge's MCP tool routing
 *   - external coding agents (claude-code, codex, …) can call `polaris_run` to
 *     run the whole paper-reproduction pipeline with frontier models
 *
 * Runs as a streamable-HTTP server (Bun-compatible Web Standard transport) so it
 * works behind any MCP client. The completion tools are signal tools: their args
 * carry the agent's structured output, which the TrueForgeEngine reads from the
 * model.message event stream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchId, searchTitle } from "../tools/arxiv.ts";
import { runOne } from "../pipeline/run.ts";
import { getSettings } from "../config/settings.ts";

const SERVER_INFO = { name: "polaris", version: "0.1.0" };

export interface McpServerOptions {
  secret?: string;
}

export function createPolarisMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Polaris AI paper-reproduction pipeline. Agents call complete_* / mark_implementation_complete to submit structured output, and search_arxiv to look up citations. External agents call polaris_run to reproduce an arXiv paper end-to-end.",
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

  server.registerTool(
    "mark_implementation_complete",
    {
      description: "Call this when the implementation is fully done and working. Provide a summary of what was built.",
      inputSchema: {
        files_written: z.array(z.string()),
        summary: z.string(),
        test_results: z.string().optional(),
        caveats: z.string().optional(),
      },
    },
    async () => ({ content: [{ type: "text", text: "Implementation marked as complete." }] }),
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

  // ─── Full pipeline (for external coding agents: claude-code, codex, …) ───────
  server.registerTool(
    "polaris_run",
    {
      description:
        "Run the full Polaris paper-reproduction pipeline (READ -> RESEARCH -> PLAN -> CODE) for an arXiv paper. " +
        "Returns the final status and GitHub URL. Auto-approves the plan (non-interactive). " +
        "Requires POLARIS_API_KEY (BYOK) to be configured on the polaris CLI host.",
      inputSchema: {
        arxiv_id: z.string().describe("ArXiv paper id, e.g. 2301.12345"),
        repo_name: z.string().optional().describe("Optional target GitHub repo name"),
        execution_mode: z
          .enum(["create", "modify", "run"])
          .optional()
          .describe("create (default) = new repo; modify = edit existing; run = just run reproduce.py"),
        top_n_citations: z.number().optional().describe("Max citations the RESEARCH agent researches (default 8)"),
      },
    },
    async (args) => {
      const s = getSettings();
      if (!s.POLARIS_API_KEY) {
        return {
          isError: true,
          content: [{ type: "text", text: "POLARIS_API_KEY is not set on the polaris host (BYOK required)." }],
        };
      }
      try {
        const final = await runOne({
          arxiv_id: args.arxiv_id,
          repo_name: args.repo_name,
          execution_mode: args.execution_mode,
          top_n_citations: args.top_n_citations,
          auto_approve: true,
        });
        const code = final.code ?? {};
        const text =
          `status: ${final.status ?? "done"}\n` +
          `github_url: ${code.github_url ?? ""}\n` +
          `repo_name: ${code.repo_name ?? ""}\n` +
          (code.push_error ? `push_error: ${code.push_error}\n` : "") +
          (final.error ? `error: ${final.error}\n` : "") +
          `files: ${(code.files ?? []).map((f) => f.path).join(", ")}`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `polaris_run failed: ${(e as Error).message}` }] };
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
