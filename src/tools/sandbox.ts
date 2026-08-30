/**
 * Sandbox abstraction — port of worker/tools/daytona_sandbox.py.
 *
 * When Daytona creds are present we run commands in a real cloud sandbox; otherwise
 * we degrade to a local tempdir "sandbox" so the whole graph runs end-to-end in dev
 * with zero infra. File transfer and git push happen inside the sandbox via `exec`.
 */
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getSettings } from "../config/settings.ts";
import { exec as localExec } from "./local-exec.ts";

export interface SandboxResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

interface DaytonaReal {
  apiKey: string;
  apiUrl: string;
  sandboxName: string;
  target: string;
}

export class Sandbox {
  workdir: string;
  isReal = false;
  private real: DaytonaReal | null = null;
  private files: Record<string, string> = {};

  private constructor(workdir: string, real: DaytonaReal | null) {
    this.workdir = workdir;
    this.real = real;
    this.isReal = real != null;
  }

  static create(jobId = ""): Sandbox {
    const s = getSettings();
    if (s.DAYTONA_API_KEY && s.DAYTONA_API_URL) {
      // Daytona REST exec is intentionally deferred to the trueForge harness
      // (`polaris serve`), which manages Daytona natively. The local engine
      // falls back to a tempdir so it always runs.
      console.error("[sandbox] Daytona configured but local engine uses tempdir; use `polaris serve` for managed Daytona");
    }
    const dir = mkdtempSync(join(tmpdir(), `polaris-sbx-${jobId || "local"}-`));
    return new Sandbox(dir, null);
  }

  private abs(path: string): string {
    return path.startsWith("/") ? path : join(this.workdir, path);
  }

  writeFile(path: string, contents: string): string {
    this.files[path] = contents;
    const p = this.abs(path);
    mkdirSync(dirname(p), { recursive: true });
    Bun.write(p, contents);
    return p;
  }

  async readFile(path: string): Promise<string> {
    const p = this.abs(path);
    if (!existsSync(p)) return `File not found: ${path}`;
    return await Bun.file(p).text();
  }

  async exec(cmd: string, timeoutSec = 600): Promise<SandboxResult> {
    return localExec(cmd, this.workdir, timeoutSec);
  }

  async listFiles(directory = "."): Promise<string> {
    const r = await this.exec(`find ${shQuote(directory)} -type f | head -50`, 30);
    return r.stdout || "(empty)";
  }

  async prepareGit(remoteUrl: string, token: string, existing: boolean): Promise<SandboxResult> {
    const askpass = `${this.workdir.replace(/\/$/, "")}/.polaris_git_askpass`;
    const script =
      `#!/bin/sh\n` +
      `case "$1" in\n` +
      `  *Username*) printf '%s\\n' polaris-bot ;;\n` +
      `  *) printf '%s\\n' ${shQuote(token)} ;;\n` +
      `esac\n`;
    this.writeFile(".polaris_git_askpass", script);
    await this.exec(`chmod 700 ${shQuote(askpass)}`, 10);
    const env =
      `export GIT_ASKPASS=${shQuote(askpass)} ` +
      `GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Polaris GIT_AUTHOR_EMAIL=bot@polaris.local ` +
      `GIT_COMMITTER_NAME=Polaris GIT_COMMITTER_EMAIL=bot@polaris.local; `;
    const init = await this.exec(`${env}git init -b main`, 30);
    if (init.returncode !== 0) return init;
    const remote = await this.exec(
      `${env}git remote remove origin >/dev/null 2>&1 || true; ${env}git remote add origin ${shQuote(remoteUrl)}`,
      30,
    );
    if (remote.returncode !== 0 || !existing) return remote;
    return this.exec(`${env}git fetch --depth=1 origin main && ${env}git checkout -B main origin/main`, 180);
  }

  async publishGit(token: string, commitMessage: string): Promise<SandboxResult> {
    const askpass = `${this.workdir.replace(/\/$/, "")}/.polaris_git_askpass`;
    const env =
      `export GIT_ASKPASS=${shQuote(askpass)} ` +
      `GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Polaris GIT_AUTHOR_EMAIL=bot@polaris.local ` +
      `GIT_COMMITTER_NAME=Polaris GIT_COMMITTER_EMAIL=bot@polaris.local; `;
    const result = await this.exec(
      `${env}git add -A -- ':!.polaris_git_askpass' && ` +
        `(${env}git diff --cached --quiet || ${env}git commit -m ${shQuote(commitMessage)}) && ` +
        `${env}git push -u origin HEAD:main`,
      300,
    );
    await this.exec(`rm -f ${shQuote(askpass)}`, 10);
    return result;
  }

  cleanup(): void {
    try {
      rmSync(this.workdir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
