/**
 * Local trueForge server lifecycle — starts the bundled `trueforge` binary in
 * standalone (SQLite) mode and waits until its HTTP API is healthy.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { getSettings } from "../config/settings.ts";

const LOG_DIR = join(homedir(), ".polaris");

// Resolve the bundled trueForge CLI through Node module resolution so it works
// no matter how polaris-cli was installed (local, global, or with hoisted
// deps). Spawning `<pkg>/node_modules/.bin/trueforge` directly breaks under
// npm hoisting and global installs because the .bin symlink lives at the
// install root, not inside the package.
const TRUEFORGE_CLI: string | null = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@truefoundry/trueforge/dist/cli.js");
  } catch {
    return null;
  }
})();

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

  if (!TRUEFORGE_CLI) {
    throw new Error(
      "trueForge CLI not found — @truefoundry/trueforge is not installed. Run `bun add @truefoundry/trueforge`.",
    );
  }
  // Run trueForge from the polaris data dir (not the package install dir) so a
  // global/npm install doesn't write runtime files into node_modules.
  const proc = Bun.spawn([TRUEFORGE_CLI], {
    cwd: LOG_DIR,
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
