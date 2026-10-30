// Reads a file's content out of a tree bash-changes snapshotted. The trees are
// unreachable objects that `git gc` prunes in time, so a read can find nothing.
import { spawn } from "node:child_process";

export type TreeFile = { content: Buffer; mode: number; symlink: boolean } | "absent" | "missing";

function git(args: string[], cwd: string): Promise<{ code: number | null; stdout: Buffer }> {
	return new Promise((resolve, reject) => {
		// Read-only commands: no lock on the index, no refresh of its stat data.
		const child = spawn("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
	});
}

// The file at `path` in `tree`: its content, "absent" when the tree has no such
// file, "missing" when the tree itself (or the blob) is gone.
export async function readTreeFile(root: string, tree: string, path: string): Promise<TreeFile> {
	const listed = await git(["ls-tree", "-r", "-z", "--full-tree", tree, "--", path], root).catch(() => undefined);
	if (!listed || listed.code !== 0) return "missing";
	const line = listed.stdout
		.toString()
		.split("\0")
		.find((entry) => entry.slice(entry.indexOf("\t") + 1) === path);
	if (!line) return "absent";
	const [mode = "", type = "", object = ""] = line.slice(0, line.indexOf("\t")).split(" ");
	if (type !== "blob") return "absent";
	const blob = await git(["cat-file", "blob", object], root).catch(() => undefined);
	if (!blob || blob.code !== 0) return "missing";
	return { content: blob.stdout, mode: mode === "100755" ? 0o755 : 0o644, symlink: mode === "120000" };
}

export async function isRepository(cwd: string): Promise<boolean> {
	const result = await git(["rev-parse", "--is-inside-work-tree"], cwd).catch(() => undefined);
	return result?.code === 0 && result.stdout.toString().trim() === "true";
}
