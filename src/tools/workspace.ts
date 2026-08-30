/** Local, confined project workspace used by CODE and VERIFY. */
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { getSettings } from "../config/settings.ts";
import { exec as localExec } from "./local-exec.ts";

export interface ExecResult { stdout: string; stderr: string; returncode: number; }
const MARKER_FILE = ".polaris-workspace";

/** Reduce user input to a single, safe project-directory component. */
export function sanitizeRepoName(input: string): string {
  const base = input.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-")
    .replace(/^[._-]+/, "").replace(/[._-]+$/, "").slice(0, 100).replace(/[._-]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid repository name: "${input}" (expected a simple name like paper-2106-09685)`);
  }
  return cleaned;
}

export class Workspace {
  readonly workdir: string;
  readonly repoName: string;
  private constructor(workdir: string, repoName: string) { this.workdir = workdir; this.repoName = repoName; }

  static async create(repoName: string, outputDir?: string, mode: "create" | "modify" | "run" = "create"): Promise<Workspace> {
    const base = resolve(outputDir || getSettings().POLARIS_OUTPUT_DIR || ".");
    const safe = sanitizeRepoName(repoName);
    const dir = resolve(base, safe);
    if (dir !== base && !dir.startsWith(base + sep)) throw new Error(`Workspace path escapes the output directory: ${dir} (base: ${base})`);
    if (mode === "create" && existsSync(dir) && !this.isOwned(dir)) {
      const entries = readdirSync(dir).filter((entry) => entry !== MARKER_FILE);
      if (entries.length) throw new Error(`Directory ${dir} already exists and is not empty (not created by polaris). Use another --repo/--output, or --mode modify/run.`);
    }
    mkdirSync(dir, { recursive: true });
    if (mode !== "run") {
      const marker = join(dir, MARKER_FILE);
      if (!existsSync(marker)) await Bun.write(marker, `polaris workspace: ${safe}\n`);
    }
    return new Workspace(dir, safe);
  }

  private static isOwned(dir: string): boolean { return existsSync(join(dir, MARKER_FILE)); }
  private abs(path: string): string {
    const target = resolve(this.workdir, path);
    if (target !== this.workdir && !target.startsWith(this.workdir + sep)) throw new Error(`Path escapes the workspace: ${path}`);
    return target;
  }
  async writeFile(path: string, contents: string | Uint8Array): Promise<string> {
    const target = this.abs(path); mkdirSync(dirname(target), { recursive: true }); await Bun.write(target, contents); return target;
  }
  async readFile(path: string): Promise<string> {
    const target = this.abs(path); return existsSync(target) ? Bun.file(target).text() : `File not found: ${path}`;
  }
  async exec(cmd: string, timeoutSec = 600): Promise<ExecResult> { return localExec(cmd, this.workdir, timeoutSec); }
  async listFiles(directory = "."): Promise<string> {
    const dir = this.abs(directory); if (!existsSync(dir)) return "(empty)";
    const out: string[] = [];
    const walk = (current: string, depth = 0): void => {
      if (depth > 5 || out.length >= 100) return;
      for (const name of readdirSync(current)) {
        if (name === ".git" || name === "node_modules" || name === MARKER_FILE) continue;
        const entry = join(current, name); const rel = relative(this.workdir, entry);
        try { if (statSync(entry).isDirectory()) { out.push(`${rel}/`); walk(entry, depth + 1); } else out.push(rel); } catch { /* skip races */ }
        if (out.length >= 100) return;
      }
    };
    walk(dir); return out.length ? out.join("\n") : "(empty)";
  }
}
