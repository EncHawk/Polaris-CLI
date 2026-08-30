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

  // ─── trueForge harness ────────────────────────────────────────────────────────
  readonly TRUEFORGE_PORT: number = int("POLARIS_TRUEFORGE_PORT", 8790);
  readonly TRUEFORGE_SQLITE_PATH: string = str("POLARIS_TRUEFORGE_SQLITE_PATH", "");
  readonly TRUEFORGE_BASE_URL: string = str("POLARIS_TRUEFORGE_BASE_URL", "");

  // ─── CODE agent sandbox (Daytona optional; local tempdir fallback) ───────────
  readonly DAYTONA_API_KEY: string = str("DAYTONA_API_KEY", "");
  readonly DAYTONA_API_URL: string = str("DAYTONA_API_URL", str("DAYTONA_URL", ""));
  readonly DAYTONA_TARGET: string = str("DAYTONA_TARGET", "");
  readonly DAYTONA_SANDBOX_NAME: string = str("DAYTONA_SANDBOX_NAME", "Polaris");
  readonly DAYTONA_WORKDIR: string = str("DAYTONA_WORKDIR", "/home/daytona");

  // ─── GitHub publishing ────────────────────────────────────────────────────────
  readonly GITHUB_ACCESS_TOKEN: string = str("GITHUB_ACCESS_TOKEN", str("GITHUB_ACCESS_KEY", ""));
  readonly GITHUB_ORG: string = str("GITHUB_ORG", "Polaris-Implementations");
  readonly GITHUB_API_URL: string = str("GITHUB_API_URL", "https://api.github.com");
  readonly GITHUB_REPO_PRIVATE: boolean = bool("GITHUB_REPO_PRIVATE", false);

  // ─── Optional durable storage ─────────────────────────────────────────────────
  readonly SUPABASE_URL: string = str("SUPABASE_URL", "");
  readonly SUPABASE_KEY: string = str("SUPABASE_KEY", str("SUPABASE_SECRET_KEY", ""));

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
