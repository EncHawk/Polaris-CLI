/**
 * polaris CLI — command router.
 *
 *   polaris run <arxiv-id>          Run the paper-reproduction pipeline (TUI)
 *   polaris run <arxiv-id> --auto   Auto-approve the plan (non-interactive)
 *   polaris serve [--tf]            Start the agent-server (web + API + MCP)
 *                                   --tf also boots + provisions trueForge
 *   polaris mcp                     Run the polaris MCP server (stdio)
 *   polaris setup                   Provision an existing trueForge server
 *   polaris agent <list|run>        Manage trueForge agents
 *   polaris doctor                  Check configuration + connectivity
 */
import { runTui } from "../server/tui.ts";
import { startServer } from "../server/server.ts";
import { createPolarisMcpServer, mcpRouteHandler } from "../mcp/server.ts";
import { getSettings } from "../config/settings.ts";
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { isTrueForgeRunning, startTrueForgeServer, type TrueForgeServer } from "../trueforge/server.ts";
import { provisionTrueForge } from "../trueforge/provision.ts";
import { POLARIS_AGENT_NAMES, polarisAgentSpecs } from "../trueforge/agents.ts";
import { extractPaperFile } from "../tools/upload.ts";
import { parseEngine, type EngineType } from "../agents_util/engine.ts";

const HELP = `Polaris AI CLI — BYOK paper-reproduction agent harness (powered by trueForge)

USAGE
  polaris <command> [args]

COMMANDS
  run <arxiv-id> [--auto] [--file <path>] [--engine local|trueforge]
                     [--reuse] [--output <dir>] [--repo <name>] [--mode create|modify|run]
                                   Run the pipeline (interactive TUI)
                                     --file     read a PDF/markdown/tex file instead of fetching by arxiv id
                                     --engine   local (BYOK ReAct loop, default) | trueforge (boots + provisions the harness)
                                     --reuse    if an existing coded implementation is found in the library, reuse it
                                     --output   directory to create the project in (default: cwd)
  serve [--tf] [--port <n>]       Start agent-server (web + API + MCP + uploads)
                                      --tf  also boot + provision trueForge
  mcp                             Run the polaris MCP server over stdio
  setup [--base-url <url>]        Provision a trueForge server (BYOK model + MCP + agents)
  agent list [--base-url <url>]   List trueForge agents
  agent run <name> [--base-url <url>]  Open a session and run one turn
  doctor                          Check config + connectivity

ENV  (see .env.example)
  POLARIS_API_KEY, POLARIS_BASE_URL, POLARIS_DEFAULT_MODEL  (BYOK LLM)
  POLARIS_PAPERS_ORG, POLARIS_PUBLISH_ORG                   (library + publish targets)
  POLARIS_PORT, POLARIS_MCP_PORT, POLARIS_TRUEFORGE_PORT    (ports)
  POLARIS_MAX_UPLOAD_MB, POLARIS_MAX_PAPER_CHARS            (upload limits)
  GITHUB_ACCESS_TOKEN, DAYTONA_API_KEY                      (optional)
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "serve":
      return cmdServe(rest);
    case "mcp":
      return cmdMcp(rest);
    case "setup":
      return cmdSetup(rest);
    case "agent":
      return cmdAgent(rest);
    case "doctor":
      return cmdDoctor(rest);
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

/** Flags that consume the next token as their value. */
const VALUE_FLAGS = new Set([
  "--file",
  "--engine",
  "--output",
  "--repo",
  "--mode",
  "--message",
  "--base-url",
  "--port",
]);

export interface ParsedArgs {
  /** Free tokens that are neither flags nor flag values. */
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

/**
 * Parse CLI args so option VALUES (e.g. the path in `--file paper.pdf`) are
 * never mistaken for the positional arXiv id.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${a}`);
      values.set(a, args[++i]!);
    } else if (a.startsWith("-")) {
      flags.add(a);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, values, flags };
}

