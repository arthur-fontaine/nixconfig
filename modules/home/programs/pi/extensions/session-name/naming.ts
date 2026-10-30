// The pure part of session-name: what a name may look like, what the model is shown, how its
// reply is read, and when a named session is worth checking again. No Pi runtime imports, so the
// tests run without Pi.

export const ENTRY_TYPE = "session-name";
// Claude Code caps a name at 200 code points; an address someone types after `@` wants far less.
export const CC_MAX_CHARS = 200;
export const MAX_CHARS = 40;
// Claude Code's /rename keeps the last 1000 characters (RGn); a keep/rename check needs to see
// more than the latest reply, so it gets a longer tail with each message clipped.
export const NAMING_CHARS = 1000;
export const CHECK_CHARS = 3000;
const MESSAGE_CHARS = 600;
const INTERCOM_MESSAGE = "intercom_message";
const INTERCOM_TOOLS = new Set(["intercom", "contact_supervisor"]);

export type Mode = "auto" | "manual";

export interface ModeEntry {
	mode: Mode;
	name?: string;
}

export const POLICY = {
	// Quiet time after a run settles before a re-check, so a quick follow-up doesn't pay for one.
	debounceMs: 20_000,
	// What must have happened since the last check: a new prompt and some real conversation. With
	// each message clipped to MESSAGE_CHARS, one substantial exchange is enough; "thanks" is not.
	minNewPrompts: 1,
	minNewChars: 800,
	// The interval doubles with each "keep" in a row: a session that stays on task is asked less.
	minIntervalMs: 2 * 60_000,
	maxIntervalMs: 30 * 60_000,
	// Intercom traffic this recent means a peer may be about to use the current name.
	exchangeQuietMs: 10 * 60_000,
};

export type Policy = typeof POLICY;

// Loose on purpose: other extensions add their own entry and message shapes.
export interface EntryLike {
	type: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	message?: { role?: string; content?: unknown };
}

// Claude Code's Xi: format and control characters out, at most 200 code points.
export function sanitize(text: string): string {
	const spaced = text.trim().replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");
	return [...spaced.replace(/[\x00-\x1f\x7f-\x9f]/g, "")].slice(0, CC_MAX_CHARS).join("").trim();
}

// What Claude Code compares names by (Eo): case and spacing don't make two names different.
export function nameKey(name: string): string {
	return name.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").trim().toLowerCase().replace(/\s+/g, "-");
}

// A name that works as an `@` address: lowercase words joined by hyphens, cut at a word boundary.
// Claude Code keeps a typed name as typed; here `/rename My Feature` becomes `my-feature`.
export function toAddress(text: string, max = MAX_CHARS): string {
	const words = sanitize(text).normalize("NFKC").toLowerCase().replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	let name = "";
	for (const word of words) {
		const next = name ? `${name}-${word}` : word;
		if (next.length > max) break;
		name = next;
	}
	return name || [...(words[0] ?? "")].slice(0, max).join("");
}

// Claude Code adds a random adjective-noun on a collision; a number is easier to type after `@`.
export function uniqueName(name: string, taken: Iterable<string>, max = MAX_CHARS): string {
	const keys = new Set([...taken].map(nameKey));
	if (!keys.has(nameKey(name))) return name;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = `${toAddress(name, max - suffix.length)}${suffix}`;
		if (!keys.has(nameKey(candidate))) return candidate;
	}
}

function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b: { type?: string; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
}

function clip(text: string, max: number) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function lines(entries: readonly EntryLike[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
			const text = blocksText(entry.message.content);
			if (text.trim()) out.push(`${entry.message.role === "user" ? "User" : "Assistant"}: ${clip(text, MESSAGE_CHARS)}`);
		} else if (entry.type === "custom_message" && entry.customType === INTERCOM_MESSAGE) {
			const text = blocksText(entry.content);
			if (text.trim()) out.push(`Message from another session: ${clip(text, MESSAGE_CHARS)}`);
		}
	}
	return out;
}

// The user and assistant text of the branch, like Claude Code's RGn, without tool calls and
// results; the tail of it when it runs past `max`.
export function condense(entries: readonly EntryLike[], max = NAMING_CHARS): string {
	const text = lines(entries).join("\n");
	return text.length > max ? text.slice(-max) : text;
}

