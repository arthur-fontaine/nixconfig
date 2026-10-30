// The prompts the two pickers list, their labels, ages and per-turn code
// changes, and the options the confirmation offers.
import { basename } from "node:path";
import { type Change, type Entry, leftAt, type Source, stateAt, targets, touched } from "./plan.ts";
import type { Record } from "./store.ts";
import { EMPTY_MESSAGE, NO_PROMPT, type Option, ROW } from "./text.ts";

export type Prompt = {
	id: string;
	// Index of the user message on its path.
	index: number;
	// Index of the last entry of its turn: just before the next prompt, or the path's end.
	end: number;
	text: string;
	time: number;
};

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export function entryTime(entry: Entry): number {
	if (typeof entry.message?.timestamp === "number") return entry.message.timestamp;
	const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

// The user's prompts on a path, oldest first. Pi keeps tool results, summaries
// and extension messages in other roles or entry types, so every user message
// is a prompt.
export function prompts(path: readonly Entry[], from = 0): Prompt[] {
	const indexes: number[] = [];
	path.forEach((entry, index) => {
		if (index >= from && entry.type === "message" && entry.message?.role === "user") indexes.push(index);
	});
	return indexes.map((index, i) => {
		const entry = path[index]!;
		return {
			id: entry.id,
			index,
			end: (indexes[i + 1] ?? path.length) - 1,
			text: messageText(entry.message?.content),
			time: entryTime(entry),
		};
	});
}

// As Claude Code's picker row: the first line, "…" when more follow.
export function firstLine(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return EMPTY_MESSAGE;
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : `${trimmed.slice(0, newline)}…`;
}

// As Claude Code's confirmation quote: 500 characters, then 4 lines.
export function quoted(text: string): string[] {
	const trimmed = text.trim() || NO_PROMPT;
	return trimmed.slice(0, 500).split("\n").slice(0, 4);
}

const UNITS: [number, string][] = [
	[31_536_000, "y"],
	[2_592_000, "mo"],
	[604_800, "w"],
	[86_400, "d"],
	[3_600, "h"],
	[60, "m"],
	[1, "s"],
];

// Claude Code's narrow relative time: "20s ago", "3h ago", "0s ago".
export function timeAgo(time: number, now: number): string {
	const seconds = Math.trunc((now - time) / 1000);
	if (seconds < 0) {
		for (const [size, unit] of UNITS) if (-seconds >= size) return `in ${Math.trunc(-seconds / size)}${unit}`;
		return "in 0s";
	}
	for (const [size, unit] of UNITS) if (seconds >= size) return `${Math.trunc(seconds / size)}${unit} ago`;
	return "0s ago";
}

// Each file a turn changed, from its content before the turn to after it.
export function turnPairs(path: readonly Change[], prompt: Prompt): Map<string, { before: Source; after?: Source }> {
	// A rewind or restore between turns is no turn's change.
	const all = path.filter((change) => !change.record);
	const out = new Map<string, { before: Source; after?: Source }>();
	for (const path of touched(all, prompt.index, prompt.end)) {
		const before = stateAt(all, prompt.index - 1, path);
		if (!before) continue;
		out.set(path, { before, after: stateAt(all, prompt.end, path) });
	}
	return out;
}

export type Stats = { files: string[]; added: number; removed: number };

// The dim second line of a picker row (without its colors).
export function rowSummary(stats: Stats | undefined): { label: string; added: number; removed: number } | "noRestore" {
	if (!stats) return "noRestore";
	if (stats.files.length === 0) return { label: ROW.noChanges, added: 0, removed: 0 };
	const label = stats.files.length === 1 ? basename(stats.files[0]!) : ROW.filesChanged(stats.files.length);
	return { label, added: stats.added, removed: stats.removed };
}

// "in X" of "The code will be restored +N -M in X."
export function filesPhrase(files: readonly string[]): string {
	const names = files.map((file) => basename(file));
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} and ${names.length - 1} other files`;
}

// Claude Code's options: the three restores when the code would change, else
// only the conversation; the summaries when a model can write them; "Never mind".
export function rewindOptions(codeChanges: boolean, canSummarize: boolean): Option[] {
	const options: Option[] = codeChanges ? ["both", "conversation", "code"] : ["conversation"];
	if (canSummarize) options.push("summarize", "summarize_up_to");
	options.push("nevermind");
	return options;
}

// Restore's: the same, without the summaries; a prompt still in the
// conversation (its code alone was rewound) can only get its code back.
export function restoreOptions(codeChanges: boolean, inConversation: boolean): Option[] {
	if (inConversation) return codeChanges ? ["code", "nevermind"] : ["nevermind"];
	return [...(codeChanges ? (["both", "conversation", "code"] as Option[]) : (["conversation"] as Option[])), "nevermind"];
}

// Where Rewind puts the files for "before this prompt" on the current path.
export const rewindTargets = (current: readonly Change[], prompt: Prompt) => targets(current, prompt.index - 1, current, prompt.index - 1);

// A prompt that was rewound away, on the path it was left on.
export type Rewound = Prompt & {
	// The leaf that path was left at; undefined for prompts still in the conversation.
	tip?: string;
	path: readonly Entry[];
	// Last index the path shares with the current one (-1: none).
	common: number;
	// When it was rewound, for telling branches apart.
	at: number;
	// For prompts still in the conversation: the record that rewound their code.
	record?: Record;
};

// The prompts Restore lists. `branchOf(id)` is Pi's getBranch(id).
export function rewoundPrompts(current: readonly Entry[], records: readonly Record[], branchOf: (id: string) => Entry[]): Rewound[] {
	const onPath = new Set(current.map((entry) => entry.id));
	const latest = new Map<string, number>();
	for (const record of records) if (record.conversation && record.fromLeaf && !onPath.has(record.fromLeaf)) latest.set(record.fromLeaf, Math.max(latest.get(record.fromLeaf) ?? 0, record.at));
	const paths = new Map([...latest.keys()].map((tip) => [tip, branchOf(tip)]));
	// A tip on the way to another tip is part of that longer path.
	const tips = [...paths.keys()].filter((tip) => ![...paths].some(([other, path]) => other !== tip && path.some((entry) => entry.id === tip)));
	const out: Rewound[] = [];
	for (const tip of tips.sort((a, b) => latest.get(a)! - latest.get(b)!)) {
		const path = paths.get(tip)!;
		let common = -1;
		while (common + 1 < path.length && onPath.has(path[common + 1]!.id)) common++;
		for (const prompt of prompts(path, common + 1)) out.push({ ...prompt, tip, path, common, at: latest.get(tip)! });
	}
	// Code-only rewinds leave their prompts in the conversation.
	const index = new Map(current.map((entry, i) => [entry.id, i]));
	for (const record of records) {
		if (record.conversation || record.kind !== "rewind" || !record.files.length) continue;
		const from = index.get(record.message);
		const to = record.toLeaf === null ? undefined : index.get(record.toLeaf);
		if (from === undefined || to === undefined) continue;
		const slice = current.slice(0, to + 1);
		for (const prompt of prompts(slice, from)) {
			if (out.some((other) => other.id === prompt.id && !other.tip)) continue;
			out.push({ ...prompt, path: slice, common: from - 1, at: record.at, record });
		}
	}
	return out;
}

// Where Restore puts the files for "after this prompt".
export function restoreTargets(current: readonly Change[], target: readonly Change[], prompt: Rewound, records: readonly Record[]) {
	if (prompt.tip) return targets(current, prompt.common, target, prompt.end, leftAt(records, prompt.tip));
	// A code-only rewind: the path's own changes up to it, and what it overwrote as the end state.
	const record = prompt.record!;
	const left = new Map<string, Source>(record.files.map((file) => [file.path, file.before ? { kind: "blob", blob: file.before.blob, mode: file.before.mode, symlink: file.before.symlink } : { kind: "blob" }]));
	return targets([], prompt.common, target, prompt.end, left);
}