async function cmdRun(rest: string[]): Promise<void> {
  const { positionals, values, flags } = parseArgs(rest);
  const arxivId = positionals[0];
  const auto = flags.has("--auto");
  const reuse = flags.has("--reuse");
  const file = values.get("--file");
  const output = values.get("--output");
  const repo = values.get("--repo");
  const mode = values.get("--mode");

  let engine: EngineType;
  try {
    engine = parseEngine(values.get("--engine") ?? "local");
  } catch (e) {
    console.error(`${RED}${(e as Error).message}${RESET}`);
    console.error("Usage: polaris run <arxiv-id> [--engine local|trueforge] [--auto] [--file <path>] [--reuse] [--output <dir>] [--repo <name>] [--mode create|modify|run]");
    process.exit(1);
  }

  if (!arxivId && !file) {
    console.error("Usage: polaris run <arxiv-id> [--auto] [--file <path>] [--engine local|trueforge] [--reuse] [--output <dir>] [--repo <name>] [--mode create|modify|run]");
    process.exit(1);
  }

  // The trueForge engine needs a live harness + a reachable polaris MCP
  // endpoint — boot/provision both before the pipeline starts, and tear them
  // down afterwards.
  const tfCleanup = engine === "trueforge" ? await ensureTrueForgeForRun() : null;

  try {
    let markdown: string | undefined;
    let resolvedArxivId = arxivId;
    if (file) {
      console.log(`${DIM}Extracting text from ${file}…${RESET}`);
      let result;
      try {
        result = await extractPaperFile(file);
      } catch (e) {
        console.error(`${RED}${(e as Error).message}${RESET}`);
        process.exit(1);
      }
      markdown = result.markdown;
      if (!resolvedArxivId && result.arxiv_id) resolvedArxivId = result.arxiv_id;
      console.log(`${DIM}  ${result.kind} · ${result.pages} page(s) · ${result.chars} chars · arxiv ${result.arxiv_id || "(none)"}${RESET}`);
      if (!markdown) {
        console.error(`${RED}Could not extract text from ${file}${RESET}`);
        process.exit(1);
      }
    }

    await runTui({
      arxiv_id: resolvedArxivId,
      markdown,
      engine,
      reuse_if_exists: reuse,
      output_dir: output,
      repo_name: repo,
      execution_mode: mode,
      auto_approve: auto,
    });
  } finally {
    tfCleanup?.();
  }
}

/**
 * Boot everything a `--engine trueforge` run needs:
 *   1. a standalone polaris MCP endpoint (completion + search tools) that the
 *      trueForge agents route to,
 *   2. a running trueForge harness (started locally if none is configured),
 *   3. idempotent provisioning (BYOK model provider + polaris MCP + agents).
 * Returns a cleanup function that tears down everything this helper started.
 */
async function ensureTrueForgeForRun(): Promise<() => void> {
  const s = getSettings();
  if (!s.POLARIS_API_KEY) {
    console.error(`${RED}--engine trueforge requires POLARIS_API_KEY (BYOK model provider)${RESET}`);
    process.exit(1);
  }

  // 1 ── our MCP endpoint on POLARIS_MCP_PORT
  const mcpPort = s.POLARIS_MCP_PORT;
  const mcpServer = Bun.serve({
    port: mcpPort,
    routes: { "/mcp": mcpRouteHandler(Bun.env["POLARIS_MCP_SECRET"]) },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  const mcpUrl = `http://localhost:${mcpPort}/mcp`;

  // 2 ── the harness itself
  let tfServer: TrueForgeServer | null = null;
  const baseUrl = s.TRUEFORGE_BASE_URL || `http://localhost:${s.TRUEFORGE_PORT}`;
  if (!(await isTrueForgeRunning(baseUrl))) {
    if (s.TRUEFORGE_BASE_URL) {
      mcpServer.stop(true);
      console.error(
        `${RED}trueForge is not reachable at ${s.TRUEFORGE_BASE_URL}. ` +
          `Start it (npx @truefoundry/trueforge) or unset POLARIS_TRUEFORGE_BASE_URL so polaris can boot one.${RESET}`,
      );
      process.exit(1);
    }
    console.log(`${DIM}Starting local trueForge harness on ${baseUrl} …${RESET}`);
    tfServer = await startTrueForgeServer();
  }

  // 3 ── provision (idempotent)
  try {
    const client = makeTrueForgeClient(baseUrl);
    console.log(`${DIM}Provisioning trueForge (BYOK model + polaris MCP → ${mcpUrl}) …${RESET}`);
    await provisionTrueForge(client, { mcpUrl, mcpSecret: Bun.env["POLARIS_MCP_SECRET"] });
  } catch (e) {
    tfServer?.stop();
    mcpServer.stop(true);
    throw e;
  }

  return () => {
    tfServer?.stop();
    mcpServer.stop(true);
  };
}

async function cmdServe(rest: string[]): Promise<void> {
  const startTf = hasFlag(rest, "--tf");
  const port = flag(rest, "--port") ? Number(flag(rest, "--port")) : undefined;
  await startServer({ port, startTrueForge: startTf, mcpSecret: Bun.env["POLARIS_MCP_SECRET"] });
}

async function cmdMcp(rest: string[]): Promise<void> {
  // stdio MCP server — for coding agents that spawn `polaris mcp` as a subprocess
  void rest;
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createPolarisMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // keep alive
  await new Promise(() => {});
}

async function cmdSetup(rest: string[]): Promise<void> {
  const s = getSettings();
  const baseUrl = flag(rest, "--base-url") || s.TRUEFORGE_BASE_URL || `http://localhost:${s.TRUEFORGE_PORT}`;
  if (!(await isTrueForgeRunning(baseUrl))) {
    console.error(`trueForge is not running at ${baseUrl}. Start it with:\n  npx @truefoundry/trueforge`);
    process.exit(1);
  }
  const client = makeTrueForgeClient(baseUrl);
  const mcpUrl = `${baseUrl.replace(/\/$/, "")}/mcp`;
  console.log(`Provisioning trueForge at ${baseUrl} …`);
  const result = await provisionTrueForge(client, { mcpUrl, mcpSecret: Bun.env["POLARIS_MCP_SECRET"] });
  console.log(`  ✓ model provider: ${result.providerName}`);
  console.log(`  ✓ MCP server:     ${result.mcpName} → ${mcpUrl}`);
  console.log(`  ✓ agents:         ${result.agents.map((a) => a.name).join(", ")}`);
  console.log("\nDone. Open the trueForge chat UI to use the polaris agents.");
}

async function cmdAgent(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;
  const s = getSettings();
  const { positionals, values } = parseArgs(subRest);
  const baseUrl = values.get("--base-url") || s.TRUEFORGE_BASE_URL || `http://localhost:${s.TRUEFORGE_PORT}`;
  const client = makeTrueForgeClient(baseUrl);

  if (sub === "list") {
    const { data } = await client.agents.list();
    console.log(`${data.length} agent(s):`);
    for (const a of data) {
      console.log(`  ${a.name}  ${DIM}${a.manifest.model.name}${RESET}`);
    }
    return;
  }

  if (sub === "run") {
    const name = positionals[0];
    const message = values.get("--message") ?? "Hello";
    if (!name) {
      console.error("Usage: polaris agent run <name> [--message <text>]");
      process.exit(1);
    }
    const { data: session } = await client.sessions.create({ agent: { name } });
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: message }],
    });
    for await (const { data: event } of stream.withMetadata()) {
      if (event.type === "model.message.delta") process.stdout.write(event.content ?? "");
      if (event.type === "turn.done") {
        console.log(`\n\nstatus: ${event.state.status}`);
      }
    }
    return;
  }

  if (sub === "specs") {
    const specs = polarisAgentSpecs();
    for (const [k, spec] of Object.entries(specs)) {
      console.log(`\n=== polaris-${k} ===\n${JSON.stringify(spec, null, 2)}`);
    }
    console.log(`\nAgent names: ${POLARIS_AGENT_NAMES.join(", ")}`);
    return;
  }

  console.error(`Usage: polaris agent <list|run|specs>`);
  process.exit(1);
}

