// The debug view: the last prompt the extension looked at, the memory it sent with it, and the decision.

import { CATEGORIES } from "./task.ts";
import { MEMORY_LIMIT } from "./tree.ts";

export const WIDGET = "auto-compact-debug";
export const TITLE = "auto-compact debug";

export interface TraceLine {
	name: string;
	source: "raw" | "joined" | "summary";
	bytes: number;
	from: { name: string | null; text: string }[] | null;
}

export interface Trace {
	at: number;
	// As sent to the decision model (clipped), or the cleaned prompt when nothing was sent.
	message: string;
	// The memory lines sent, one per line; null when nothing was sent.
	memory: string | null;
	lines: TraceLine[] | null;
	messages: number | null;
	decision: {
		category: string | null;
		confidence: number | null;
		action: string;
		reason: string;
		probabilities: Record<string, number>;
	} | null;
	outcome: string;
	latencyMs: number | null;
}

export type Tone = "heading" | "dim" | "subtle" | "accent" | "bold" | "success" | "warning" | "error" | "text";
export type Paint = (tone: Tone, text: string) => string;

const ACTION_TONE: Record<string, Tone> = { keep: "success", compact_view: "warning", compact_branch: "warning", clear: "error" };

const pct = (x: number) => Math.round(x * 100) + "%";

// `raw  37 B · 91 left`: where the line came from, its size, and the room left before the
// summarizer would have to compress it. A summary line is compressed already, and its inputs are
// drawn dimmed under it.
export function size(line: TraceLine | undefined) {
	if (!line) return "";
	const bytes = line.source.padEnd(7) + String(line.bytes).padStart(4) + " B";
	return line.source === "summary" ? bytes : bytes + " · " + String(MEMORY_LIMIT - line.bytes).padStart(3) + " left";
}

function clock(at: number) {
	const d = new Date(at);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

// Pi's TUI stops on a line wider than the terminal, so widths are over-estimated: two cells for
// any character from U+1100 on (wide scripts, emoji, joiners) but the symbols this view draws.
const NARROW = new Set(["·", "→", "↳", "█", "░", "…", "≥"]);
const cell = (ch: string) => (ch.codePointAt(0)! < 0x1100 || NARROW.has(ch) ? 1 : 2);
export const cells = (text: string) => [...text].reduce((n, ch) => n + cell(ch), 0);

function cut(text: string, width: number): [string, string] {
	let n = 0;
	let i = 0;
	const chars = [...text];
	while (i < chars.length && n + cell(chars[i]!) <= width) n += cell(chars[i++]!);
	return [chars.slice(0, Math.max(i, 1)).join(""), chars.slice(Math.max(i, 1)).join("")];
}

export function wrap(text: string, width: number) {
	const out: string[] = [];
	// Control characters (tabs, escapes from a pasted terminal) would throw the widths off.
	const clean = text.replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
	for (const paragraph of clean.split("\n")) {
		let line = "";
		for (const word of paragraph.split(/(\s+)/)) {
			if (!word) continue;
			if (cells(line) + cells(word) <= width) {
				line += word;
				continue;
			}
			if (line.trim()) out.push(line.trimEnd());
			line = /^\s+$/.test(word) ? "" : word;
			while (cells(line) > width) {
				const [head, rest] = cut(line, width);
				out.push(head);
				line = rest;
			}
		}
		out.push(line.trimEnd());
	}
	return out;
}

// The last guard: a line still too wide loses its colors and its end.
const ANSI = /\x1b\[[0-9;]*m/g;
export function fit(line: string, width: number) {
	const plain = line.replace(ANSI, "");
	return cells(plain) <= width ? line : cut(plain, width)[0];
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - cells(text)));

export function drawDebug(trace: Trace | null, width: number, paint: Paint): string[] {
	width = Math.max(1, width);
	if (!trace) return wrap("No prompt looked at yet. Send one and it shows here.", width).map((line) => paint("dim", line));
	const out: string[] = [];
	const meta = clock(trace.at) + (trace.latencyMs === null ? "" : " · " + trace.latencyMs + " ms");
	out.push(paint("heading", "Message") + " ".repeat(Math.max(1, width - 7 - meta.length)) + paint("dim", meta));
	for (const line of wrap(trace.message, width)) out.push(line);
	out.push("");

	const memory = trace.memory === null ? [] : trace.memory.split("\n").filter(Boolean).map((line) => {
		const bar = line.indexOf("|");
		return bar < 0 ? ["", line] as const : [line.slice(0, bar), line.slice(bar + 1)] as const;
	});
	const lines = new Map((trace.lines ?? []).map((line) => [line.name, line]));
	const nameWidth = Math.max(0, ...memory.map(([name]) => name.length));
	const sizeWidth = Math.max(0, ...memory.map(([name]) => size(lines.get(name)).length));
	out.push(paint("heading", "Memory" + (trace.memory === null ? "" : " · " + memory.length + " lines") +
		(trace.messages === null ? "" : " over " + trace.messages + " messages")));
	if (trace.memory === null) out.push(paint("dim", "Not sent."));
	const textWidth = Math.max(10, width - nameWidth - sizeWidth - 2);
	const indent = " ".repeat(nameWidth + sizeWidth + 2);
	for (const [name, text] of memory) {
		const line = lines.get(name);
		const wrapped = wrap(text, textWidth);
		out.push(paint("dim", pad(name, nameWidth)) + " " +
			paint(line?.source === "summary" ? "accent" : "subtle", pad(size(line), sizeWidth)) + " " + wrapped[0]);
		for (const rest of wrapped.slice(1)) out.push(indent + rest);
		for (const input of line?.from ?? []) {
			const from = wrap(input.text, textWidth);
			out.push(" ".repeat(nameWidth + 1) + paint("dim", pad("↳ " + (input.name ?? "message"), sizeWidth)) + " " + paint("dim", from[0] ?? ""));
			for (const rest of from.slice(1)) out.push(indent + paint("dim", rest));
		}
	}
	out.push("");

	const d = trace.decision;
	const barWidth = Math.max(8, Math.min(30, width - 26));
	out.push(paint("heading", "Decision"));
	if (d === null) out.push(paint("dim", "None taken."));
	else if (d.category === null) out.push("No answer from the model.");
	else {
		out.push(paint("bold", d.category + " · " + pct(d.confidence ?? 0)) + " → " + paint(ACTION_TONE[d.action] ?? "text", d.action));
		for (const category of CATEGORIES) {
			const p = Number(d.probabilities?.[category] ?? 0);
			const filled = Math.round(p * barWidth);
			const chosen = category === d.category;
			out.push(paint(chosen ? "bold" : "dim", pad(category, 12)) + " " +
				paint(chosen ? "accent" : "subtle", "█".repeat(filled) + "░".repeat(barWidth - filled)) + " " +
				paint(chosen ? "text" : "dim", pct(p).padStart(4)));
		}
	}
	if (d !== null) out.push(paint("dim", "reason: " + d.reason));
	out.push(...wrap("outcome: " + trace.outcome, width));
	return out.map((line) => fit(line, width));
}
