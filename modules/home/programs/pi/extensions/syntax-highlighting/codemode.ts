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

	end(parent: string, id: string, isError: boolean, errorText?: string): void {
		const call = this.#parents.get(rootOf(parent))?.calls.get(id);
		if (!call) return;
		call.status = isError ? "error" : "ok";
		if (isError && errorText) call.error = firstLine(errorText);
	}

	/** A saved result's `nestedCalls` (`{ calls: [{ id, name, arguments?, status }] }`), unless the calls were seen live. */
	restore(message: unknown): boolean {
		const value = message as { role?: unknown; toolCallId?: unknown; nestedCalls?: { calls?: unknown } } | undefined;
		if (value?.role !== "toolResult" || typeof value.toolCallId !== "string" || !Array.isArray(value.nestedCalls?.calls)) return false;
		if (this.#parents.get(value.toolCallId)?.live) return false;
		const calls = new Map<string, NestedCall>();
		for (const item of value.nestedCalls.calls.slice(0, MAX_CALLS)) {
			const call = item as { id?: unknown; name?: unknown; arguments?: unknown; status?: unknown };
			if (typeof call.id !== "string" || typeof call.name !== "string") continue;
			const status: Status = call.status === "ok" || call.status === "error" ? call.status : "cancelled";
			calls.set(call.id, { name: call.name, ...targetOf(call.name, call.arguments), status });
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

/** The list under a script's row: every call once opened, with the reason a call failed; the first few otherwise. */
export function callLines(
	paint: Paint,
	calls: readonly NestedCall[],
	title: (command: string) => string | undefined,
	cwd: string,
	expanded: boolean,
): string[] {
	const shown = expanded || calls.length <= COLLAPSED_CALLS ? calls : calls.slice(0, COLLAPSED_CALLS - 1);
	const lines = shown.flatMap((call) => [
		callLine(paint, call, title, cwd),
		...(expanded && call.error ? [`  ${paint.fg("error", call.error)}`] : []),
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
 * without the calls in `details`,
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
			return typeof text === "string" && text.startsWith(SCRIPT_ERROR);
		});
		if (failure >= 0) {
			const item = content[failure] as { text: string };
			content = [{ ...item, text: item.text.slice(SCRIPT_ERROR.length) }, ...content.filter((_, i) => i !== failure)];
		}
		contents.set(result.content, content);
	}
	let own = result.details;
	if (typeof own === "object" && own !== null && "calls" in own) {
		own = details.get(own) ?? { ...own, calls: [] };
		details.set(result.details as object, own);
	}
	return { ...result, content, details: own };
}
