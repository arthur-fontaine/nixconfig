// Codemode rows: the calls a script made, each named as its own row would be (`Read(a.txt)`,
// `Bash(<its title or command>)`), listed under compact-tools' "⎿" before the script's output.
// No Pi imports.
import { sliceVisible, spliceVisible, stripAnsi } from "./ansi.ts";
import { displayedCommand, normalizeCommand } from "./command.ts";
import type { Paint } from "./highlight.ts";

export type Status = "running" | "ok" | "error" | "cancelled";
export interface NestedCall {
	name: string;
	// The file, pattern or first argument it names; for bash, `command` instead, titled as it is drawn.
	target: string;
	command?: string;
	status: Status;
	error?: string;
	/** A bash call's first output lines and how many it printed, for its preview under the call. */
	output?: Preview;
}

export interface Preview {
	lines: string[];
	total: number;
}

// Claude Code's names, as compact-tools gives the rows of these tools.
const LABELS: Readonly<Record<string, string>> = {
	read: "Read",
	grep: "Search",
	find: "Search",
	ls: "List",
	bash: "Bash",
	edit: "Update",
	write: "Write",
};

const MAX_PARENTS = 500;
const MAX_CALLS = 256;
const MAX_TARGET = 200;
// Above any command bash-titles names; a longer one is shown by its first line only.
const MAX_COMMAND = 20_000;
export const COLLAPSED_CALLS = 5;
// A bash call's preview, as kept in the session: its first lines, each cut, for this many calls.
export const PREVIEW_LINES = 2;
const PREVIEW_CHARS = 300;
const MAX_PREVIEWS = 32;

/** What a command printed, as its preview keeps it; nothing for no output. */
export function previewOf(text: string): Preview | undefined {
	const lines = stripAnsi(text).replace(/\r\n?/g, "\n").trimEnd().split("\n");
	if (!lines.join("").trim() || (lines.length === 1 && lines[0] === "(no output)")) return undefined;
	return { lines: lines.slice(0, PREVIEW_LINES).map((line) => line.slice(0, PREVIEW_CHARS).trimEnd()), total: lines.length };
}

function isPreview(value: unknown): value is Preview {
	const preview = value as Preview | undefined;
	return Array.isArray(preview?.lines) && preview.lines.every((line) => typeof line === "string") && typeof preview.total === "number";
}

function firstLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	const line = lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
	return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET - 1)}…` : line;
}

export function targetOf(name: string, args: unknown): Pick<NestedCall, "target" | "command"> {
	const values = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	if (name === "bash") return { target: "", command: (text(values.command) ?? "").slice(0, MAX_COMMAND) };
	const path = text(values.path) ?? text(values.file_path);
	if (name === "grep" || name === "find") return { target: firstLine(text(values.pattern) ?? path ?? "") };
	if (path !== undefined) return { target: firstLine(path) };
	if (name === "ls") return { target: "." };
	const first = Object.values(values).find((value) => typeof value === "string" && value.trim());
	return { target: first ? firstLine(first as string) : "" };
}

// Ids Pi gives nested calls are `<caller id>/<n>`, and the calls those make `<caller id>/<n>/<m>`.
const rootOf = (id: string) => id.split("/", 1)[0]!;

/** The nested calls of each script, by its call id: live from Pi's events, or from its saved result. */
export class NestedCalls {
	readonly #parents = new Map<string, { live: boolean; calls: Map<string, NestedCall> }>();

	start(parent: string, id: string, name: string, args: unknown): void {
		const root = rootOf(parent);
		let entry = this.#parents.get(root);
		if (!entry?.live) {
			entry = { live: true, calls: new Map() };
			this.#parents.set(root, entry);
			this.#trim();
		}
		if (entry.calls.has(id) || entry.calls.size >= MAX_CALLS) return;
		entry.calls.set(id, { name, ...targetOf(name, args), status: "running" });
	}

	end(parent: string, id: string, isError: boolean, text?: string): void {
		const call = this.#parents.get(rootOf(parent))?.calls.get(id);
		if (!call) return;
		call.status = isError ? "error" : "ok";
		if (isError && text) call.error = firstLine(text);
		if (!isError && text && call.name === "bash") call.output = previewOf(text);
	}

	/** The previews of a script's calls by call id, for its result's details: a resumed row shows them too. */
	outputs(id: string): Record<string, Preview> {
		const entries = [...(this.#parents.get(id)?.calls ?? [])].filter(([, call]) => call.output).slice(0, MAX_PREVIEWS);
		return Object.fromEntries(entries.map(([callId, call]) => [callId, call.output!]));
	}

	/**
	 * A saved result's `nestedCalls` (`{ calls: [{ id, name, arguments?, status }] }`) and the previews
	 * kept in its details (`callOutputs`), unless the calls were seen live.
	 */
	restore(message: unknown): boolean {
		const value = message as { role?: unknown; toolCallId?: unknown; nestedCalls?: { calls?: unknown }; details?: { callOutputs?: unknown } } | undefined;
		if (value?.role !== "toolResult" || typeof value.toolCallId !== "string" || !Array.isArray(value.nestedCalls?.calls)) return false;
		if (this.#parents.get(value.toolCallId)?.live) return false;
		const calls = new Map<string, NestedCall>();
		for (const item of value.nestedCalls.calls.slice(0, MAX_CALLS)) {
			const call = item as { id?: unknown; name?: unknown; arguments?: unknown; status?: unknown };
			if (typeof call.id !== "string" || typeof call.name !== "string") continue;
			const status: Status = call.status === "ok" || call.status === "error" ? call.status : "cancelled";
			const output = (value.details?.callOutputs as Record<string, unknown> | undefined)?.[call.id];
			calls.set(call.id, { name: call.name, ...targetOf(call.name, call.arguments), status, ...(isPreview(output) && { output }) });
		}
		this.#parents.set(value.toolCallId, { live: false, calls });
		this.#trim();
		return true;
	}

	of(id: string): NestedCall[] {
		return [...(this.#parents.get(id)?.calls.values() ?? [])];
	}

	clear(): void {
		this.#parents.clear();
	}

	#trim(): void {
		while (this.#parents.size > MAX_PARENTS) this.#parents.delete(this.#parents.keys().next().value!);
	}
}

/** The script as an opened row shows it, in JavaScript colors. */
export function scriptLines(paint: Paint, code: string): string[] {
	const script = normalizeCommand(code).trimEnd();
	return paint.code(script, "javascript") ?? script.split("\n");
}

/** One call as its own row's title: `Update(src/a.ts)`, `Bash(Runs the unit tests)`. */
export function callLine(paint: Paint, call: NestedCall, title: (command: string) => string | undefined, cwd: string): string {
	const label = LABELS[call.name] ?? call.name;
	const target = call.command === undefined ? call.target : (title(call.command) ?? firstLine(displayedCommand(normalizeCommand(call.command), cwd)));
	const text = paint.fg("toolTitle", paint.bold(label)) + (target ? paint.fg("toolOutput", `(${target})`) : "");
	if (call.status === "error") return `${paint.fg("error", "✗")} ${text}`;
	if (call.status === "running") return `${text} ${paint.fg("warning", "…")}`;
	if (call.status === "cancelled") return `${paint.fg("muted", "⊘")} ${text}`;
	return text;
}

/** A call as its row names it, in plain words: a command's title, or the tool and what it named. */
function callText(call: NestedCall, title: (command: string) => string | undefined, cwd: string): string {
	const label = LABELS[call.name] ?? call.name;
	// A resumed call can have lost its arguments (Pi drops those over 8 KB): its tool, then.
	if (call.command !== undefined) return title(call.command) ?? (firstLine(displayedCommand(normalizeCommand(call.command), cwd)) || label);
	return call.target ? `${label} ${call.target}` : label;
}

const CALLS_TOOLS = /\btools\s*(\.|\[)/;

/**
 * What a script's row is titled until bash-titles names it, or when it won't (a script making one
 * call): its one call's own title, the tools its calls used, or "…" until they start. The script's
 * first line, often a variable it sets, only for a script calling no tool. Undefined: that line.
 * While the script is still being written (`complete` false), "…": its first line is all there is.
 */
export function scriptTitle(code: string, calls: readonly NestedCall[], title: (command: string) => string | undefined, cwd: string, complete = true): string | undefined {
	if (!complete) return "…";
	if (calls.length === 1) return callText(calls[0]!, title, cwd);
	if (calls.length > 1) return [...new Set(calls.map((call) => LABELS[call.name] ?? call.name))].join(", ");
	return CALLS_TOOLS.test(code) ? "…" : undefined;
}

/**
 * A bash call's output under it, as its own row would preview it, behind the "│" the script's
 * output has: none when the script's output (`shown`) already has those lines.
 */
function previewLines(paint: Paint, preview: Preview | undefined, shown: string): string[] {
	if (!preview) return [];
	const plain = stripAnsi(shown);
	if (preview.lines.every((line) => !line.trim() || plain.includes(line.trim()))) return [];
	const rail = `  ${paint.fg("dim", "│ ")}`;
	const hidden = preview.total - preview.lines.length;
	return [
		...preview.lines.map((line) => rail + paint.fg("dim", line)),
		...(hidden > 0 ? [rail + paint.fg("dim", `… +${hidden} line${hidden === 1 ? "" : "s"}`)] : []),
	];
}

/**
 * The list under a script's row: every call once opened, with the reason a call failed; the first
 * few otherwise. A bash call previews its output, unless the script's own `output` shows it.
 */
export function callLines(
	paint: Paint,
	calls: readonly NestedCall[],
	title: (command: string) => string | undefined,
	cwd: string,
	expanded: boolean,
	output = "",
): string[] {
	const shown = expanded || calls.length <= COLLAPSED_CALLS ? calls : calls.slice(0, COLLAPSED_CALLS - 1);
	const lines = shown.flatMap((call) => [
		callLine(paint, call, title, cwd),
		...(expanded && call.error ? [`  ${paint.fg("error", call.error)}`] : []),
		...previewLines(paint, call.output, output),
	]);
	const hidden = calls.length - shown.length;
	if (hidden > 0) lines.push(paint.fg("muted", `… +${hidden} more call${hidden === 1 ? "" : "s"} (ctrl+o to expand)`));
	return lines;
}

const RAIL = /^( *⎿ +)/;

/**
 * `lines` first under the result's "⎿", what was there after them, in the same column. A result
 * drawn without the rail (another style) gets them on top, `indent` in.
 */
export function underRail(drawn: readonly string[], lines: readonly string[], indent: string): string[] {
	if (!lines.length) return [...drawn];
	const at = drawn.findIndex((line) => RAIL.test(stripAnsi(line)));
	if (at < 0) return [...lines.map((line) => indent + line), ...drawn];
	const width = RAIL.exec(stripAnsi(drawn[at]!))![1]!.length;
	const pad = " ".repeat(width);
	return [
		...drawn.slice(0, at),
		sliceVisible(drawn[at]!, 0, width) + lines[0],
		...lines.slice(1).map((line) => pad + line),
		spliceVisible(drawn[at]!, 0, width, pad),
		...drawn.slice(at + 1),
	];
}

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const SCRIPT_ERROR = "Script error:\n";
const contents = new WeakMap<object, unknown[]>();
const details = new WeakMap<object, unknown>();

type Result = { content: readonly unknown[]; details?: unknown };

/**
 * The result as the renderers after this one get it: without Pi's "Script completed / Wall time /
 * Output:" header, which Pi's own codemode row leaves out too, its error first when it failed, and
 * without the calls and their previews in `details`,
 * which Pi's row would list again as JSON once opened. The same input gives the same objects, so
 * compact-tools still reuses what it drew.
 */
export function forInner<T extends Result>(result: T): T {
	let content = contents.get(result.content);
	if (!content) {
		const [first, ...rest] = result.content as { type?: string; text?: string }[];
		content = first?.type === "text" && SCRIPT_HEADER.test(first.text ?? "") ? rest : [...result.content];
		// compact-tools heads a failed row with its first line: the error, not the output before it.
		const failure = content.findIndex((item) => {
			const text = (item as { text?: unknown }).text;
			return typeof text === "string" && (text.startsWith(SCRIPT_ERROR) || text.includes(`\n${SCRIPT_ERROR}`));
		});
		if (failure >= 0) {
			const item = content[failure] as { type: string; text: string };
			const at = item.text.startsWith(SCRIPT_ERROR) ? 0 : item.text.indexOf(`\n${SCRIPT_ERROR}`) + 1;
			const before = item.text.slice(0, at).replace(/\n$/, "");
			content = [
				{ ...item, text: item.text.slice(at + SCRIPT_ERROR.length) },
				...content.slice(0, failure),
				...(before ? [{ ...item, text: before }] : []),
				...content.slice(failure + 1),
			];
		}
		contents.set(result.content, content);
	}
	let own = result.details;
	if (typeof own === "object" && own !== null && ("calls" in own || "callOutputs" in own)) {
		if (!details.has(own)) {
			const { callOutputs: _previews, ...rest } = own as Record<string, unknown>;
			details.set(own, "calls" in rest ? { ...rest, calls: [] } : rest);
		}
		own = details.get(own);
	}
	return { ...result, content, details: own };
}
