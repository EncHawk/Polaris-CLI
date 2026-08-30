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
import { dirname, join, resolve, relative, sep } from "node:path";
import { getSettings } from "../config/settings.ts";
import { exec as localExec } from "./local-exec.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

/** Marker file proving a directory was created/adopted by polaris. */
const MARKER_FILE = ".polaris-workspace";

/**
 * Reduce a user-controlled repo name to a safe single path component.
 * Rejects path separators, traversal fragments, and anything that would not
 * survive as a GitHub repo name, so a crafted `repo_name` can never point the
 * workspace (and its `git add -A && git push`) at an arbitrary host directory.
 */
export function sanitizeRepoName(input: string): string {
  const base = input.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .slice(0, 100)
    .replace(/[._-]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid repository name: "${input}" (expected a simple GitHub-safe name like paper-2106-09685)`);
  }
  return cleaned;
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
   *
   * The name is sanitized to a single safe component and the resolved
   * directory is asserted to stay under the output root. In `create` mode an
   * already-existing non-empty directory that polaris does not own (no
   * `.polaris-workspace` marker) is refused, so a run can never commit and
   * push an unrelated host directory.
   */
  static async create(repoName: string, outputDir?: string, mode: "create" | "modify" | "run" = "create"): Promise<Workspace> {
    const s = getSettings();
    const base = resolve(outputDir || s.POLARIS_OUTPUT_DIR || ".");
    const safe = sanitizeRepoName(repoName);
    const dir = resolve(base, safe);
    if (dir !== base && !dir.startsWith(base + sep)) {
      throw new Error(`Workspace path escapes the output directory: ${dir} (base: ${base})`);
    }
    if (mode === "create" && existsSync(dir) && !this.isOwned(dir)) {
      const entries = readdirSync(dir).filter((e) => e !== MARKER_FILE);
      if (entries.length > 0) {
        throw new Error(
          `Directory ${dir} already exists and is not empty (not created by polaris). ` +
            `Use a different --repo/--output, or --mode modify/run to work inside it.`,
        );
      }
    }
    mkdirSync(dir, { recursive: true });
    if (mode !== "run") {
      const marker = join(dir, MARKER_FILE);
      if (!existsSync(marker)) await Bun.write(marker, `polaris workspace: ${safe}\n`);
    }
    return new Workspace(dir, safe);
  }

  private static isOwned(dir: string): boolean {
    return existsSync(join(dir, MARKER_FILE));
  }

  /**
   * Resolve `path` inside the workspace; throws if it would escape the
   * workspace. Uses `resolve` (not `join`) so `..` components are normalized
   * BEFORE the containment check — an unnormalized `workdir/../outside` would
   * pass a naive string-prefix test while actually pointing outside.
   */
  private abs(path: string): string {
    const p = resolve(this.workdir, path);
    if (p !== this.workdir && !p.startsWith(this.workdir + sep)) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return p;
  }

  async writeFile(path: string, contents: string): Promise<string> {
    const p = this.abs(path);
    mkdirSync(dirname(p), { recursive: true });
    await Bun.write(p, contents);
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
        if (name === ".git" || name === "node_modules" || name === MARKER_FILE || name === ".polaris_git_askpass") continue;
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
    await this.writeFile(".polaris_git_askpass", script);
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
      `${env}git add -A -- ':!.polaris_git_askpass' ':!${MARKER_FILE}' && ` +
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
