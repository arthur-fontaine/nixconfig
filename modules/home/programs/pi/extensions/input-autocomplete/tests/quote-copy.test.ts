import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { quoteEdge, skipQuoteBorders } from "../quote-copy.ts";

// As Pi's theme draws `quoteBorder("│ ")`: a 256-color foreground, then back to the default.
const BORDER = "\x1b[38;5;244m│ \x1b[39m";
const quoted = (text: string, depth = 1, pad = 1) => `${" ".repeat(pad)}${BORDER.repeat(depth)}\x1b[3m${text}\x1b[23m`;

test("quoteEdge: the padding and the border of a quoted line", () => {
	assert.equal(quoteEdge(quoted("hello"), BORDER), 3);
	assert.equal(quoteEdge(quoted("hello", 1, 0), BORDER), 2);
});

test("quoteEdge: every border of a nested quote", () => {
	assert.equal(quoteEdge(quoted("deep", 2), BORDER), 5);
});

test("quoteEdge: nothing on a line that isn't quoted, or a table's plain │", () => {
	assert.equal(quoteEdge(" hello │ world", BORDER), 0);
	assert.equal(quoteEdge(" │ a │ b │", BORDER), 0);
	assert.equal(quoteEdge("", BORDER), 0);
});

test("quoteEdge: OSC 133 marks before the padding are skipped", () => {
	assert.equal(quoteEdge(`\x1b]133;A\x07${quoted("hi")}`, BORDER), 3);
});

// Pi's TuiAltScreen, cut down to what the hook relies on: the copied text goes through
// `getSelectionColumns`, as does the highlight.
function renderer(lines: string[]) {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const fake = {
		mode: "fullscreen" as TUI["mode"],
		selection: { start: { row: 0, col: 0 }, end: { row: lines.length - 1, col: 99 } },
		getSelectionColumns(line: string, row: number, selection: typeof fake.selection) {
			const width = strip(line).length;
			return {
				start: row === selection.start.row ? Math.min(selection.start.col, width) : 0,
				end: row === selection.end.row ? Math.min(selection.end.col + 1, width) : width,
			};
		},
		getActiveSelectionText(): string | undefined {
			return lines
				.map((line, row) => {
					const { start, end } = this.getSelectionColumns(line, row, this.selection);
					return strip(line).slice(start, end).trimEnd();
				})
				.join("\n");
		},
		highlight: (row: number) => fake.getSelectionColumns(lines[row] ?? "", row, fake.selection),
	};
	return { fake, tui: fake as unknown as TUI };
}

test("a copy across a quote leaves out its border, the text around it as is", () => {
	const { fake, tui } = renderer([" before", quoted("first line"), quoted("second", 2), "", " after │ x"]);
	skipQuoteBorders(tui, () => BORDER);
	assert.equal(fake.getActiveSelectionText(), " before\nfirst line\nsecond\n\n after │ x");
});

test("a selection starting inside the quote's text keeps its start", () => {
	const { fake, tui } = renderer([quoted("first line")]);
	fake.selection = { start: { row: 0, col: 9 }, end: { row: 0, col: 99 } };
	skipQuoteBorders(tui, () => BORDER);
	assert.equal(fake.getActiveSelectionText(), "line");
});

test("a selection of the border alone copies nothing", () => {
	const { fake, tui } = renderer([quoted("first line")]);
	fake.selection = { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } };
	skipQuoteBorders(tui, () => BORDER);
	assert.equal(fake.getActiveSelectionText(), "");
});

test("the highlight still covers the border", () => {
	const { fake, tui } = renderer([quoted("first line")]);
	skipQuoteBorders(tui, () => BORDER);
	assert.deepEqual(fake.highlight(0), { start: 0, end: 13 });
});

test("a renderer is wrapped once: a reload swaps the border, a shutdown copies as Pi does", () => {
	const { fake, tui } = renderer([quoted("text")]);
	skipQuoteBorders(tui, () => "nope");
	const wrapped = fake.getActiveSelectionText;
	skipQuoteBorders(tui, () => BORDER);
	assert.equal(fake.getActiveSelectionText, wrapped);
	assert.equal(fake.getActiveSelectionText(), "text");
	skipQuoteBorders(tui, undefined);
	assert.equal(fake.getActiveSelectionText(), " │ text");
});

test("regular mode is left alone", () => {
	const { fake, tui } = renderer([quoted("text")]);
	fake.mode = "regular";
	const original = fake.getActiveSelectionText;
	skipQuoteBorders(tui, () => BORDER);
	assert.equal(fake.getActiveSelectionText, original);
});
