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

#### Phase 3 — chat TUI + global-install invocation + Verify agent

- **Chat TUI & Provider Selection**: `src/server/tui.ts` rewritten as a full-screen interactive chat interface for `polaris start` and default `polaris` invocation — alternate-screen buffer with header (paper/engine/phase), scrolling transcript (agent messages, tool steps), plan rendered as a bordered card when it needs approval, and an always-available input line. Automatically boots trueForge + local MCP APIs straight away on startup. Features interactive provider selection menu (`openSettings()`) with quick presets (`1` OpenAI, `2` Anthropic, `3` DeepInfra, `4` Together AI, `5` Ollama/vLLM) and clear notice: `"💡 Note: You can change your LLM provider at any point using Ctrl+S or :settings"`. Also supports interactive paper prompt mode (typing arXiv ID or PDF path directly into chat input).
- **Global-install config**: `src/config/settings.ts` also loads `~/.polaris/.env` (cwd `.env` + real env always win) so `npm i -g polaris-cli` works from any directory. `POLARIS_MCP_PUBLIC_URL` + port settings in `.env.example`; `polaris doctor` reports both `~/.polaris/.env` and `./.env`.
- **Verify agent**: `src/agents/verify.ts` — runs last (`CODE → VERIFY → END`) to ensure the implementation persisted every signal from the initial READ and the plan's additional queries. It lists the workspace, reads each planned file, cross-checks deltas/intended proof + relevant_citations/numbers against file contents, runs `python -m py_compile` on each `.py`, and calls `complete_verify` with `plan_signals_covered`, `missing_signals`, `initial_queries_covered`, `files_verified/missing`, `checks_passed`. A `checks_passed: false` fails the run (visible in the graph, the TUI, and the `VERIFY` trace). The agent is registered on the MCP server and as `polaris-verify` in trueForge (5 agents total); the pipeline exposes `verify` in `WorkerState` and on the status stream. The TUI renders the verify result and the follow-up `:modify` path seeds `orchestrator_feedback` so the user can steer a fix from the chat.
- **Follow-up jobs**: `src/pipeline/run.ts` accepts `plan_feedback` (→ `state.plan_feedback` for PLAN replans) and `code_feedback` (→ `state.orchestrator_feedback` for CODE). The TUI chat loop uses them for `:rerun`/`:modify`.

### Verified

- `bunx tsc --noEmit` — clean
- `bun test` — 30/30 pass (incl. verify agent + wrapText/parseEnvFile + all Qodo regressions)
- `polaris doctor` — config check works (`~/.polaris/.env` reported)
- `polaris mcp` — MCP initialize + tools/list handshake works over stdio (now 9 tools incl. `complete_verify`)
- `polaris serve` — web page served (Bun bundler transpiles React), API endpoints work (including from globally-installed `polaris`)
- `polaris serve --tf` — trueForge boots, provisions model provider + MCP + all 5 agents (verified via API)
- `npm pack` + `npm i -g ./polaris-cli-0.1.0.tgz` — global install verified: `polaris --help`, `doctor` (with `~/.polaris/.env`), `mcp` handshake, and `serve` all work from the globally-installed binary

### Not yet wired

- Daytona REST exec in the local sandbox — currently stubbed; managed Daytona comes via trueForge's sandbox-as-tool when using `polaris serve --tf`.
- Usage/billing reporting (polaris `usage.py`) — not ported (BYOK = user pays their provider directly).

### Qodo review remediations (PR #1)

All 11 findings from the Qodo code review were fixed:

1. **ID-miss reuses arbitrary repo** — `searchPolarisPapers` no longer falls through to the recent-repos listing when a direct arXiv lookup misses; it returns no results instead.
2. **trueForge CODE output discarded** — the CODE turn's `sandbox_artifacts` are downloaded via `client.sessions.downloadSandboxFile` and bridged into the pipeline workspace (persist + checkpoint + publish), with a trueForge-specific system-prompt addendum; `ready` now requires actual output.
3. **File path becomes arXiv id** — the CLI arg parser knows value-taking flags, so `polaris run --file paper.pdf` no longer sets the id to `paper.pdf`.
4. **Repo path leaks host files** — repo names are sanitized to one safe path component, the workspace is confined to the output root, file ops can't escape the workspace, and create mode refuses unowned non-empty directories (`.polaris-workspace` marker; excluded from git pushes and listings).
5. **ID-less uploads share a workspace** — runs without an arXiv id derive a stable title slug (`paper-attention-is-all-you-need`) or a unique job-derived name; the shared `paper-unknown` default is gone.
6. **Search result falsely proves match** — title-search hits only count as `found` at ≥80% title-token overlap; fuzzy hits come back as candidates only.
7. **Uploads can exhaust memory** — bodies over `POLARIS_MAX_UPLOAD_MB` (default 25) get 413 before buffering; extracted text caps at `POLARIS_MAX_PAPER_CHARS` (default 600k).
8. **Invalid engine silently runs local** — `parseEngine` rejects anything but `local|trueforge` at every entry point (CLI, server JSON/multipart, runOne).
9. **trueForge not started for CLI runs** — `polaris run --engine trueforge` boots + provisions the harness and a standalone MCP endpoint (`POLARIS_MCP_PORT`), tearing both down afterwards; the agent-server also got its own port (`POLARIS_PORT`, default 8788) so it never collides with trueForge (8790), and provisioning now points at OUR `/mcp`.
10. **Implementation file paths unencoded** — GitHub content paths are per-segment URL-encoded, so filenames with `#`/`?` work.
11. **reuse flag truthiness** — strict boolean parsing (`"false"` ≠ true); invalid values get 400.

