/**
 * BYOK configuration — port of polaris/worker-agent/worker/config.py.
 *
 * Bun loads .env automatically, so we read the environment directly. Every
 * model/credential is bring-your-own; nothing is hardcoded to a provider.
 */
const env: Record<string, string | undefined> = Bun.env as Record<string, string | undefined>;

function str(key: string, fallback = ""): string {
  const v = env[key];
  return v == null ? fallback : String(v);
}
function int(key: string, fallback: number): number {
  const v = env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export class Settings {
  readonly ENVIRONMENT: string = str("ENVIRONMENT", "development");
  readonly DEV_MODE: boolean | null = env["DEV_MODE"] == null ? null : /^(1|true|yes|on)$/i.test(env["DEV_MODE"] ?? "");

  // ─── LLM (OpenAI-compatible, BYOK) ──────────────────────────────────────────
  readonly POLARIS_API_KEY: string = str("POLARIS_API_KEY", env["DEEPINFRA_API_TOKEN"] ?? "");
  readonly POLARIS_BASE_URL: string = str("POLARIS_BASE_URL", "https://api.deepinfra.com/v1/openai");
  readonly POLARIS_DEFAULT_MODEL: string = str("POLARIS_DEFAULT_MODEL", "deepseek-ai/DeepSeek-V3.2-Flash");
  readonly READ_MODEL: string = str("POLARIS_READ_MODEL", "");
  readonly RESEARCH_MODEL: string = str("POLARIS_RESEARCH_MODEL", "");
  readonly PLAN_MODEL: string = str("POLARIS_PLAN_MODEL", "");
  readonly CODE_MODEL: string = str("POLARIS_CODE_MODEL", "");
  readonly ORCHESTRATOR_MODEL: string = str("ORCHESTRATOR_MODEL", "");

  // ─── Loop / agent tuning ─────────────────────────────────────────────────────
  readonly AGENT_MAX_STEPS: number = int("POLARIS_AGENT_MAX_STEPS", int("AGENT_MAX_STEPS", 4));
  readonly ARXIV_MAX_CITATIONS: number = int("POLARIS_ARXIV_MAX_CITATIONS", int("ARXIV_MAX_CITATIONS", 8));

  // ─── Upload limits (guards against oversized payloads / LLM inputs) ─────────
  readonly MAX_UPLOAD_BYTES: number = int("POLARIS_MAX_UPLOAD_MB", 25) * 1024 * 1024;
  readonly MAX_PAPER_CHARS: number = int("POLARIS_MAX_PAPER_CHARS", 600_000);

  // ─── Ports ───────────────────────────────────────────────────────────────────
  /** Agent-server (web UI + REST + MCP route) listen port. */
  readonly POLARIS_PORT: number = int("POLARIS_PORT", 8788);
  /** Standalone MCP endpoint port used by `polaris run --engine trueforge`. */
  readonly POLARIS_MCP_PORT: number = int("POLARIS_MCP_PORT", 8791);
  /**
   * Externally reachable polaris MCP URL (e.g. https://mcp.example.com/mcp)
   * for remote trueForge harnesses (POLARIS_TRUEFORGE_BASE_URL). A localhost
   * MCP URL is useless to a remote harness — localhost resolves on the remote
   * host. Leave empty for locally managed harnesses.
   */
  readonly POLARIS_MCP_PUBLIC_URL: string = str("POLARIS_MCP_PUBLIC_URL", "");

  // ─── CODE agent output (writes directly to the client's filesystem) ───────────
  // Where project directories are created. Defaults to the current working
  // directory, so `polaris run 2106.09685` creates `./paper-2106-09685/`.
  readonly POLARIS_OUTPUT_DIR: string = str("POLARIS_OUTPUT_DIR", "");

  // ─── trueForge harness ────────────────────────────────────────────────────────
  readonly TRUEFORGE_PORT: number = int("POLARIS_TRUEFORGE_PORT", 8790);
  readonly TRUEFORGE_SQLITE_PATH: string = str("POLARIS_TRUEFORGE_SQLITE_PATH", "");
  readonly TRUEFORGE_BASE_URL: string = str("POLARIS_TRUEFORGE_BASE_URL", "");

  // ─── GitHub publishing ────────────────────────────────────────────────────────
  readonly GITHUB_ACCESS_TOKEN: string = str("GITHUB_ACCESS_TOKEN", str("GITHUB_ACCESS_KEY", ""));
  readonly GITHUB_ORG: string = str("GITHUB_ORG", "Polaris-Implementations");
  readonly GITHUB_API_URL: string = str("GITHUB_API_URL", "https://api.github.com");
  readonly GITHUB_REPO_PRIVATE: boolean = bool("GITHUB_REPO_PRIVATE", false);

  // ─── Polaris coded-implementation library (read-only retrieval) ────────────────
  // The GitHub org that holds our coded paper reproductions (paper-YYMM-NNNNN).
  // Used by the MCP paper-retrieval tools so coding agents can pull an existing
  // implementation for a paper/citation instead of writing from scratch.
  readonly POLARIS_PAPERS_ORG: string = str("POLARIS_PAPERS_ORG", "PolarisAI-Implementations");
  readonly POLARIS_PAPERS_TOKEN: string = str("POLARIS_PAPERS_TOKEN", str("GITHUB_ACCESS_TOKEN", ""));

  // ─── Where newly generated implementations are pushed ───────────────────────────
  // Defaults to the library org so generated reproductions join the library and
  // become retrievable by future runs. Set to a separate org to keep them apart.
  readonly POLARIS_PUBLISH_ORG: string = str("POLARIS_PUBLISH_ORG", str("POLARIS_PAPERS_ORG", "PolarisAI-Implementations"));

  /** Pick a per-agent model or fall back to the default. */
  modelFor(agent: string): string {
    const key = `${agent}_MODEL` as keyof this;
    const val = this[key];
    if (typeof val === "string" && val) return val;
    return this.POLARIS_DEFAULT_MODEL;
  }

  get isDev(): boolean {
    if (this.DEV_MODE !== null) return this.DEV_MODE;
    return ["dev", "development", "local", "test"].includes(this.ENVIRONMENT.toLowerCase());
  }
}

let _settings: Settings | null = null;
export function getSettings(): Settings {
  if (_settings == null) _settings = new Settings();
  return _settings;
}
