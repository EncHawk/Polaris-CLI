# polaris-cli — dev notes

## Build log

Ported the full polaris paper-reproduction pipeline (Python/LangGraph → TypeScript/Bun) and wrapped it in a BYOK CLI powered by trueForge.

### Done

- **Config + state**: `src/config/settings.ts` (BYOK env, per-agent models), `src/state.ts` (WorkerState + output types)
- **Agents**: read/research/plan/code/orchestrator — system prompts + OpenAI tool defs + run functions (`src/agents/`)
- **Agentic loop**: ReAct loop with streaming, tool execution, forced completion at max iterations (`src/agents_util/loop.ts`)
- **LLM client**: minimal fetch-based OpenAI-compatible client, no SDK dep (`src/agents_util/llm.ts`)
- **Checkpoints**: local JSON persistence + optional Supabase mirror (`src/agents_util/checkpoint.ts`)
- **Tools**: arxiv (Atom API regex parser), github (REST ensure/create), sandbox (local tempdir fallback + Daytona stub) (`src/tools/`)
- **Pipeline**: trace bus (in-process pub/sub + history replay), graph driver (READ→RESEARCH→PLAN→approve→CODE with orchestrator gates + dedup + force-advance), runner (`src/pipeline/`)
- **Approval gate**: async promise-based (replaces Redis BLPOP) — TUI/web resolve it (`src/pipeline/approval.ts`)
- **trueForge harness**: server lifecycle (boots `npx trueforge` standalone), idempotent provisioning (BYOK custom model provider + polaris MCP server + 4 agents), TrueForgeEngine (SDK event stream → trace bus) (`src/trueforge/`)
- **MCP server**: completion tools + search_arxiv + polaris_run, streamable-HTTP + stdio transports (`src/mcp/server.ts`)
- **Agent-server**: Bun.serve with REST API, SSE trace stream, plan approval, web UI (HTML imports + React), MCP route (`src/server/`)
- **TUI**: ANSI streaming with inline plan approval (`src/server/tui.ts`)
- **CLI**: run/serve/mcp/setup/agent/doctor commands (`src/cli/index.ts`, `index.ts`)

### Verified

- `bunx tsc --noEmit` — clean
- `bun test` — 7/7 pass
- `polaris doctor` — config check works
- `polaris mcp` — MCP initialize + tools/list handshake works over stdio
- `polaris serve` — web page served (Bun bundler transpiles React), API endpoints work
- `polaris serve --tf` — trueForge boots, provisions model provider + MCP + all 4 agents (verified via API)

### Not yet wired

- `TrueForgeEngine.runTrueForgeAgentTurn` is implemented but not yet wired into the graph driver as an alternative to the local loop. To use it: swap `runAgenticCall` for `runTrueForgeAgentTurn` in each agent's run function when a trueForge server is available.
- Daytona REST exec in the local sandbox — currently stubbed; managed Daytona comes via trueForge's sandbox-as-tool when using `polaris serve --tf`.
- Usage/billing reporting (polaris `usage.py`) — not ported (BYOK = user pays their provider directly).

### Key design decisions

1. **Two engines, one pipeline**: the graph/agents are engine-agnostic. The local ReAct loop (`loop.ts`) and the trueForge engine (`engine.ts`) both consume the same prompts + tool defs and emit to the same trace bus.
2. **MCP as the tool layer**: completion tools are MCP tools, so trueForge agents and external coding agents share the same tool surface.
3. **Zero-infra default**: no Redis, no Supabase, no Daytona required. Tempdir sandbox + local checkpoints + in-process trace bus. Add creds to upgrade.
4. **Bun-native**: `Bun.serve` (routes + HTML imports), `Bun.spawn` (exec), `Bun.file` (IO), `bun test`. No express, no vite, no jest.
