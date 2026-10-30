// Which content each file had at a point of a conversation path, from what
// changed files along it: edit/write backups, bash-changes' trees, and the
// rewinds and restores themselves.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Backup, Record, StoredState } from "./store.ts";

// The shapes read from Pi's session entries; only the fields used here.
export type Block = { type: string; id?: string; name?: string; arguments?: unknown; text?: string; data?: string; mimeType?: string };
export type Message = {
	role: string;
	content?: string | Block[];
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
};
export type Entry = {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: Message;
	customType?: string;
	data?: unknown;
};

// bash-changes' record of one bash call (details.fileChanges or its session entry).
export type FileChanges = { root: string; before: string; after: string; files: { path: string; status: string }[] };

// Where a file's content at some moment can be read from. A blob-less "blob"
// state, or an "absent" tree state, means the file did not exist.
export type Source =
	| { kind: "blob"; blob?: string; mode?: number; symlink?: boolean }
	| { kind: "tree"; root: string; tree: string; path: string; absent?: boolean }
	| { kind: "unknown" };

// A change to one file, at the index of the path entry it belongs to.
export type Change = { index: number; path: string; before: Source; after: Source; record?: true };

export const EDIT_TOOLS = new Set(["edit", "write"]);
export const BASH_CHANGES_ENTRY = "bash-changes";
const UNKNOWN: Source = { kind: "unknown" };

// As Pi's own tools resolve a path argument.
export function resolvePath(path: string, cwd: string): string {
	let value = path.startsWith("@") ? path.slice(1) : path;
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function fileChangesOf(value: unknown): FileChanges | undefined {
	const changes = value as Partial<FileChanges> | undefined;
	if (!changes || typeof changes.root !== "string" || typeof changes.before !== "string" || typeof changes.after !== "string" || !Array.isArray(changes.files)) {
		return undefined;
	}
	return changes as FileChanges;
}

// Each bash call's recorded changes, by tool call id: from the tool results and
// from bash-changes' entries for calls detached to the background.
export function bashChanges(entries: readonly Entry[]): Map<string, FileChanges> {
	const out = new Map<string, FileChanges>();
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) {
			const changes = fileChangesOf((message.details as { fileChanges?: unknown } | undefined)?.fileChanges);
			if (changes) out.set(message.toolCallId, changes);
		} else if (entry.type === "custom" && entry.customType === BASH_CHANGES_ENTRY) {
			const data = entry.data as { toolCallId?: unknown; fileChanges?: unknown } | undefined;
			const changes = fileChangesOf(data?.fileChanges);
			if (changes && typeof data?.toolCallId === "string") out.set(data.toolCallId, changes);
		}
	}
	return out;
}

const stored = (state: StoredState | undefined): Source =>
	state ? { kind: "blob", blob: state.blob, mode: state.mode, symlink: state.symlink } : { kind: "blob" };

const fromBackup = (backup: Backup | undefined): Source => (backup ? { kind: "blob", blob: backup.blob, mode: backup.mode } : UNKNOWN);

export type Sources = {
	backups: readonly Backup[];
	bash: ReadonlyMap<string, FileChanges>;
	records: readonly Record[];
};

// Every change along a path (root first), in the order it happened.
export function changes(path: readonly Entry[], cwd: string, sources: Sources): Change[] {
	// Calls a tool makes (codemode scripts) get the id `<its id>/<n>` and never
	// reach the transcript: their backups go with the calling tool.
	const byCall = new Map<string, Backup[]>();
	for (const backup of sources.backups) {
		const id = backup.toolCallId.split("/", 1)[0]!;
		byCall.set(id, [...(byCall.get(id) ?? []), backup]);
	}
	const errors = new Set<string>();
	for (const entry of path) if (entry.message?.role === "toolResult" && entry.message.isError && entry.message.toolCallId) errors.add(entry.message.toolCallId);
	const recordsAt = new Map<string | null, Record[]>();
	for (const record of sources.records) if (record.files.length) recordsAt.set(record.toLeaf, [...(recordsAt.get(record.toLeaf) ?? []), record]);

	const out: Change[] = [];
	// What a rewind or restore found in a file came from another path; what it
	// wrote is this path's content at that point, so it stands on both sides.
	const addRecords = (leaf: string | null, index: number) => {
		for (const record of recordsAt.get(leaf) ?? [])
			for (const file of record.files) out.push({ index, path: file.path, before: stored(file.after), after: stored(file.after), record: true });
	};
	addRecords(null, -1);
	path.forEach((entry, index) => {
		const message = entry.message;
		if (entry.type === "message" && message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !block.id || !block.name) continue;
				const own = byCall.get(block.id);
				if (own) out.push(...backupChanges(own, index));
				else if (EDIT_TOOLS.has(block.name) && !errors.has(block.id)) {
					// Made before this extension kept backups: what it changed is unknown.
					const file = (block.arguments as { path?: unknown } | undefined)?.path;
					if (typeof file === "string") out.push({ index, path: resolvePath(file, cwd), before: UNKNOWN, after: UNKNOWN });
				}
				const bash = block.name === "bash" ? sources.bash.get(block.id) : undefined;
				if (bash) out.push(...treeChanges(bash, index));
			}
		}
		addRecords(entry.id, index);
	});
	return out;
}

