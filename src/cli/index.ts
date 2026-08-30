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
import { createPolarisMcpServer } from "../mcp/server.ts";
import { getSettings } from "../config/settings.ts";
import { makeTrueForgeClient } from "../trueforge/client.ts";
import { isTrueForgeRunning } from "../trueforge/server.ts";
import { provisionTrueForge } from "../trueforge/provision.ts";
import { POLARIS_AGENT_NAMES, polarisAgentSpecs } from "../trueforge/agents.ts";

const HELP = `Polaris AI CLI — BYOK paper-reproduction agent harness (powered by trueForge)

USAGE
  polaris <command> [args]

COMMANDS
  run <arxiv-id> [--auto] [--repo <name>] [--mode create|modify|run]
                                  Run the pipeline (interactive TUI)
  serve [--tf] [--port <n>]       Start agent-server (web + API + MCP)
                                    --tf  also boot + provision trueForge
  mcp                             Run the polaris MCP server over stdio
  setup [--base-url <url>]        Provision a trueForge server (BYOK model + MCP + agents)
  agent list [--base-url <url>]   List trueForge agents
  agent run <name> [--base-url <url>]  Open a session and run one turn
  doctor                          Check config + connectivity

ENV  (see .env.example)
  POLARIS_API_KEY, POLARIS_BASE_URL, POLARIS_DEFAULT_MODEL  (BYOK LLM)
  POLARIS_TRUEFORGE_PORT, POLARIS_TRUEFORGE_BASE_URL        (harness)
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

async function cmdRun(rest: string[]): Promise<void> {
  const arxivId = rest.find((a) => !a.startsWith("-"));
  if (!arxivId) {
    console.error("Usage: polaris run <arxiv-id> [--auto] [--repo <name>] [--mode create|modify|run]");
    process.exit(1);
  }
  const auto = hasFlag(rest, "--auto");
  const repo = flag(rest, "--repo");
  const mode = flag(rest, "--mode");
  await runTui({ arxiv_id: arxivId, repo_name: repo, execution_mode: mode, auto_approve: auto });
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
  const baseUrl = flag(rest, "--base-url") ?? s.TRUEFORGE_BASE_URL ?? `http://localhost:${s.TRUEFORGE_PORT}`;
  if (!(await isTrueForgeRunning(baseUrl))) {
    console.error(`trueForge is not running at ${baseUrl}. Start it with:\n  npx @truefoundry/trueforge`);
    process.exit(1);
  }
  const client = makeTrueForgeClient(baseUrl);
  const mcpUrl = baseUrl.endsWith(":8790") || baseUrl.includes(":8791")
    ? `${baseUrl}/mcp`
    : `${baseUrl}/mcp`;
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
  const baseUrl = flag(subRest, "--base-url") ?? s.TRUEFORGE_BASE_URL ?? `http://localhost:${s.TRUEFORGE_PORT}`;
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
    const name = subRest.find((a) => !a.startsWith("-"));
    const message = flag(subRest, "--message") ?? "Hello";
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

  // Daytona
  const dayOk = !!s.DAYTONA_API_KEY;
  console.log(`  ${dayOk ? GREEN + "✓" : YELLOW + "○"}${RESET} Daytona sandbox ${DIM}(optional, local tempdir fallback)${RESET}`);

  // trueForge
  const tfBaseUrl = s.TRUEFORGE_BASE_URL ?? `http://localhost:${s.TRUEFORGE_PORT}`;
  const tfRunning = await isTrueForgeRunning(tfBaseUrl);
  console.log(`  ${tfRunning ? GREEN + "✓" : YELLOW + "○"}${RESET} trueForge at ${tfBaseUrl} ${DIM}(${tfRunning ? "running" : "not running — use `polaris serve --tf`"})${RESET}`);

  // MCP server
  console.log(`  ${GREEN}✓${RESET} MCP server available ${DIM}(polaris mcp / polaris serve)${RESET}`);

  const allOk = llmOk;
  console.log(`\n  ${allOk ? GREEN + BOLD + "Ready." : RED + BOLD + "Missing BYOK LLM key — set POLARIS_API_KEY in .env"}${RESET}\n`);
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
