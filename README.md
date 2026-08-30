# polaris-cli

A BYOK CLI tool for Polaris AI that reproduces research papers end-to-end. The agentic pipeline (READ → RESEARCH → PLAN → CODE) is ported from the Python `polaris` codebase into TypeScript and runs on Bun. The harness is [trueForge](https://trueforge.dev) — the open-source agent harness — so frontier models, sandboxing, MCP tools, and the chat UI come for free.

## Quick start

```bash
bun install
cp .env.example .env       # fill in POLARIS_API_KEY (any OpenAI-compatible endpoint)

bun ./index.ts doctor      # verify config
bun ./index.ts run 2403.09876          # run the pipeline (interactive TUI)
bun ./index.ts serve --tf              # start agent-server + trueForge (web UI + API + MCP)
```

## Commands

| Command | Description |
|---------|-------------|
| `polaris run <arxiv-id> [--auto]` | Run the pipeline with live TUI streaming. `--auto` skips plan approval. |
| `polaris serve [--tf] [--port N]` | Start the agent-server (web UI + REST API + SSE + MCP route). `--tf` boots and provisions a local trueForge harness. |
| `polaris mcp` | Run the polaris MCP server over stdio (for claude-code, codex, etc.). |
| `polaris setup [--base-url URL]` | Provision an existing trueForge server with the BYOK model + MCP + agents. |
| `polaris agent list\|run\|specs` | Manage trueForge agents. |
| `polaris doctor` | Check configuration and connectivity. |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      polaris CLI (Bun)                        │
│                                                               │
│  src/cli/index.ts        command router (run/serve/mcp/…)     │
│                                                               │
│  ┌─────────────── pipeline (ported from polaris) ──────────┐ │
│  │ READ → (gate) → RESEARCH → (gate) → PLAN → APPROVE      │ │
│  │   → CODE → (gate) → END                                  │ │
│  │                                                           │ │
│  │  agents/        system prompts + OpenAI tool defs        │ │
│  │  agents_util/   ReAct agentic loop + checkpoints         │ │
│  │  tools/         arxiv, github, sandbox (local/Daytona)   │ │
│  │  pipeline/      trace bus, graph driver, approval gate   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────── trueForge harness ───────────────────────┐ │
│  │  server.ts      local trueForge lifecycle (npx)          │ │
│  │  provision.ts   BYOK model + MCP + agents (idempotent)   │ │
│  │  agents.ts      AgentSpec manifests (read/research/…)    │ │
│  │  engine.ts      TrueForgeEngine (SDK event stream → bus) │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────── MCP server ──────────────────────────────┐ │
│  │  mcp/server.ts  completion tools + search_arxiv +        │ │
│  │                 polaris_run (for external coding agents) │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────── agent-server (Bun.serve) ────────────────┐ │
│  │  server.ts      REST API + SSE + plan approval           │ │
│  │  web/           HTML imports + React UI (Bun bundler)    │ │
│  │  tui.ts         ANSI streaming terminal UI               │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### BYOK (Bring Your Own Key)

The LLM is entirely user-provided. Set `POLARIS_API_KEY` + `POLARIS_BASE_URL` to any OpenAI-compatible endpoint (DeepInfra, OpenAI, Together, local vLLM, …). The local engine uses a minimal fetch-based client (`src/agents_util/llm.ts`); the trueForge harness provisions a custom model provider pointing at the same endpoint.

### Two execution modes

1. **Local engine** (`polaris run`) — the ported ReAct loop drives agents directly, streaming traces to the TUI. Zero infra: sandbox falls back to a tempdir, checkpoints to `~/.polaris/`.
2. **trueForge harness** (`polaris serve --tf`) — agents run as trueForge turns with sandbox-as-tool, MCP tool routing, the chat UI, and the HTTP API. trueForge manages the model loop; our `TrueForgeEngine` folds SDK events into the trace bus.

### MCP integration

The polaris MCP server (`src/mcp/server.ts`) exposes:
- **Completion tools** (`complete_read_result`, `complete_research`, `complete_plan`, `mark_implementation_complete`) — signal tools whose args carry structured output
- **`search_arxiv`** — arxiv metadata lookup for the RESEARCH agent
- **`polaris_run`** — runs the full pipeline for an arXiv ID (for external coding agents like claude-code/codex)

This means coding agents can use polaris either via trueForge's MCP routing or by spawning `polaris mcp` as a stdio subprocess.

## What was ported from `../polaris/`

| polaris (Python) | polaris-cli (TypeScript) |
|---|---|
| `worker/config.py` | `src/config/settings.ts` |
| `worker/state.py` | `src/state.ts` |
| `worker/graph.py` | `src/pipeline/graph.ts` |
| `worker/main.py` | `src/pipeline/run.ts` |
| `worker/traces.py` + `shared/trace.py` | `src/pipeline/trace.ts` |
| `worker/agents/*.py` | `src/agents/*.ts` |
| `worker/agents_util/agentic_loop.py` | `src/agents_util/loop.ts` |
| `worker/agents_util/checkpoint.py` | `src/agents_util/checkpoint.ts` |
| `worker/tools/*.py` | `src/tools/*.ts` |

## Tech stack

- **Bun** (runtime, bundler, test runner)
- **TypeScript** throughout
- **trueForge** (`@truefoundry/trueforge` + `@truefoundry/trueforge-sdk`) — agent harness
- **MCP SDK** (`@modelcontextprotocol/sdk`) — tool server
- **React** — web UI (HTML imports via Bun.serve)
