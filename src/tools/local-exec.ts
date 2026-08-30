/** Shell exec for the local sandbox fallback — runs `bash -c <cmd>` in a cwd. */
import type { SandboxResult } from "./sandbox.ts";

export async function exec(cmd: string, cwd: string, timeoutSec = 600): Promise<SandboxResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { stdout: "", stderr: `spawn error: ${(e as Error).message}`, returncode: 1 };
  }

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutSec * 1000);

  const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  let code: number;
  try {
    code = await proc.exited;
  } catch {
    code = 1;
  }
  clearTimeout(timer);

  if (killed) {
    return {
      stdout: await stdoutP.catch(() => ""),
      stderr: "timeout",
      returncode: 124,
    };
  }
  return {
    stdout: await stdoutP.catch(() => ""),
    stderr: await stderrP.catch(() => ""),
    returncode: code,
  };
}
