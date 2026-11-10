import { execFile } from "node:child_process";

export interface RunResult { code: number; stdout: string; stderr: string }

/** Runs a program, never throws: a failure to start (or a kill) is code 127. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; signal?: string; killed?: boolean }) | null;
      const code = e ? (typeof e.code === "number" ? e.code : 127) : 0;
      const why = e && typeof e.code !== "number" ? (e.killed ? `killed (${e.signal}) after ${opts.timeout ?? 30_000} ms` : String(e.code ?? e.message)) : "";
      resolve({ code, stdout: String(stdout), stderr: [String(stderr).trim(), why].filter(Boolean).join("\n") });
    });
    // Always closed: `pi --print` waits for piped input while its stdin is open.
    child.stdin?.end(opts.input ?? "");
  });
}