// One change per call and file: its "before" backup (taken when the call was
// the prompt's first change to the file) and its "after" backup.
function backupChanges(backups: readonly Backup[], index: number): Change[] {
	const calls = new Map<string, { path: string; before?: Backup; after?: Backup }>();
	const out: Change[] = [];
	for (const backup of backups) {
		if (backup.bash) {
			out.push(...treeChanges(backup.bash, index));
			continue;
		}
		const id = `${backup.toolCallId}\0${backup.path}`;
		const call = calls.get(id) ?? { path: backup.path };
		if (backup.phase === "after") call.after = backup;
		else call.before = backup;
		calls.set(id, call);
	}
	for (const call of calls.values()) out.push({ index, path: call.path, before: fromBackup(call.before), after: fromBackup(call.after) });
	return out;
}

function treeChanges(bash: FileChanges, index: number): Change[] {
	return bash.files.map((file) => ({
		index,
		path: join(bash.root, file.path),
		before: { kind: "tree", root: bash.root, tree: bash.before, path: file.path, ...(file.status === "A" ? { absent: true } : {}) },
		after: { kind: "tree", root: bash.root, tree: bash.after, path: file.path, ...(file.status === "D" ? { absent: true } : {}) },
	}));
}

// The file's content at the end of the entry at `index`: just before its next
// change if there is one, else what was seen when the path was left (a
// rewind's "before"), else just after its last change. Undefined: the path
// says nothing about the file.
export function stateAt(all: readonly Change[], index: number, path: string, left?: Source): Source | undefined {
	let last: Change | undefined;
	for (const change of all) {
		if (change.path !== path) continue;
		// The next change is the first of its prompt for this file, so it has a "before".
		if (change.index > index) return change.before;
		last = change;
	}
	return left ?? last?.after;
}

export const touched = (all: readonly Change[], from: number, to: number) =>
	new Set(all.filter((change) => change.index >= from && change.index <= to).map((change) => change.path));

// Where each file goes when the conversation moves from the current leaf to
// the end of the entry at `targetIndex` on the target path. Both paths share
// their entries up to `common` (-1: none). Files changed on the current path
// after `common` go back to their content there; files changed on the target
// path between `common` and the target take their content at the target.
export function targets(
	current: readonly Change[],
	common: number,
	target: readonly Change[],
	targetIndex: number,
	left?: ReadonlyMap<string, Source>,
): Map<string, Source> {
	const out = new Map<string, Source>();
	for (const path of touched(current, common + 1, Number.POSITIVE_INFINITY)) {
		const state = stateAt(current, common, path);
		if (state) out.set(path, state);
	}
	for (const path of touched(target, common + 1, targetIndex)) {
		const state = stateAt(target, targetIndex, path, left?.get(path));
		if (state) out.set(path, state);
	}
	return out;
}

// What the last rewind or restore that moved the conversation off `tip` found in
// the files it rewrote: their content at the end of that path.
export function leftAt(records: readonly Record[], tip: string): Map<string, Source> {
	const out = new Map<string, Source>();
	for (const record of records) {
		if (record.fromLeaf !== tip || !record.conversation) continue;
		for (const file of record.files) out.set(file.path, stored(file.before));
	}
	return out;
}

// The content a file should have now when the last change to it on the path is
// a rewind or restore: what that wrote.
export function writtenByRecord(all: readonly Change[], path: string): Source | undefined {
	const last = all.filter((change) => change.path === path).at(-1);
	return last?.record ? last.after : undefined;
}
