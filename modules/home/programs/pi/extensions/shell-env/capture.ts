// The environment a terminal opened in the session's folder would have: the user's
// interactive login shell (mise activate and the rest of the zshrc), then direnv's export
// for that folder (a flake's devShell through use flake), which a terminal only gets from
// its first prompt and `zsh -c` never does.
import { spawn } from "node:child_process";

export const MARK = "__PI_SHELL_ENV__";

export const SCRIPT = [
	'command -v direnv >/dev/null 2>&1 && eval "$(direnv export zsh 2>/dev/null)" 2>/dev/null',
	`printf '\\0%s\\0' ${MARK}`,
	"env -0",
].join("; ");

// The shell's own state and the terminal's identity are not the environment to take.
const SKIP = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);
const SKIP_PREFIX = /^(P9K_|_P9K|POWERLEVEL9K_)/;

// What the shell printed after the mark (rc files may print before it), as variables.
export function parseEnv(stdout: string): Map<string, string> | null {
	const at = stdout.indexOf(`\0${MARK}\0`);
	if (at < 0) return null;
	const vars = new Map<string, string>();
	for (const entry of stdout.slice(at + MARK.length + 2).split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		vars.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	return vars;
}

// The variables to set so `env` matches the shell's; what the shell dropped is kept.
export function changes(current: NodeJS.ProcessEnv, captured: Map<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of captured) {
		if (SKIP.has(key) || SKIP_PREFIX.test(key)) continue;
		if (current[key] !== value) out[key] = value;
	}
	return out;
}

export function capture(cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Map<string, string>> {
	const shell = env.SHELL || "/bin/zsh";
	return new Promise((resolve, reject) => {
		// PI_SHELL_ENV lets an rc file skip what only a person at a prompt needs.
		const child = spawn(shell, ["-lic", SCRIPT], { cwd, env: { ...env, PI_SHELL_ENV: "capture" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, "SIGKILL"); } catch {}
			reject(new Error(`${shell} took more than ${timeoutMs / 1000}s`));
		}, timeoutMs);
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", () => {
			clearTimeout(timer);
			const vars = parseEnv(Buffer.concat(chunks).toString("utf8"));
			vars ? resolve(vars) : reject(new Error(`${shell} printed no environment`));
		});
	});
}
