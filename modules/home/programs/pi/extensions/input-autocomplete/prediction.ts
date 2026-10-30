// What is asked of the model and how its reply becomes suggestions. No Pi
// imports, so the tests run without Pi installed.

export const SUGGESTIONS = 5;
export const MAX_SUGGESTION_CHARS = 240;
export const MAX_CONVERSATION_CHARS = 10_000;
export const MAX_MESSAGE_CHARS = 2_000;
export const CACHE_ENTRIES = 100;

export interface Turn {
	role: string;
	text: string;
}

export interface Payload {
	conversation: Turn[];
	draft: string;
}

const BASE_PROMPT = `You guess what the human types next in a chat with a coding agent.
In the conversation, "user" is the human and "assistant" is the coding agent. Write the human's next message, never the agent's.
The human gives the agent instructions, asks about its work, approves, corrects or redirects it, and calls it "you".
Never write in the agent's voice: no reports of finished work ("I fixed the bug"), no offers ("I can add a test"), no questions back to the human ("Should I continue?"). The human would write "Fix the bug", "Add a test", "Continue" or "Did the tests pass?" instead.
When unsure, prefer a direct instruction to the agent or a question about what it did.
Respect every constraint the human stated; never suggest something they ruled out.
Each suggestion must read like typed chat input, not code, a bare file name or pasted tool output. Keep it short, grounded in the conversation, and clearly different from the others.
Reply with a JSON array of exactly ${SUGGESTIONS} distinct strings, most likely first, and nothing else: no prose, numbering, labels or code fences.
If the draft is empty, each string is a whole message.
If the draft is not empty, each string is only what comes after the draft, so that draft + string reads as one natural message. Never repeat, quote or rewrite the draft.`;

export function systemPrompt(draft: string): string {
	if (!draft) return BASE_PROMPT;
	return `${BASE_PROMPT}\nThe draft is exactly ${JSON.stringify(draft)}. Each string continues it from its last character; never include the draft itself.`;
}

// Only where a word or sentence has just ended: mid-word guesses change on
// every keystroke and would each cost a request.
export function wantsPrediction(draft: string): boolean {
	return draft === "" || /[\s.!?,;:)\]}]$/u.test(draft);
}

const FENCE = /^\s*```[a-z]*\s*|\s*```\s*$/giu;
// C0 controls other than tab and newline, DEL, and terminal escape sequences:
// a suggestion is drawn in the terminal before it is inserted.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/gu;

function clean(raw: string, draft: string): string {
	let text = raw.replace(/\r\n?/gu, "\n").replace(CONTROL, "").replace(FENCE, "");
	text = text.replace(/^(?:continuation|prediction|suggestion)\s*:\s*/iu, "");
	if (draft && text.startsWith(draft)) text = text.slice(draft.length);
	// A continuation keeps its leading space after punctuation ("done." + " Now…"),
	// but not after a space the draft already has.
	text = draft && !/\s$/u.test(draft) ? text.trimEnd() : text.trim();
	const quote = text[0];
	if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) text = text.slice(1, -1);
	return Array.from(text).slice(0, MAX_SUGGESTION_CHARS).join("");
}

export function parseSuggestions(reply: string, draft: string): string[] {
	let values: unknown;
	try {
		values = JSON.parse(reply.replace(FENCE, "").trim());
	} catch {
		return [];
	}
	if (!Array.isArray(values)) return [];
	const suggestions: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = clean(value, draft);
		if (text && !suggestions.includes(text)) suggestions.push(text);
		if (suggestions.length === SUGGESTIONS) break;
	}
	return suggestions;
}

export interface Shown {
	conversation: string;
	draft: string;
	suggestions: readonly string[];
}

// The user typing the start of a shown suggestion keeps the rest of it on
// screen without asking the model again.
export function typedAhead(shown: Shown | undefined, conversation: string, draft: string): string[] {
	if (!shown || shown.conversation !== conversation) return [];
	if (draft.length <= shown.draft.length || !draft.startsWith(shown.draft)) return [];
	const rest: string[] = [];
	for (const suggestion of shown.suggestions) {
		const whole = shown.draft + suggestion;
		if (whole.length > draft.length && whole.startsWith(draft)) {
			const tail = whole.slice(draft.length);
			if (!rest.includes(tail)) rest.push(tail);
		}
	}
	return rest;
}

export class Lru<V> {
	readonly #entries = new Map<string, V>();
	readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	get size(): number {
		return this.#entries.size;
	}

	get(key: string): V | undefined {
		const value = this.#entries.get(key);
		if (value === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, value);
		return value;
	}

	set(key: string, value: V): void {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		if (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value!);
	}

	clear(): void {
		this.#entries.clear();
	}
}
