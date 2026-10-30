import { execFileSync } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keeps the user's and the system's git config out of the tests (and out of the
// snapshots they take, which inherit this environment).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// So `git status` in assertions doesn't refresh the real index the tests check is untouched.
process.env.GIT_OPTIONAL_LOCKS = "0";

export const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	});

// Captured once: tests point TMPDIR at private directories to watch the extension's temp files.
const base = tmpdir();

export async function scratch(prefix: string) {
	return realpath(await mkdtemp(join(base, prefix)));
}

export async function repo() {
	const root = await scratch("bash-changes-repo-");
	git(root, "init", "-q");
	return root;
}
