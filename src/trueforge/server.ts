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
  // Only override SQLITE_PATH if the user explicitly configured it — otherwise
  // let trueforge use its default (~/Library/Application Support/... on macOS)
  // which is known to work with Bun's sqlite. Forcing ~/.polaris/trueforge.sqlite
  // crashes Bun's NAPI sqlite binding (see trueforge.log Bun panic).
  const sqlite = overrides.sqlitePath ?? s.TRUEFORGE_SQLITE_PATH ?? "";
  mkdirSync(LOG_DIR, { recursive: true });

  // Ensure default SQLite directory exists if custom path is not provided
  if (!sqlite) {
    const defaultDbDir = join(homedir(), "Library", "Application Support", "trueforge", "db");
    mkdirSync(defaultDbDir, { recursive: true });
  } else {
    const { dirname } = await import("node:path");
    mkdirSync(dirname(sqlite), { recursive: true });
  }

  const env: Record<string, string | undefined> = {
    ...Bun.env,
    PORT: String(port),
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    ...(sqlite ? { SQLITE_PATH: sqlite } : {}),
  };

  if (!TRUEFORGE_CLI) {
    throw new Error(
      "trueForge CLI not found — @truefoundry/trueforge is not installed. Run `bun add @truefoundry/trueforge`.",
    );
  }
  // Run trueForge with Node (not Bun) — the bundled better-sqlite3 native
  // binding crashes under Bun's NAPI shim (Bun 1.3.3 panic). Node is stable.
  // Use the package root as cwd so Node can resolve `env-paths` etc. from
  // the project's node_modules; data/log paths are absolute so they still
  // land in ~/.polaris.
  const nodeBin = Bun.which("node") ?? process.execPath;
  const pkgRoot = join(import.meta.dir, "../..");
  const proc = Bun.spawn([nodeBin, TRUEFORGE_CLI], {
    cwd: pkgRoot,
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
