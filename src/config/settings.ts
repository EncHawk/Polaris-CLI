/**
 * BYOK configuration — port of polaris/worker-agent/worker/config.py.
 *
 * Bun loads `.env` from the current working directory automatically. When the
 * CLI is installed globally (npm i -g polaris-cli) users run it from arbitrary
 * directories, so we also load `~/.polaris/.env` as a global credential file —
 * values already present (cwd `.env`, real environment) always win.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const env: Record<string, string | undefined> = Bun.env as Record<string, string | undefined>;

/** Parse a .env-style file into KEY=VALUE pairs (comments + quotes handled). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const m = val.match(/^(['"])(.*)\1$/s);
    if (m) val = m[2]!;
    if (key in Bun.env) continue; // real env / cwd .env wins
    out[key] = val;
  }
  return out;
}

let _globalLoaded = false;
function loadGlobalEnvFile(): void {
  if (_globalLoaded) return;
  _globalLoaded = true;
  try {
    const path = join(homedir(), ".polaris", ".env");
    if (!existsSync(path)) return;
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, "utf-8")))) {
      if (env[k] == null) env[k] = v;
    }
  } catch {
    /* a config file must never break the CLI */
  }
}

/** Location of the global config file (for doctor output). */
export function globalEnvPath(): string {
  return join(homedir(), ".polaris", ".env");
}

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
  readonly POLARIS_API_KEY: string = str(
    "POLARIS_API_KEY",
    env["OPENROUTER_API_KEY"] ?? env["GROQ_API_KEY"] ?? env["DEEPINFRA_API_TOKEN"] ?? "",
  );
  readonly POLARIS_BASE_URL: string = str("POLARIS_BASE_URL", "https://api.openai.com/v1");
  readonly POLARIS_DEFAULT_MODEL: string = str("POLARIS_DEFAULT_MODEL", "gpt-4o-mini");
  readonly READ_MODEL: string = str("POLARIS_READ_MODEL", "");
  readonly RESEARCH_MODEL: string = str("POLARIS_RESEARCH_MODEL", "");
  readonly PLAN_MODEL: string = str("POLARIS_PLAN_MODEL", "");
  readonly CODE_MODEL: string = str("POLARIS_CODE_MODEL", "");
  readonly VERIFY_MODEL: string = str("POLARIS_VERIFY_MODEL", str("VERIFY_MODEL", ""));
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

  // ─── GitHub read-only retrieval (never writes) ────────────────────────────────
  readonly GITHUB_ACCESS_TOKEN: string = str("GITHUB_ACCESS_TOKEN", str("GITHUB_ACCESS_KEY", ""));
  readonly GITHUB_API_URL: string = str("GITHUB_API_URL", "https://api.github.com");

  // ─── Polaris coded-implementation library (read-only retrieval) ────────────────
  // The GitHub org that holds our coded paper reproductions (paper-YYMM-NNNNN).
  // Used by the MCP paper-retrieval tools so coding agents can pull an existing
  // implementation for a paper/citation instead of writing from scratch.
  // Polaris never creates, commits, or pushes repos — retrieval only.
  readonly POLARIS_PAPERS_ORG: string = str("POLARIS_PAPERS_ORG", "PolarisAI-Implementations");
  readonly POLARIS_PAPERS_TOKEN: string = str("POLARIS_PAPERS_TOKEN", str("GITHUB_ACCESS_TOKEN", ""));

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
  if (_settings == null) {
    loadGlobalEnvFile();
    _settings = new Settings();
  }
  return _settings;
}

/** Apply a BYOK profile for this running process; secrets are never returned by the API. */
export function setRuntimeByok(profile: { apiKey?: string; baseUrl?: string; model?: string }): void {
  if (profile.apiKey !== undefined) env["POLARIS_API_KEY"] = profile.apiKey.trim();
  if (profile.baseUrl !== undefined) env["POLARIS_BASE_URL"] = profile.baseUrl.trim().replace(/\/$/, "");
  if (profile.model !== undefined) env["POLARIS_DEFAULT_MODEL"] = profile.model.trim();
  _settings = null;
}

/** A safe-to-display BYOK status. The API key is intentionally never exposed. */
export function byokStatus(): { configured: boolean; base_url: string; model: string } {
  const s = getSettings();
  return { configured: Boolean(s.POLARIS_API_KEY), base_url: s.POLARIS_BASE_URL, model: s.POLARIS_DEFAULT_MODEL };
}
