// What bash-titles decides without Pi: which commands get a title, the request sent to Haiku,
// whether its answer is one, and the cache of titles by command.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// As pi-harness's pi-thinking-summary: a command is read as is when it is short and simple.
export function wantsTitle(command: string): boolean {
	const text = command.trim();
	if (!text) return false;
	const steps = (text.match(/;|&&|\|\|?/g) ?? []).length;
	return text.length > 80 || text.includes("\n") || steps > 2;
}

export const SYSTEM = [
	"You name shell commands for a person scanning an agent's activity.",
	"Reply with one short phrase of 3 to 8 words saying what the command does, starting with a verb",
	"in the third person (\"Lists the largest session files\", \"Runs the editor's unit tests\").",
	"Name its purpose, not its flags; never say whether it worked. No quotes, no final period.",
].join(" ");

// Only the command goes out (no conversation): its head and tail when it is long.
export function request(command: string, max = 1500): string {
	const text = command.trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max * 0.7)}\n…\n${text.slice(-max * 0.3)}`;
}

export const SCRIPT_SYSTEM = [
	"You name the JavaScript scripts an agent runs to call its tools (tools.bash runs a shell command,",
	"tools.read, tools.edit and tools.write handle files), for a person scanning the agent's activity.",
	"Reply with one short phrase of 3 to 8 words saying what the script does, starting with a verb in the",
	"third person (\"Counts lines of every text file\", \"Updates the README's install steps\").",
	"Name its purpose, not the calls it makes; never say whether it worked. No quotes, no final period.",
].join(" ");

const OPTIONS_LINE = /^\/\/ @options:.*(\n|$)/;
const TOOL_CALL = /\btools\s*(\.\s*[A-Za-z_$][\w$]*|\[)\s*\(?/g;

const TEMPLATE = /`(?:\\[\s\S]|[^`\\])*`/g;

/**
 * Whether a codemode script is named by Haiku. Nearly every call is a script now, so a short one
 * making a single tool call isn't: the call's own line under the row names it. A script making
 * several, or doing more than a few lines around one call or without any, is. A template
 * literal's text (a file written whole) counts as one line.
 */
export function wantsScriptTitle(code: string): boolean {
	const text = code.replace(OPTIONS_LINE, "").replace(TEMPLATE, "``").trim();
	const calls = (text.match(TOOL_CALL) ?? []).length;
	if (calls > 1) return true;
	return text.split("\n").filter((line) => line.trim()).length > 3;
}

/**
 * The scripts running now, by call id, to name the one whose code looked like one call (a loop's
 * single `tools.bash(`) once it makes a second: `called` hands its code back then, once.
 */
export class RunningScripts {
	readonly #scripts = new Map<string, { code: string; calls: number }>();
	readonly max: number;
	constructor(max = 100) {
		this.max = max;
	}
	started(id: string, code: string): void {
		this.#scripts.set(id, { code, calls: 0 });
		while (this.#scripts.size > this.max) this.#scripts.delete(this.#scripts.keys().next().value!);
	}
	// Pi gives a script's calls the ids `<script id>/<n>`, and their own calls `<script id>/<n>/<m>`.
	called(callId: string): string | undefined {
		const script = this.#scripts.get(callId.split("/", 1)[0]!);
		if (!callId.includes("/") || !script) return undefined;
		return ++script.calls === 2 && !wantsScriptTitle(script.code) ? script.code : undefined;
	}
	/** Its code when it ended without the call it was written for (it threw first), to be named. */
	finished(id: string): string | undefined {
		const script = this.#scripts.get(id);
		this.#scripts.delete(id);
		return script && script.calls === 0 && /\btools\s*(\.|\[)/.test(script.code) && !wantsScriptTitle(script.code) ? script.code : undefined;
	}
}

export const scriptRequest = (code: string) => request(code.replace(OPTIONS_LINE, ""));

// Kept apart from a command with the same text.
export const scriptKey = (code: string) => `codemode\0${code.trim()}`;

// Only against a runaway answer: a title is shown whole, the terminal's width alone cuts its
// row. Kept under compact-tools' 160 characters for a one-line command, which it would cut.
const MAX_CHARS = 150;

// Haiku, through Claude Code, sometimes answers about the task instead ("I'm not going to run this
// command: my role…"), or wraps the title ("Summary: …", "Naming the script: \"…").
const ABOUT_THE_TASK = /\b(system role|my (role|job)|your task|the (task|job) here|labeling task|the user wants)\b|^(I|I'm|Your|Let me)\b/i;
const LEAD = /^[^:"]{0,40}?\b(summar|title|phrase|nam|label|message)\w*[^:"]{0,20}:\s*/i;
const TRAIL = /[.;]?\s*\b(summary|title)( phrase)?:\s*$/i;

// The answer's first line, its wrapping dropped and cut at its first sentence. An answer dropped
// is a command left untitled for good, so a wordy one is kept as it is.
export function titleOf(reply: string): string | null {
	const line = (reply.trim().split("\n")[0] ?? "").trim();
	if (ABOUT_THE_TASK.test(line)) return null;
	let text = line.replace(TRAIL, "").replace(LEAD, "").split(/\.\s+(?=[A-Z])/)[0]!;
	text = text.trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
	if (!text) return null;
	// Cut at a word, without "…", which would read as a title of the old limit, asked again.
	if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS + 1).replace(/\s+\S*$/, "").replace(/[,;:]$/, "");
	return text[0]!.toUpperCase() + text.slice(1);
}

// Titles cached before titles were shown whole were cut to 12 words with "…": such a title is
// read as missing, so it is asked for again once, when its command shows again.
const cutByOldLimit = (title: string) => title.endsWith("…");

export const keyOf = (command: string) => createHash("sha256").update(command.trim()).digest("hex").slice(0, 32);

// Titles by command, oldest dropped past `max`.
export class TitleCache {
	readonly #map = new Map<string, string>();
	readonly max: number;
	constructor(entries: Record<string, string> = {}, max = 3000) {
		this.max = max;
		for (const [k, v] of Object.entries(entries)) this.#map.set(k, v);
	}
	get(command: string): string | undefined {
		const title = this.#map.get(keyOf(command));
		return title === undefined || cutByOldLimit(title) ? undefined : title;
	}
	stale(command: string): boolean {
		const title = this.#map.get(keyOf(command));
		return title !== undefined && cutByOldLimit(title);
	}
	set(command: string, title: string): void {
		const key = keyOf(command);
		this.#put(key, title);
		this.#added.set(key, title);
	}
	/**
	 * The file's titles with the ones this process added since its last save on top, which become
	 * this cache's: another Pi's titles saved meanwhile are kept, not written over.
	 */
	merge(onDisk: Record<string, string>): Record<string, string> {
		this.#map.clear();
		for (const [k, v] of Object.entries(onDisk)) if (typeof v === "string") this.#put(k, v);
		for (const [k, v] of this.#added) this.#put(k, v);
		this.#added.clear();
		return this.toJSON();
	}
	readonly #added = new Map<string, string>();
	#put(key: string, title: string): void {
		this.#map.delete(key);
		this.#map.set(key, title);
		while (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value!);
	}
	toJSON(): Record<string, string> {
		return Object.fromEntries(this.#map);
	}
}

function readTitles(file: string): Record<string, string> {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

export const loadTitles = (file: string) => new TitleCache(readTitles(file));

/**
 * Written as the file is now plus this process's new titles, through a file of its own renamed over
 * it: several Pis save here, each from the cache it loaded at its start.
 */
export function saveTitles(file: string, cache: TitleCache): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const merged = cache.merge(readTitles(file));
	const temp = `${file}.${process.pid}.${randomUUID()}`;
	try {
		writeFileSync(temp, JSON.stringify(merged));
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * A row's title in the session itself, for a resumed session and other readers of the file: in its
 * result's `details.title` when known as the result is written, else in an entry of this type,
 * `{ toolCallId, title }`, once it comes.
 */
export const ENTRY = "bash-titles";

/** The result's details with the title added; undefined when they aren't an object to add it to. */
export function withTitle(details: unknown, title: string): Record<string, unknown> | undefined {
	if (details === undefined || details === null) return { title };
	if (typeof details !== "object" || Array.isArray(details)) return undefined;
	return { ...(details as Record<string, unknown>), title };
}

/** The titles a session's entries give its calls, by call id. */
export function sessionTitles(entries: readonly unknown[]): Map<string, string> {
	const titles = new Map<string, string>();
	for (const entry of entries) {
		const e = entry as { type?: unknown; customType?: unknown; data?: { toolCallId?: unknown; title?: unknown }; message?: { role?: unknown; toolCallId?: unknown; details?: { title?: unknown } } };
		if (e?.type === "message" && e.message?.role === "toolResult") {
			const { toolCallId, details } = e.message;
			if (typeof toolCallId === "string" && typeof details?.title === "string") titles.set(toolCallId, details.title);
		} else if (e?.type === "custom" && e.customType === ENTRY) {
			if (typeof e.data?.toolCallId === "string" && typeof e.data.title === "string") titles.set(e.data.toolCallId, e.data.title);
		}
	}
	return titles;
}
