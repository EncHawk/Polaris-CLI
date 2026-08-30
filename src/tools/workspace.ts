/**
 * Workspace — the CODE agent writes directly to the client's filesystem.
 *
 * No sandbox, no tempdir, no cloud. The CODE agent creates a real project
 * directory (default: `./<repoName>/` under the current working directory, or
 * under `POLARIS_OUTPUT_DIR` if set), writes files there, runs commands there,
 * and the directory persists after the pipeline finishes. Git push to GitHub
 * still happens from that directory.
 *
 * This replaces the polaris-backend's Daytona sandbox + Supabase mirror — the
 * CLI runs fully standalone on the user's machine.
 */
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { getSettings } from "../config/settings.ts";
import { exec as localExec } from "./local-exec.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

export class Workspace {
  readonly workdir: string;
  readonly repoName: string;

  private constructor(workdir: string, repoName: string) {
    this.workdir = workdir;
    this.repoName = repoName;
  }

  /**
   * Create (or open) a project directory for a reproduction.
   * `outputDir` overrides `POLARIS_OUTPUT_DIR`; defaults to the current
   * working directory. The repo directory is `./<repoName>/`.
   */
  static create(repoName: string, outputDir?: string): Workspace {
    const s = getSettings();
    const base = outputDir ?? s.POLARIS_OUTPUT_DIR ?? ".";
    const dir = resolve(base, repoName);
    mkdirSync(dir, { recursive: true });
    return new Workspace(dir, repoName);
  }

  private abs(path: string): string {
    return isAbsolute(path) ? path : join(this.workdir, path);
  }

  writeFile(path: string, contents: string): string {
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

  async exec(cmd: string, timeoutSec = 600): Promise<ExecResult> {
    return localExec(cmd, this.workdir, timeoutSec);
  }

  async listFiles(directory = "."): Promise<string> {
    const dir = this.abs(directory);
    if (!existsSync(dir)) return "(empty)";
    const out: string[] = [];
    const walk = (d: string, depth = 0): void => {
      if (depth > 5) return;
      for (const name of readdirSync(d)) {
        if (name === ".git" || name === "node_modules") continue;
        const p = join(d, name);
        const rel = relative(this.workdir, p);
        try {
          if (statSync(p).isDirectory()) {
            out.push(`${rel}/`);
            walk(p, depth + 1);
          } else {
            out.push(rel);
          }
        } catch {
          /* skip */
        }
        if (out.length >= 100) return;
      }
    };
    walk(dir);
    return out.length ? out.join("\n") : "(empty)";
  }

  async prepareGit(remoteUrl: string, token: string, existing: boolean): Promise<ExecResult> {
    const askpass = join(this.workdir, ".polaris_git_askpass");
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

  async publishGit(token: string, commitMessage: string): Promise<ExecResult> {
    const askpass = join(this.workdir, ".polaris_git_askpass");
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
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