Also fixed while in there: `POLARIS_TRUEFORGE_BASE_URL ?? url` empty-string fallthrough bugs (doctor/setup/agent), and `cmdSetup` no longer points the polaris MCP at trueForge's own URL.

#### Qodo re-review round 2 (8 new findings — all fixed)

1. **Sandbox artifacts gained a root prefix** (High) — artifact links keep their absolute sandbox paths for the download API, and `stripSandboxRoot` maps them to project-relative paths (shared sandbox-root segment stripped), so `/workspace/train.py` lands at `train.py`.
2. **Workspace writes raced consumers** (High) — `Workspace.writeFile` is now `async` and awaits `Bun.write`; every caller (tool handlers, checkpoint restore, sandbox bridge, README injection, askpass) awaits it.
3. **Remote harness got a localhost MCP URL** (High) — `POLARIS_MCP_PUBLIC_URL` (new setting) is required to (re)provision a remote trueForge; without it a remote harness is used as provisioned with a clear hint. Local harnesses keep the localhost URL.
4. **Workspace traversal bypass** (High, security) — `Workspace.abs` resolves with `resolve()` before the containment check, so `a/../../escape` can no longer slip past the string-prefix test.
5. **Remote trueForge configuration ignored** (High) — `makeTrueForgeClient` uses `||` instead of `??` so the empty-string setting no longer overrides the localhost fallback (also the root cause behind 3).
6. **GitHub failures became misses** (Medium) — a direct repo lookup only treats 404 as "not found"; rate limits/auth failures/outages throw so reuse decisions never build on a false miss.
7. **Failed trueForge startup leaked servers** (Medium) — `ensureTrueForgeForRun` wraps harness start + provisioning in one try/catch that stops everything it started before rethrowing.
8. **Sync writes** (Medium, rule) — workspace marker + test fixtures use `Bun.write` instead of `writeFileSync`.

#### Qodo re-review round 3 (3 new findings — all fixed)

1. **Standalone MCP endpoint bound all interfaces** (High, security) — the CLI MCP endpoint now binds `127.0.0.1` only: it exposes `polaris_run` (auto-approved CODE turns that execute shell commands) with optional auth, so a 0.0.0.0 bind would let network peers drive host code execution and burn the BYOK key. Remote harnesses reach it through the user's proxy/tunnel in front of `POLARIS_MCP_PUBLIC_URL`.
2. **Binary artifacts corrupted by UTF-8 decode** (High) — the bridge decodes with `fatal: true` and keeps raw `bytes` for anything that isn't valid UTF-8 (images, checkpoints, archives, data); `Workspace.writeFile` accepts `string | Uint8Array`, and binary files are excluded from the JSON checkpoint.
3. **Partial bridge published as success** (Medium) — artifact-cap truncation and skipped/failed downloads now surface as `sandboxIncomplete`, which sets `push_error` and fails the run instead of publishing a repo that's missing required files.

### Key design decisions

1. **Two engines, one pipeline**: the graph/agents are engine-agnostic. The local ReAct loop (`loop.ts`) and the trueForge engine (`engine.ts`) both consume the same prompts + tool defs and emit to the same trace bus.
2. **MCP as the tool layer**: completion tools are MCP tools, so trueForge agents and external coding agents share the same tool surface.
3. **Zero-infra, standalone**: no Redis, no Supabase, no Daytona, no sandbox. The CODE agent writes directly to a real project directory on the client's filesystem. Checkpoints persist to `~/.polaris/`. Add a GitHub token to push.
4. **Bun-native**: `Bun.serve` (routes + HTML imports), `Bun.spawn` (exec), `Bun.file` (IO), `bun test`. No express, no vite, no jest.
5. **Install-location independent**: ships as an npm package but never assumes where it was installed. Reproduced projects are created under the caller's cwd (`POLARIS_OUTPUT_DIR`, default `.`); checkpoints + trueForge data live in `~/.polaris`; the trueForge binary is resolved through Node module resolution (works under hoisting/global install).
