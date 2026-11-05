import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
) => Promise<ExecResult>;

/** Runs a command without a shell. Never throws on a non-zero exit; check `code`. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 ? err.message : ""), code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export async function execOk(...a: Parameters<Exec>): Promise<string> {
  const r = await exec(...a);
  if (r.code !== 0) throw new Error(`${a[0]} ${a[1].join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
