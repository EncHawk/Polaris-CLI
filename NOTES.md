# polaris-cli — dev notes

## Build log

Ported the full polaris paper-reproduction pipeline (Python/LangGraph → TypeScript/Bun) and wrapped it in a BYOK CLI powered by trueForge.

### Done

- **Config + state**: `src/config/settings.ts` (BYOK env, per-agent models), `src/state.ts` (WorkerState + output types)
- **Agents**: read/research/plan/code/orchestrator — system prompts + OpenAI tool defs + run functions (`src/agents/`)
- **Agentic loop**: ReAct loop with streaming, tool execution, forced completion at max iterations (`src/agents_util/loop.ts`)
- **LLM client**: minimal fetch-based OpenAI-compatible client, no SDK dep (`src/agents_util/llm.ts`)
- **Checkpoints**: local JSON persistence (`src/agents_util/checkpoint.ts`)
- **Tools**: arxiv (Atom API regex parser), github (REST ensure/create), workspace (writes directly to the client's filesystem — no sandbox, no tempdir, no cleanup) (`src/tools/`)
- **Pipeline**: trace bus (in-process pub/sub + history replay), graph driver (READ→RESEARCH→PLAN→approve→CODE with orchestrator gates + dedup + force-advance), runner (`src/pipeline/`)
- **Approval gate**: async promise-based (replaces Redis BLPOP) — TUI/web resolve it (`src/pipeline/approval.ts`)
- **trueForge harness**: server lifecycle (boots `npx trueforge` standalone), idempotent provisioning (BYOK custom model provider + polaris MCP server + 4 agents), TrueForgeEngine (SDK event stream → trace bus) (`src/trueforge/`)
- **MCP server**: completion tools + search_arxiv + polaris_run, streamable-HTTP + stdio transports (`src/mcp/server.ts`)
- **Agent-server**: Bun.serve with REST API, SSE trace stream, plan approval, web UI (HTML imports + React), MCP route (`src/server/`)
- **TUI**: ANSI streaming with inline plan approval (`src/server/tui.ts`)
- **CLI**: run/serve/mcp/setup/agent/doctor commands (`src/cli/index.ts`, `index.ts`)

#### Phase 2 — paper-retrieval MCP + better interface + file uploads

- **Paper library tool**: `src/tools/papers.ts` — read-only retrieval over the PolarisAI-Implementations GitHub org (`paper-YYMM-NNNNN` repos). `searchPolarisPapers` (direct arxiv-id lookup or GitHub search-API query over names/descriptions/READMEs, with local-rank fallback), `getImplementation` (recursive file tree + decoded source contents), `getImplementationFile` (single file).
- **MCP paper tools**: `search_polaris_papers` + `get_polaris_implementation` registered on the polaris MCP server so coding agents (claude-code, codex) and trueForge agents can retrieve an existing coded implementation instead of writing from scratch.
- **File uploads**: `src/tools/upload.ts` — `extractPaperText` parses PDFs (via `unpdf`/pdf.js), decodes markdown/txt/latex directly, extracts an arxiv id + title from the text, and `findExistingImplementation` does the library-first check. Wired into the server (`POST /api/run` multipart, `POST /api/upload` preview), the CLI (`polaris run --file path/to/paper.pdf`), and the MCP `polaris_run` tool (`markdown` arg).
- **Engine choice**: `src/agents_util/engine.ts` — `runAgentTurn` dispatcher routes each agent turn to the local BYOK ReAct loop or the trueForge harness (`engine: "local" | "trueforge"`). All 4 agents updated to use it. The CLI `--engine` flag, web UI selector, and MCP `polaris_run` `engine` arg all feed the same dispatcher. The trueForge path was already implemented in `engine.ts` but unwired — now wired.
- **Library-first flow**: `runOne` searches the library before generating. If found + `reuse_if_exists`, short-circuits and returns the existing repo. Otherwise records the hit in `state.library_hit` so CODE can reuse it. Generated implementations push to `POLARIS_PUBLISH_ORG` (defaults to the library org) with `paper-YYMM-NNNNN` naming so new reproductions join the library.
- **RESEARCH agent wired to the library**: now exposes `search_polaris_papers` and notes existing implementation repos in citation `how_used` so PLAN/CODE can reuse them.
- **Web UI rewrite**: navbar with Pipeline/Library view switcher; phase-grouped collapsible trace timeline (per READ/RESEARCH/PLAN/CODE) with counts + output markers; status badges; structured plan-approval card (claims, proof method, deltas, file list, collapsible raw JSON); file-upload dropzone (drag-and-drop PDF/md/tex with live extraction preview); engine selector (Local BYOK / trueForge) + reuse-if-exists checkbox; Library browser (search + paper cards + file tree + source viewer).
- **Paper REST API**: `GET /api/papers` (search/list), `GET /api/papers/:repo` (tree+files, `?file=` for single file), `GET /api/papers/by-arxiv/:id`, `POST /api/upload` (extract-only preview), `POST /api/run` now accepts multipart + `engine` + `reuse_if_exists`.
- **Config**: `POLARIS_PAPERS_ORG` (library, default `PolarisAI-Implementations`), `POLARIS_PAPERS_TOKEN`, `POLARIS_PUBLISH_ORG` (default = library org).
- **doctor**: now reports paper-library org + auth status.
- **npm-package ready**: `package.json` is publishable (`private` removed, `files` whitelist = `index.ts`/`src`/`README.md`/`.env.example`, `engines.bun >=1.1.0`, dropped the spurious `typescript` peerDep). trueForge CLI is resolved via `createRequire(import.meta.url).resolve(...)` instead of `<pkg>/node_modules/.bin/trueforge`, so it survives npm hoisting + global installs; trueForge now runs with `cwd=~/.polaris` (not the package install dir). All outputs (project dirs, checkpoints, trueForge sqlite/logs) resolve to the user's cwd / `~/.polaris` — nothing assumes the package's install location.

### Verified

- `bunx tsc --noEmit` — clean
- `bun test` — 17/17 pass
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
3. **Zero-infra, standalone**: no Redis, no Supabase, no Daytona, no sandbox. The CODE agent writes directly to a real project directory on the client's filesystem. Checkpoints persist to `~/.polaris/`. Add a GitHub token to push.
4. **Bun-native**: `Bun.serve` (routes + HTML imports), `Bun.spawn` (exec), `Bun.file` (IO), `bun test`. No express, no vite, no jest.
5. **Install-location independent**: ships as an npm package but never assumes where it was installed. Reproduced projects are created under the caller's cwd (`POLARIS_OUTPUT_DIR`, default `.`); checkpoints + trueForge data live in `~/.polaris`; the trueForge binary is resolved through Node module resolution (works under hoisting/global install).
