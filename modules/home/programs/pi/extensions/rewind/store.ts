// Per-session file store under Pi's agent directory: content-addressed blobs,
// the edit/write backups and the record of each rewind and restore. Nothing is
// ever written into the user's repository.
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChanges } from "./plan.ts";

// A file's content around an edit or write call: "before" once per prompt and
// file (before the first change, as Claude Code's file history), "after" for
// every call. No blob means the file did not exist.
export type Backup = {
	toolCallId: string;
	// The user message entry the call belongs to.
	message: string;
	path: string;
	phase?: "after";
	blob?: string;
	mode?: number;
	// A subagent's bash call, as bash-changes recorded it in the subagent's session.
	bash?: FileChanges;
};

export type StoredState = { blob: string; mode?: number; symlink?: true };

// A file as a rewind or restore found it and as it left it.
export type FileRecord = { path: string; before?: StoredState; after?: StoredState };

// One rewind (back to before `message`) or restore (forward to after it).
export type Record = {
	id: string;
	at: number;
	kind: "rewind" | "restore";
	message: string;
	// The leaf before and after; a conversation that didn't move keeps the same one.
	fromLeaf: string | null;
	toLeaf: string | null;
	conversation: boolean;
	files: FileRecord[];
};

const SESSION_FILE = "session";
const BACKUPS = "backups.jsonl";
const RECORDS = "records.jsonl";

export class Store {
	readonly dir: string;
	#taken = new Set<string>();
	#ready: Promise<void> | undefined;
	#sessionFile: string | undefined;

	constructor(dir: string, sessionFile?: string) {
		this.dir = dir;
		this.#sessionFile = sessionFile;
	}

	private ready() {
		this.#ready ??= (async () => {
			await mkdir(join(this.dir, "blobs"), { recursive: true });
			// Lets a later session find and prune the store once the session file is gone.
			await writeFile(join(this.dir, SESSION_FILE), this.#sessionFile ?? "");
			for (const backup of await this.backups()) if (!backup.phase && !backup.bash) this.#taken.add(key(backup.message, backup.path));
		})();
		return this.#ready;
	}

	async put(content: Buffer): Promise<string> {
		await this.ready();
		const hash = createHash("sha256").update(content).digest("hex");
		const path = join(this.dir, "blobs", hash);
		if (await exists(path)) return hash;
		const pending = `${path}.${randomUUID()}`;
		await writeFile(pending, content);
		await rename(pending, path);
		return hash;
	}

	async get(hash: string): Promise<Buffer | undefined> {
		return readFile(join(this.dir, "blobs", hash)).catch(() => undefined);
	}

	// Backs up the file as it is now: "before" once per prompt, "after" always.
	async backUp(toolCallId: string, message: string, path: string, phase?: "after"): Promise<boolean> {
		await this.ready();
		const id = key(message, path);
		if (!phase && this.#taken.has(id)) return false;
		if (!phase) this.#taken.add(id);
		const backup: Backup = { toolCallId, message, path, ...(phase ? { phase } : {}) };
		try {
			const info = await stat(path);
			if (!info.isFile()) return false;
			backup.blob = await this.put(await readFile(path));
			backup.mode = info.mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (!phase) this.#taken.delete(id);
				throw error;
			}
		}
		await appendFile(join(this.dir, BACKUPS), `${JSON.stringify(backup)}\n`);
		return true;
	}

	async addBash(toolCallId: string, message: string, changes: FileChanges) {
		await this.ready();
		const backup: Backup = { toolCallId, message, path: changes.root, bash: changes };
		await appendFile(join(this.dir, BACKUPS), `${JSON.stringify(backup)}\n`);
	}

	async backups(): Promise<Backup[]> {
		return (await lines<Backup>(join(this.dir, BACKUPS))).filter((value) => typeof value.toolCallId === "string" && typeof value.path === "string");
	}

	async addRecord(record: Record) {
		await this.ready();
		await appendFile(join(this.dir, RECORDS), `${JSON.stringify(record)}\n`);
	}

	async records(): Promise<Record[]> {
		return (await lines<Record>(join(this.dir, RECORDS))).filter((value) => typeof value.id === "string" && Array.isArray(value.files));
	}

	async remove() {
		await rm(this.dir, { recursive: true, force: true });
	}
}

async function lines<T>(path: string): Promise<T[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	const out: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// A line cut short by a crash loses only that line.
		}
	}
	return out;
}

const key = (message: string, path: string) => `${message}\0${path}`;

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

const GRACE_MS = 24 * 60 * 60 * 1000;

async function lastUse(dir: string) {
	const times = await Promise.all(
		[SESSION_FILE, BACKUPS, RECORDS].map((name) =>
			stat(join(dir, name)).then(
				(info) => info.mtimeMs,
				() => 0,
			),
		),
	);
	return Math.max(...times);
}

// Removes the stores of sessions whose file no longer exists. Unsaved sessions
// keep theirs in a temp directory removed when they end.
export async function prune(root: string, live: string, now = Date.now()) {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	for (const name of names) {
		const dir = join(root, name);
		if (dir === live) continue;
		const sessionFile = await readFile(join(dir, SESSION_FILE), "utf8").catch(() => undefined);
		if (!sessionFile || (await exists(sessionFile))) continue;
		// Pi writes a new session's file only once it has a reply: a store that is
		// still in use by another Pi may have no session file yet.
		if (now - (await lastUse(dir)) < GRACE_MS) continue;
		await rm(dir, { recursive: true, force: true });
	}
}