async function cmdDoctor(rest: string[]): Promise<void> {
  void rest;
  const s = getSettings();
  console.log(`${BOLD}Polaris doctor${RESET}\n`);

  // BYOK LLM
  const llmOk = !!s.POLARIS_API_KEY;
  console.log(`  ${llmOk ? GREEN + "✓" : RED + "✗"}${RESET} BYOK LLM key ${DIM}(${s.POLARIS_BASE_URL})${RESET}`);
  if (llmOk) console.log(`    ${DIM}default model: ${s.POLARIS_DEFAULT_MODEL}${RESET}`);

  // GitHub
  const ghOk = !!s.GITHUB_ACCESS_TOKEN;
  console.log(`  ${ghOk ? GREEN + "✓" : YELLOW + "○"}${RESET} GitHub publishing ${DIM}(optional)${RESET}`);

  // Output dir
  const outDir = s.POLARIS_OUTPUT_DIR || process.cwd();
  console.log(`  ${GREEN}✓${RESET} Output directory ${DIM}${outDir}${RESET}`);

  // trueForge
  const tfBaseUrl = s.TRUEFORGE_BASE_URL || `http://localhost:${s.TRUEFORGE_PORT}`;
  const tfRunning = await isTrueForgeRunning(tfBaseUrl);
  console.log(`  ${tfRunning ? GREEN + "✓" : YELLOW + "○"}${RESET} trueForge at ${tfBaseUrl} ${DIM}(${tfRunning ? "running" : "not running — use `polaris serve --tf`"})${RESET}`);

  // MCP server
  console.log(`  ${GREEN}✓${RESET} MCP server available ${DIM}(polaris mcp / polaris serve)${RESET}`);

  // Paper library
  const papersOrg = s.POLARIS_PAPERS_ORG;
  const papersAuth = s.POLARIS_PAPERS_TOKEN ? `${GREEN}✓${RESET}` : `${YELLOW}○${RESET}`;
  console.log(`  ${papersAuth} Paper library ${DIM}github.com/${papersOrg} (search/get_polaris_implementation MCP tools)${RESET}`);
  if (!s.POLARIS_PAPERS_TOKEN) {
    console.log(`    ${DIM}anonymous GitHub rate-limited — set GITHUB_ACCESS_TOKEN for reliable library search${RESET}`);
  }

  const allOk = llmOk;
  console.log(`\n  ${allOk ? GREEN + BOLD + "Ready." : RED + BOLD + "Missing BYOK LLM key — set POLARIS_API_KEY in .env"}${RESET}\n`);
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
