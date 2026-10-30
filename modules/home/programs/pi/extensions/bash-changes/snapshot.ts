// Snapshots a repository's working tree as a git tree object, without touching
// its index, stash or refs, and diffs two snapshots.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PATCH_LIMIT = 200 * 1024;

export type ChangedFile = {
	path: string;
	// git's --name-status letter: A, D, M or T (renames are off).
	status: string;
	// Absent for binary files.
	added?: number;
	removed?: number;
};

export type FileChanges = {
	root: string;
	before: string;
	after: string;
	files: ChangedFile[];
	patch: string;
	patchTruncated?: true;
	overlapping?: true;
};

type Output = { stdout: string; truncated: boolean };

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, limit = Infinity): Promise<Output> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			chunks.push(chunk);
			size += chunk.length;
			if (size > limit) {
				truncated = true;
				child.kill();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const stdout = Buffer.concat(chunks);
			if (truncated) {
				// Cut on a line so no hunk line or UTF-8 sequence is left half-written.
				const end = stdout.lastIndexOf(10, limit - 1);
				resolve({ stdout: stdout.subarray(0, end + 1).toString(), truncated });
			} else if (code === 0) resolve({ stdout: stdout.toString(), truncated });
			else reject(new Error(`git ${args[0]} exited with ${code}: ${stderr.trim()}`));
		});
	});
}

const fields = (output: string) => output.split("\0").filter((field) => field !== "");

type IndexStamp = string;

async function stampOf(index: string): Promise<IndexStamp> {
	try {
		const { mtimeMs, size, ino } = await stat(index);
		return `${mtimeMs}:${size}:${ino}`;
	} catch {
		return "missing";
	}
}

export class Window {
	#snapshots: Snapshots;
	#root: string;
	#index: string;
	#stamp: IndexStamp;
	#env: NodeJS.ProcessEnv;
	#before: string;

	constructor(snapshots: Snapshots, root: string, index: string, stamp: IndexStamp, env: NodeJS.ProcessEnv, before: string) {
		this.#snapshots = snapshots;
		this.#root = root;
		this.#index = index;
		this.#stamp = stamp;
		this.#env = env;
		this.#before = before;
	}

	get root() {
		return this.#root;
	}

	get before() {
		return this.#before;
	}

	// The second snapshot, and what changed since the first. Always releases the window.
	async close(): Promise<FileChanges | undefined> {
		try {
			const after = await writeTree(this.#root, this.#env);
			await this.#snapshots.keepWarm(this.#index, this.#stamp, this.#env.GIT_INDEX_FILE!).catch(() => undefined);
			if (after === this.#before) return undefined;
			return await diff(this.#root, this.#env, this.#before, after);
		} finally {
			await this.discard();
		}
	}

	async discard() {
		await rm(this.#env.GIT_INDEX_FILE!, { force: true });
	}
}

async function writeTree(root: string, env: NodeJS.ProcessEnv) {
	await git(["add", "-A"], root, env);
	return (await git(["write-tree"], root, env)).stdout.trim();
}

async function diff(root: string, env: NodeJS.ProcessEnv, before: string, after: string): Promise<FileChanges> {
	const range = ["diff-tree", "-r", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv"];
	const [statuses, counts, patch] = await Promise.all([
		git([...range, "-z", "--name-status", before, after], root, env),
		git([...range, "-z", "--numstat", before, after], root, env),
		git([...range, "-p", "-U3", "--src-prefix=a/", "--dst-prefix=b/", before, after], root, env, PATCH_LIMIT),
	]);
	const lines = new Map<string, { added?: number; removed?: number }>();
	for (const field of fields(counts.stdout)) {
		// The path is the rest of the field: with -z it is verbatim and may hold tabs.
		const [added, removed] = field.split("\t", 2);
		const path = field.slice(`${added}\t${removed}\t`.length);
		lines.set(path, added === "-" ? {} : { added: Number(added), removed: Number(removed) });
	}
	const files: ChangedFile[] = [];
	const status = fields(statuses.stdout);
	for (let i = 0; i + 1 < status.length; i += 2) {
		const path = status[i + 1]!;
		files.push({ path, status: status[i]!, ...lines.get(path) });
	}
	return {
		root,
		before,
		after,
		files,
		patch: patch.stdout,
		...(patch.truncated ? { patchTruncated: true as const } : {}),
	};
}

// Opens windows and keeps, per repository, the index of its last snapshot.
// Starting from that index rather than the real one lets `git add -A` trust the
// stat data it cached for untracked files instead of hashing them all again.
export class Snapshots {
	#directory: Promise<string> | undefined;
	// The same directory once created: process exit handlers can't wait for a promise.
	#created: string | undefined;
	#warm = new Map<string, IndexStamp>();
	#cleanup = () => {
		if (this.#created) rmSync(this.#created, { recursive: true, force: true });
	};

	// Undefined outside a git working tree.
	async open(cwd: string): Promise<Window | undefined> {
		let root: string;
		let index: string;
		try {
			const { stdout } = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "index"], cwd);
			[root = "", index = ""] = stdout.trim().split("\n");
		} catch {
			return undefined;
		}
		if (!root || !index) return undefined;
		const directory = await this.directory();
		const env = { ...process.env, GIT_INDEX_FILE: join(directory, `call-${randomUUID()}`), GIT_OPTIONAL_LOCKS: "0" };
		try {
			const stamp = await stampOf(index);
			// The warm copy is only valid while the real index is the one it grew from:
			// staging, a checkout or a sparse-checkout change makes the real index the source again.
			const source = this.#warm.get(index) === stamp ? this.warmPath(directory, index) : index;
			await copyFile(source, env.GIT_INDEX_FILE).catch(() => undefined);
			const before = await writeTree(root, env);
			return new Window(this, root, index, stamp, env, before);
		} catch (error) {
			await rm(env.GIT_INDEX_FILE, { force: true });
			throw error;
		}
	}

	async keepWarm(index: string, stamp: IndexStamp, snapshot: string) {
		// A backgrounded call can finish after the session that started it shut down.
		if (!this.#directory) return;
		const directory = await this.#directory;
		const target = this.warmPath(directory, index);
		// Parallel calls in one repository close concurrently; a rename never leaves a half-copied index.
		const pending = `${target}.${randomUUID()}`;
		await copyFile(snapshot, pending);
		await rename(pending, target);
		this.#warm.set(index, stamp);
	}

	async dispose() {
		process.off("exit", this.#cleanup);
		const directory = this.#directory;
		this.#directory = undefined;
		this.#created = undefined;
		this.#warm.clear();
		if (directory) await rm(await directory, { recursive: true, force: true });
	}

	private warmPath(directory: string, index: string) {
		return join(directory, `warm-${createHash("sha256").update(index).digest("hex").slice(0, 32)}`);
	}

	private directory() {
		if (!this.#directory) {
			this.#directory = mkdtemp(join(tmpdir(), "pi-bash-changes-")).then((directory) => (this.#created = directory));
			// A Pi that exits without its session_shutdown still leaves no index copies behind.
			process.once("exit", this.#cleanup);
		}
		return this.#directory;
	}
}
