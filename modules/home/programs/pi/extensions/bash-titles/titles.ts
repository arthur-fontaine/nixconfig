// What bash-titles decides without Pi: which commands get a title, the request sent to Haiku,
// whether its answer is one, and the cache of titles by command.
import { createHash } from "node:crypto";

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

// Only against a runaway answer: a title is shown whole, the terminal's width alone cuts its
// row. Kept under compact-tools' 160 characters for a one-line command, which it would cut.
const MAX_CHARS = 150;

// The answer's first line. An answer dropped is a command left untitled for good, so a wordy
// one is kept as it is.
export function titleOf(reply: string): string | null {
	const line = reply.trim().split("\n")[0] ?? "";
	let text = line.trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
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
		this.#map.delete(key);
		this.#map.set(key, title);
		while (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value!);
	}
	toJSON(): Record<string, string> {
		return Object.fromEntries(this.#map);
	}
}
