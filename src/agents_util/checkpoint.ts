/**
 * Code checkpoints — port of worker/agents_util/checkpoint.py.
 *
 * Persisted to a local JSON file (~/.polaris/checkpoints) so the CODE agent's
 * progress survives across iterations even with zero infra. The polaris
 * backend mirrored these to Supabase; the CLI is standalone — local only.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CKPT_DIR = join(homedir(), ".polaris", "checkpoints");

function ckptPath(jobUuid: string): string {
  return join(CKPT_DIR, `${jobUuid}.json`);
}

interface Snapshot {
  ts: string;
  user_id: string;
  paper_id: string;
  code: Record<string, string>;
}
interface CkptFile {
  job_uuid: string;
  snapshots: Snapshot[];
}

export function saveCodeCheckpoint(
  userId: string,
  paperId: string,
  jobUuid: string,
  codeFiles: Record<string, string>,
): void {
  try {
    mkdirSync(CKPT_DIR, { recursive: true });
    const path = ckptPath(jobUuid);
    let file: CkptFile;
    if (existsSync(path)) {
      file = JSON.parse(readFileSync(path, "utf-8")) as CkptFile;
    } else {
      file = { job_uuid: jobUuid, snapshots: [] };
    }
    file.snapshots.push({ ts: new Date().toISOString(), user_id: userId, paper_id: paperId, code: codeFiles });
    writeFileSync(path, JSON.stringify(file));
  } catch {
    /* checkpoints must never break the pipeline */
  }
}

export function loadLatestCheckpoint(jobUuid: string): Record<string, string> | null {
  try {
    const path = ckptPath(jobUuid);
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, "utf-8")) as CkptFile;
    const last = file.snapshots[file.snapshots.length - 1];
    return last ? last.code : null;
  } catch {
    return null;
  }
}

export function deleteCheckpoints(jobUuid: string): void {
  try {
    if (existsSync(ckptPath(jobUuid))) unlinkSync(ckptPath(jobUuid));
  } catch {
    /* ignore */
  }
}