export interface Progress {
	prompts: number;
	chars: number;
}

export function progress(entries: readonly EntryLike[]): Progress {
	let prompts = 0;
	for (const e of entries) if (e.type === "message" && e.message?.role === "user") prompts++;
	return { prompts, chars: lines(entries).join("\n").length };
}

export interface Checkpoint extends Progress {
	at: number;
	// "keep" answers in a row since the last rename.
	keeps: number;
}

// "rebase": the branch shrank (tree navigation, a fork), so measure from where it is now.
export function shouldCheck(last: Checkpoint, now: Progress, at: number, policy: Policy = POLICY): "check" | "wait" | "rebase" {
	if (now.prompts < last.prompts || now.chars < last.chars) return "rebase";
	if (now.prompts - last.prompts < policy.minNewPrompts || now.chars - last.chars < policy.minNewChars) return "wait";
	const interval = Math.min(policy.minIntervalMs * 2 ** last.keeps, policy.maxIntervalMs);
	return at - last.at >= interval ? "check" : "wait";
}

// Intercom left a trace in the recent transcript: a message from a peer, or a call to its tool.
// A peer that holds this session's name without either (an ask it hasn't sent yet) can't be seen.
export function recentExchange(entries: readonly EntryLike[], at: number, quietMs = POLICY.exchangeQuietMs): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const time = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
		if (Number.isFinite(time) && at - time > quietMs) return false;
		if (entry.type === "custom_message" && entry.customType === INTERCOM_MESSAGE) return true;
		if (entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
			if (entry.message.content.some((b: { type?: string; name?: unknown }) => b?.type === "toolCall" && INTERCOM_TOOLS.has(String(b.name)))) return true;
		}
	}
	return false;
}

function isModeEntry(data: unknown): data is ModeEntry {
	const d = data as ModeEntry | undefined;
	return !!d && (d.mode === "auto" || d.mode === "manual") && (d.name === undefined || typeof d.name === "string");
}

// The mode a session resumes in. Pi keeps one name per session file, whatever the branch, so the
// latest entry of the whole file counts. A name with no entry, or other than the one recorded
// (`pi --name`, `/name`, intercom's `/alias` while this extension wasn't loaded), was given by hand.
export function restoreMode(entries: readonly EntryLike[], currentName: string | undefined): Mode {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isModeEntry(entry.data)) continue;
		if (entry.data.mode === "manual") return currentName ? "manual" : "auto";
		return !currentName || currentName === entry.data.name ? "auto" : "manual";
	}
	return currentName ? "manual" : "auto";
}

export type Reply = { action: "keep" } | { action: "rename"; name: string };

function jsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const value = JSON.parse(text.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const BARE_NAME = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

// Pi's providers take no JSON schema, so the reply is asked for as JSON and read leniently:
// the first object in it, else a bare kebab-case name.
export function parseReply(text: string): Reply | undefined {
	const object = jsonObject(text);
	if (object) {
		if (object.action === "keep" || object.keep === true) return { action: "keep" };
		if (typeof object.name === "string" && object.name.trim()) return { action: "rename", name: object.name };
		return undefined;
	}
	const bare = text.trim().replace(/^["'`]+|["'`.]+$/g, "");
	if (bare.toLowerCase() === "keep") return { action: "keep" };
	return BARE_NAME.test(bare) ? { action: "rename", name: bare } : undefined;
}

function words(name: string) {
	return new Set(nameKey(name).replace(/-\d+$/, "").split("-").filter(Boolean));
}

// The model's answer, held to the bar of a real change of task: a name that only adds, drops or
// reorders words of the current one is the same task said differently, and keeps the address.
export function decide(current: string, reply: Reply | undefined): { kind: "keep" } | { kind: "rename"; name: string } {
	if (!reply || reply.action === "keep") return { kind: "keep" };
	const name = toAddress(reply.name);
	if (!name) return { kind: "keep" };
	const before = words(current);
	const after = words(name);
	const subset = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
	if (subset(after, before) || subset(before, after)) return { kind: "keep" };
	return { kind: "rename", name };
}
