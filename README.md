# polaris-cli

A BYOK CLI tool for Polaris AI that reproduces research papers end-to-end. The agentic pipeline (READ → RESEARCH → PLAN → CODE) is ported from the Python `polaris` codebase into TypeScript and runs on Bun. The harness is [trueForge](https://trueforge.dev) — the open-source agent harness — so frontier models, sandboxing, MCP tools, and the chat UI come for free.

## Quick start

```bash
bun install
cp .env.example .env       # fill in POLARIS_API_KEY (any OpenAI-compatible endpoint)

bun ./index.ts doctor      # verify config
bun ./index.ts run 2403.09876          # run the pipeline (interactive TUI)
bun ./index.ts run --file paper.pdf --engine local   # reproduce from an uploaded PDF
bun ./index.ts serve --tf              # start agent-server + trueForge (web UI + API + MCP + uploads)
```

## Commands

| Command | Description |
|---------|-------------|
| `polaris run <arxiv-id> [--auto] [--file <path>] [--engine local\|trueforge] [--reuse]` | Run the pipeline with live TUI streaming. `--file` reads a PDF/markdown/tex file; `--engine` picks the BYOK ReAct loop or trueForge harness; `--reuse` returns an existing library implementation if one exists. `--auto` skips plan approval. |
| `polaris serve [--tf] [--port N]` | Start the agent-server (web UI + REST API + SSE + MCP route + file uploads). `--tf` boots and provisions a local trueForge harness. |
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
│  │                 Pipeline view + Library browser          │ │
│  │  tui.ts         ANSI streaming terminal UI               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────── paper library (Phase 2) ─────────────────┐ │
│  │  tools/papers.ts  PolarisAI-Implementations retrieval    │ │
│  │                   (list/search by arxiv id or topic,     │ │
│  │                    file tree + source contents)          │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### BYOK (Bring Your Own Key)

The LLM is entirely user-provided. Set `POLARIS_API_KEY` + `POLARIS_BASE_URL` to any OpenAI-compatible endpoint (DeepInfra, OpenAI, Together, local vLLM, …). The local engine uses a minimal fetch-based client (`src/agents_util/llm.ts`); the trueForge harness provisions a custom model provider pointing at the same endpoint.

### Two execution modes

1. **Local engine** (`polaris run`, `--engine local`) — the ported ReAct loop drives agents directly, streaming traces to the TUI. The CODE agent writes files directly to a project directory on your filesystem (`./paper-YYMM-NNNNN/` by default, or `POLARIS_OUTPUT_DIR`). No sandbox, no cloud infra — fully standalone.
2. **trueForge harness** (`polaris serve --tf`, `--engine trueforge`) — agents run as trueForge turns with sandbox-as-tool, MCP tool routing, the chat UI, and the HTTP API. trueForge manages the model loop; our `TrueForgeEngine` folds SDK events into the trace bus.

The engine choice is per-run: the CLI `--engine` flag, the web UI engine selector, and the MCP `polaris_run` tool's `engine` arg all route through a single dispatcher (`src/agents_util/engine.ts`).

### Library-first flow

Every run checks the [PolarisAI-Implementations](https://github.com/PolarisAI-Implementations) library for an existing coded reproduction **before** generating:

1. **Input** — an arXiv ID, an uploaded file (PDF/markdown/LaTeX), or inline markdown. PDFs are parsed with `unpdf`; an arXiv ID is extracted from the text when present.
2. **Library check** — searches the library by arXiv ID (direct repo lookup) or by paper title (GitHub search API). If a reproduction exists and `reuse_if_exists` is set, the run returns the existing GitHub repo immediately. Otherwise the hit is recorded so the CODE agent can reuse it.
3. **Generate** — if no implementation is found (or reuse is off), the full READ → RESEARCH → PLAN → CODE pipeline runs. The RESEARCH agent also queries the library per-citation so PLAN/CODE know which cited papers already have reusable code.
4. **Push to GitHub** — the CODE agent pushes the generated implementation to `POLARIS_PUBLISH_ORG` (defaults to the library org, so new reproductions join the library and become retrievable by future runs). Repo names follow the `paper-YYMM-NNNNN` convention.

### MCP integration

The polaris MCP server (`src/mcp/server.ts`) exposes:
- **Completion tools** (`complete_read_result`, `complete_research`, `complete_plan`, `mark_implementation_complete`) — signal tools whose args carry structured output
- **`search_arxiv`** — arxiv metadata lookup for the RESEARCH agent
- **`search_polaris_papers`** — search the [PolarisAI-Implementations](https://github.com/PolarisAI-Implementations) library for an existing coded reproduction by arXiv ID or topic query (indexes repo names, descriptions, and READMEs)
- **`get_polaris_implementation`** — retrieve the full file tree + source contents of a coded implementation so coding agents can reuse it instead of starting from scratch
- **`polaris_run`** — runs the full pipeline for an arXiv ID (for external coding agents like claude-code/codex)

This means coding agents can use polaris either via trueForge's MCP routing or by spawning `polaris mcp` as a stdio subprocess. The RESEARCH agent also queries the library so the PLAN/CODE agents know when a citation already has a reusable implementation.

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
