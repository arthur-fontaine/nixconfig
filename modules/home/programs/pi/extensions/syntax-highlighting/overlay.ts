// Recolors text another renderer drew, without redrawing it: each drawn line
// is matched, in order, against the logical lines of a source document, and
// the matched run takes the document's colors. Everything the renderer added
// around it (prompts, hints, timers, other extensions' lines) stays as drawn.
import { FG_RESET, sliceVisible, spliceVisible, stripAnsi } from "./ansi.ts";

export interface Document {
	/** Logical lines, as the renderer was given them (tabs already expanded). */
	plain: string[];
	/** The same lines styled; each line's visible text equals `plain`'s. */
	styled: string[];
}

export interface OverlayOptions {
	/**
	 * `line`: a drawn line is entirely a piece of one logical line (tool output).
	 * `run`: the piece sits among other text on the line (a command after a prompt).
	 */
	match: "line" | "run";
	/** Drawn lines to leave alone, e.g. those not styled as plain output. */
	accept?: (line: string) => boolean;
	/** Restyles the text right before the first run, e.g. a `$ ` prompt. */
	lead?: { text: string; styled: string };
}

interface Cursor {
	line: number;
	column: number;
}

interface Match {
	line: number;
	from: number;
	length: number;
	at: number;
}

const leadingSpaces = (text: string) => text.length - text.trimStart().length;

// Word wrapping drops the spaces at a break and keeps a line's indentation.
function matchLine(drawn: string, plain: string[], cursor: Cursor): Match | undefined {
	const text = drawn.trimEnd();
	if (!text) return undefined;
	if (cursor.column > 0) {
		const rest = plain[cursor.line]!.slice(cursor.column);
		const skip = rest.startsWith(text) ? 0 : leadingSpaces(rest);
		if (rest.startsWith(text, skip)) return { line: cursor.line, from: cursor.column + skip, length: text.length, at: 0 };
	}
	for (let line = cursor.column > 0 ? cursor.line + 1 : cursor.line; line < plain.length; line++) {
		if (plain[line]!.startsWith(text)) return { line, from: 0, length: text.length, at: 0 };
	}
	return undefined;
}

// Long enough that a match is no coincidence; shorter runs must reach the end
// of the drawn text (a wrap) or of the logical line.
const CONFIDENT = 8;

function matchRun(drawn: string, plain: string[], cursor: Cursor): Match | undefined {
	let { line, column } = cursor;
	while (line < plain.length && !plain[line]!.slice(column).trim()) {
		line++;
		column = 0;
	}
	if (line >= plain.length) return undefined;
	const rest = plain[line]!.slice(column);
	const from = column + leadingSpaces(rest);
	const target = plain[line]!.slice(from);
	const end = drawn.trimEnd().length;
	let best: Match | undefined;
	for (let at = drawn.indexOf(target[0]!); at >= 0; at = drawn.indexOf(target[0]!, at + 1)) {
		let length = 1;
		while (length < target.length && drawn[at + length] === target[length]) length++;
		if (!best || length > best.length) best = { line, from, length, at };
	}
	if (!best) return undefined;
	const certain = best.length === target.length || best.length >= CONFIDENT || best.at + best.length >= end;
	return certain ? best : undefined;
}

export function overlay(lines: readonly string[], doc: Document, options: OverlayOptions): string[] {
	const cursor: Cursor = { line: 0, column: 0 };
	let led = false;
	return lines.map((line) => {
		if (cursor.line >= doc.plain.length || (options.accept && !options.accept(line))) return line;
		const drawn = stripAnsi(line);
		const match = options.match === "line" ? matchLine(drawn, doc.plain, cursor) : matchRun(drawn, doc.plain, cursor);
		if (!match) return line;
		cursor.line = match.line;
		cursor.column = match.from + match.length;
		let start = match.at;
		let replacement = sliceVisible(doc.styled[match.line]!, match.from, match.from + match.length);
		const lead = options.lead;
		if (lead && !led && start >= lead.text.length && drawn.slice(start - lead.text.length, start) === lead.text) {
			start -= lead.text.length;
			replacement = lead.styled + FG_RESET + replacement;
		}
		led = true;
		return spliceVisible(line, start, match.at + match.length, replacement);
	});
}
