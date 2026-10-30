// Reads the planned contents, compares them with the files as they are, and
// writes them. Only the files in the plan are ever touched.
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isBinary, lineCounts } from "./diff.ts";
import { readTreeFile } from "./git.ts";
import type { Source } from "./plan.ts";
import type { FileRecord, StoredState, Store } from "./store.ts";

// A file's state: its content, or undefined when it does not exist.
export type State = { content: Buffer; mode?: number; symlink?: boolean } | undefined;

export type FileChange = {
	path: string;
	current: State;
	target: State;
	added: number;
	removed: number;
	binary: boolean;
};

export type Plan = {
	changes: FileChange[];
	// Files whose content at that point is gone (a snapshot pruned by `git gc`, a lost blob).
	missing: string[];
	// Files changed by edit or write before this extension kept backups.
	untracked: string[];
};

export async function readState(path: string): Promise<State> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return { content: Buffer.from(await readlink(path)), symlink: true };
		if (!info.isFile()) return undefined;
		return { content: await readFile(path), mode: info.mode & 0o777 };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

export const sameState = (a: State, b: State) =>
	a === undefined || b === undefined ? a === b : Boolean(a.symlink) === Boolean(b.symlink) && a.content.equals(b.content);

export function fileChange(path: string, current: State, target: State): FileChange {
	const binary = Boolean((current && isBinary(current.content)) || (target && isBinary(target.content)));
	const counts = binary ? { added: 0, removed: 0 } : lineCounts(current?.content.toString("utf8") ?? "", target?.content.toString("utf8") ?? "");
	return { path, current, target, binary, ...counts };
}

// Reads sources, remembering git reads: the picker asks for the same trees often.
export class Reader {
	#store: Store;
	#trees = new Map<string, Promise<State | "missing">>();

	constructor(store: Store) {
		this.#store = store;
	}

	async read(source: Source): Promise<State | "missing" | "unknown"> {
		if (source.kind === "unknown") return "unknown";
		if (source.kind === "blob") {
			if (source.blob === undefined) return undefined;
			const content = await this.#store.get(source.blob);
			return content ? { content, mode: source.mode, symlink: source.symlink } : "missing";
		}
		if (source.absent) return undefined;
		const key = `${source.root}\0${source.tree}\0${source.path}`;
		let pending = this.#trees.get(key);
		if (!pending) {
			pending = readTreeFile(source.root, source.tree, source.path).then((file) =>
				file === "missing" ? "missing" : file === "absent" ? undefined : { content: file.content, mode: file.mode, symlink: file.symlink },
			);
			this.#trees.set(key, pending);
		}
		return pending;
	}
}

// What putting each file at its target means, against the files as they are now.
export async function plan(targets: ReadonlyMap<string, Source>, reader: Reader): Promise<Plan> {
	const out: Plan = { changes: [], missing: [], untracked: [] };
	for (const [path, source] of targets) {
		const target = await reader.read(source);
		if (target === "unknown") out.untracked.push(path);
		else if (target === "missing") out.missing.push(path);
		else {
			const current = await readState(path);
			if (!sameState(current, target)) out.changes.push(fileChange(path, current, target));
		}
	}
	out.changes.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

// The line counts of one turn: each file from `before` to `after`.
export async function turnStats(pairs: ReadonlyMap<string, { before: Source; after?: Source }>, reader: Reader): Promise<TurnStats | undefined> {
	const files: string[] = [];
	let added = 0;
	let removed = 0;
	for (const [path, pair] of pairs) {
		const before = await reader.read(pair.before);
		const after = pair.after ? await reader.read(pair.after) : await readState(path);
		if (before === "unknown" || after === "unknown") return undefined;
		if (before === "missing" || after === "missing") continue;
		if (sameState(before, after)) continue;
		const change = fileChange(path, before, after);
		files.push(path);
		added += change.added;
		removed += change.removed;
	}
	return { files, added, removed };
}

export type TurnStats = { files: string[]; added: number; removed: number };

export async function writeState(path: string, state: State) {
	const isLink = await lstat(path).then(
		(info) => info.isSymbolicLink(),
		() => false,
	);
	// A regular file is rewritten in place, keeping its inode (hard links, owner).
	if (!state || state.symlink || isLink) await rm(path, { force: true });
	if (!state) return;
	await mkdir(dirname(path), { recursive: true });
	if (state.symlink) {
		await symlink(state.content.toString(), path);
		return;
	}
	await writeFile(path, state.content);
	if (state.mode !== undefined) await chmod(path, state.mode);
}

async function storeState(store: Store, state: State): Promise<StoredState | undefined> {
	if (!state) return undefined;
	return { blob: await store.put(state.content), ...(state.mode !== undefined ? { mode: state.mode } : {}), ...(state.symlink ? { symlink: true as const } : {}) };
}

// Writes every planned file, keeping what each held before and after for the
// record (so the prompts can be restored later).
export async function apply(changes: readonly FileChange[], store: Store): Promise<{ records: FileRecord[]; failed: string[] }> {
	const records: FileRecord[] = [];
	const failed: string[] = [];
	for (const item of changes) {
		try {
			const before = await storeState(store, item.current);
			const after = await storeState(store, item.target);
			await writeState(item.path, item.target);
			records.push({ path: item.path, ...(before ? { before } : {}), ...(after ? { after } : {}) });
		} catch {
			failed.push(item.path);
		}
	}
	return { records, failed };
}
