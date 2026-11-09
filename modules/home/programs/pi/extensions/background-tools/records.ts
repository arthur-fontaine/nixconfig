// What a detached call leaves in the session, and the message that brings its
// final output to the model. No Pi runtime imports, so tests run without
// node_modules.

export const RECORD_TYPE = "background-tools.result";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface Result {
	content: Content[];
	details: unknown;
}

/** The details of the result a detached call returns right away. */
export interface PlaceholderDetails {
	background: { startedAt: number };
}

export type Ending = "completed" | "failed" | "stopped" | "interrupted";

/** The final outcome of a detached call, kept as a custom entry. */
export interface DetachedRecord {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	endedAt: number;
	ending: Ending;
	content: Content[];
	details?: unknown;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	content: Content[];
	details?: unknown;
	isError: boolean;
}

/** The subset of a session entry this module reads. */
export interface Entry {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
	targetId?: string;
	message?: { role: string; toolCallId?: string; details?: unknown };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function placeholderDetails(startedAt: number): PlaceholderDetails {
	return { background: { startedAt } };
}

export function placeholderStart(details: unknown): number | undefined {
	if (!isObject(details) || !isObject(details.background)) return undefined;
	const startedAt = details.background.startedAt;
	return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : undefined;
}

export function placeholderText(toolCallId: string): string {
	return [
		`Detached: the command keeps running in the background as ${toolCallId}.`,
		"When it ends, its final output is sent to you as a message.",
		"Until then, bash_output shows what it has printed so far and bash_kill stops it.",
	].join(" ");
}

export function placeholder(toolCallId: string, startedAt: number): Result {
	return { content: [{ type: "text", text: placeholderText(toolCallId) }], details: placeholderDetails(startedAt) };
}

export const isError = (ending: Ending) => ending !== "completed";

function isContent(value: unknown): value is Content {
	if (!isObject(value)) return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
	return false;
}

const ENDINGS: readonly Ending[] = ["completed", "failed", "stopped", "interrupted"];

/** A record read back from a custom entry, or undefined when it isn't one. */
export function readRecord(entry: Entry): DetachedRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== RECORD_TYPE) return undefined;
	const data = entry.data;
	if (!isObject(data)) return undefined;
	const { toolCallId, toolName, startedAt, endedAt, ending, content } = data;
	if (typeof toolCallId !== "string" || !toolCallId || typeof toolName !== "string") return undefined;
	if (typeof startedAt !== "number" || typeof endedAt !== "number") return undefined;
	if (!ENDINGS.includes(ending as Ending) || !Array.isArray(content) || !content.every(isContent)) return undefined;
	return { toolCallId, toolName, startedAt, endedAt, ending: ending as Ending, content, details: data.details };
}

/** Records on a branch by tool call id; a later record for the same call wins. */
export function recordsOn(branch: readonly Entry[]): Map<string, DetachedRecord> {
	const records = new Map<string, DetachedRecord>();
	for (const entry of branch) {
		const record = readRecord(entry);
		if (record) records.set(record.toolCallId, record);
	}
	return records;
}

/** Placeholders on a branch, by tool call id, with their entry ids. */
export function placeholdersOn(branch: readonly Entry[]): Map<string, { entryId: string; startedAt: number }> {
	const found = new Map<string, { entryId: string; startedAt: number }>();
	for (const entry of branch) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult" || !message.toolCallId) continue;
		const startedAt = placeholderStart(message.details);
		if (startedAt !== undefined) found.set(message.toolCallId, { entryId: entry.id, startedAt });
	}
	return found;
}

export function interruptedRecord(toolCallId: string, toolName: string, startedAt: number, endedAt: number): DetachedRecord {
	return {
		toolCallId,
		toolName,
		startedAt,
		endedAt,
		ending: "interrupted",
		content: [{ type: "text", text: "Interrupted: Pi stopped before this background command ended, and it is not resumed." }],
		details: undefined,
	};
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ${Math.floor((ms % 60_000) / 1_000)}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function textOf(content: readonly Content[] | undefined): string {
	return (content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function lastLines(text: string, lines: number | undefined): string {
	if (!lines) return text;
	return text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
}

export function stateLine(id: string, state: { running: boolean; ending?: Ending; elapsedMs: number }): string {
	const elapsed = formatDuration(state.elapsedMs);
	if (state.running) return `${id} is still running (${elapsed} so far).`;
	const verb = { completed: "completed", failed: "failed", stopped: "was stopped", interrupted: "was interrupted" }[state.ending ?? "completed"];
	return `${id} ${verb} after ${elapsed}.`;
}

export function report(heading: string, output: string): Result {
	return { content: [{ type: "text", text: `${heading}\n\n${output.trim() ? output : "(no output yet)"}` }], details: undefined };
}

export function unknownCall(id: string, running: readonly string[]): string {
	return `No background call ${id}. Running in the background: ${running.length ? running.join(", ") : "none"}.`;
}

/**
 * The follow-up that wakes the model when a detached call ends on its own, with
 * its final output. Writing the output over the placeholder instead would change
 * an earlier message and void the prompt cache from there on: one such edit
 * rewrote 896k tokens.
 */
export function completionNotice(record: DetachedRecord): string {
	const status = record.ending === "completed" ? "completed" : "failed";
	const images = record.content.filter((part) => part.type === "image").length;
	return [
		`<background-result tool="${record.toolName}" id="${record.toolCallId}" status="${status}" elapsed="${formatDuration(record.endedAt - record.startedAt)}">`,
		textOf(record.content).trim() || "(no output)",
		...(images ? [`(${images} image${images === 1 ? "" : "s"} in the output, not shown)`] : []),
		"</background-result>",
	].join("\n");
}
