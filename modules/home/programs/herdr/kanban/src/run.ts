import { execFile } from "node:child_process";

export interface RunResult { code: number; stdout: string; stderr: string }

/** Runs a program, never throws: a failure to start is code 127. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
