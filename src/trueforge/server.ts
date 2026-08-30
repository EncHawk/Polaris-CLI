/**
 * Local trueForge server lifecycle — starts the bundled `trueforge` binary in
 * standalone (SQLite) mode and waits until its HTTP API is healthy.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { getSettings } from "../config/settings.ts";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const BIN = join(PROJECT_ROOT, "node_modules", ".bin", "trueforge");
const LOG_DIR = join(homedir(), ".polaris");

export interface TrueForgeServer {
  baseUrl: string;
  port: number;
  stop: () => void;
  pid: number | undefined;
}

function logPath(): string {
  return join(LOG_DIR, "trueforge.log");
}

export async function startTrueForgeServer(overrides: { port?: number; sqlitePath?: string } = {}): Promise<TrueForgeServer> {
  const s = getSettings();
  const port = overrides.port ?? s.TRUEFORGE_PORT;
  const sqlite = overrides.sqlitePath ?? s.TRUEFORGE_SQLITE_PATH ?? join(LOG_DIR, "trueforge.sqlite");
  mkdirSync(LOG_DIR, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...Bun.env,
    PORT: String(port),
    SQLITE_PATH: sqlite,
    PUBLIC_BASE_URL: `http://localhost:${port}`,
  };

  const proc = Bun.spawn([BIN], {
    cwd: PROJECT_ROOT,
    env,
    stdout: Bun.file(logPath()),
    stderr: Bun.file(logPath()),
    detached: false,
  });

  const baseUrl = `http://localhost:${port}`;
  await waitForHealth(baseUrl, 45_000);

  return {
    baseUrl,
    port,
    pid: proc.pid,
    stop: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function waitForHealth(baseUrl: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${baseUrl}/api/v1/capabilities`, { signal: ctrl.signal });
      clearTimeout(to);
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await Bun.sleep(500);
  }
  throw new Error(`trueForge did not become healthy at ${baseUrl} (${lastErr}). See ${logPath()}`);
}

/** True if a trueForge server is already reachable at baseUrl (or the default port). */
export async function isTrueForgeRunning(baseUrl?: string): Promise<boolean> {
  const s = getSettings();
  const url = baseUrl ?? s.TRUEFORGE_BASE_URL ?? `http://localhost:${s.TRUEFORGE_PORT}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${url}/api/v1/capabilities`, { signal: ctrl.signal });
    clearTimeout(to);
    return r.ok;
  } catch {
    return false;
  }
}
