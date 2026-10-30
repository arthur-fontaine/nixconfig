import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { kittyRows, kittyTransmit } from "../kitty.ts";
import type { Cells } from "../layout.ts";
import { type Paint, type Tile, TileRow, type TileRowOptions } from "../tiles.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x1b]*\x1b\\/g, "");
const square = { width: 500, height: 500 };
const tile = (n: number, path: string | null = `/blobs/${n}.png`): Tile => ({ id: String(n), label: `#${n}`, alt: `[Image #${n}]`, path, size: square });
const solid: Paint = (_path, { columns, rows }: Cells) => Array.from({ length: rows }, () => "▀".repeat(columns));

function row(tiles: Tile[], options: Partial<TileRowOptions> = {}) {
	const opened: string[] = [];
	const component = new TileRow(tiles, {
		paint: solid,
		open: (path) => opened.push(path),
		maxRows: 9,
		links: () => false,
		dim: (text) => `\x1b[2m${text}\x1b[22m`,
		...options,
	});
	return { component, opened };
}

function click(x: number, y: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 9, shift: false, alt: false, ctrl: false };
}

test("a tile is the picture in a rounded border over its label", () => {
	const lines = row([tile(1)]).component.render(80).map(plain);
	assert.deepEqual(lines, [
		`╭${"─".repeat(12)}╮`,
		...Array.from({ length: 6 }, () => `│${"▀".repeat(12)}│`),
		`│     #1     │`,
		`╰${"─".repeat(12)}╯`,
	]);
});

test("tiles sit side by side, and wrap rather than overflow", () => {
	const lines = row([tile(1), tile(2)], { indent: 2 }).component.render(80).map(plain);
	assert.equal(lines.length, 9);
	assert.equal(lines[0], `  ╭${"─".repeat(12)}╮ ╭${"─".repeat(12)}╮`);
	// Too narrow for even the smallest tiles side by side.
	const narrow = row([tile(1), tile(2), tile(3)]).component.render(10).map(plain);
	assert.ok(narrow.every((line) => [...line].length <= 10));
	assert.equal(narrow.length, 3 * 4);
});

test("a missing file says so, a picture being made shows an ellipsis, a failed one its alt text", () => {
	const missing = row([tile(1, null)]).component.render(80).map(plain);
	assert.ok(missing.some((line) => line.includes("no preview")));
	const pending = row([tile(1)], { paint: () => undefined }).component.render(80).map(plain);
	assert.ok(pending.some((line) => line.includes("…")));
	const failed = row([tile(1)], { paint: () => null }).component.render(80).map(plain);
	assert.ok(failed.some((line) => line.includes("[Image #1]")));
});

test("clicking anywhere on a tile, picture included, opens its file", () => {
	const { component, opened } = row([tile(1), tile(2)], { indent: 2 });
	component.render(80);
	// The second tile's picture: indent 2, first tile 14 wide, a gap.
	assert.deepEqual(component.handleMouse(click(2 + 14 + 1 + 5, 3)), { handled: true });
	// The first tile's label.
	assert.deepEqual(component.handleMouse(click(8, 7)), { handled: true });
	assert.deepEqual(opened, ["/blobs/2.png", "/blobs/1.png"]);
	// The gap, the indent, a press, and a tile without a file do nothing.
	assert.equal(component.handleMouse(click(2 + 14, 3)), undefined);
	assert.equal(component.handleMouse(click(0, 3)), undefined);
	assert.equal(component.handleMouse({ ...click(5, 3), type: "press" }), undefined);
	const none = row([tile(1, null)]);
	none.component.render(80);
	assert.equal(none.component.handleMouse(click(5, 3)), undefined);
	assert.equal(opened.length, 2);
});

test("in regular mode every picture row and the label are also a file link", () => {
	const off = row([tile(1)]).component.render(80);
	assert.ok(off.every((line) => !line.includes("\x1b]8;")));
	const on = row([tile(1)], { links: () => true }).component.render(80);
	const linked = on.filter((line) => line.includes("\x1b]8;id=image-view-1;file:///blobs/1.png\x1b\\"));
	assert.equal(linked.length, 6 + 1);
});

test("where Pi draws the pictures, only the labels are added, still clickable", () => {
	const { component, opened } = row([{ ...tile(1), label: "chart.png" }, tile(2)], { paint: null, indent: 1 });
	assert.deepEqual(component.render(80).map(plain), [" chart.png  #2"]);
	component.handleMouse(click(12, 0));
	assert.deepEqual(opened, ["/blobs/2.png"]);
});

test("a Kitty picture is placeholder cells colored with its image id", () => {
	const rows = kittyRows(0x123456, 3, 2);
	assert.equal(rows.length, 2);
	assert.ok(rows[0]!.startsWith("\x1b[38;2;18;52;86m\u{10eeee}̅̅\u{10eeee}\u{10eeee}"));
	assert.ok(rows[1]!.startsWith("\x1b[38;2;18;52;86m\u{10eeee}̍̅"));
	assert.equal(kittyTransmit("AAAA", 300, 3, 2), "\x1b_Ga=T,U=1,f=100,q=2,i=300,c=3,r=2;AAAA\x1b\\");
	const chunked = kittyTransmit("A".repeat(5000), 300, 3, 2);
	assert.match(chunked, /^\x1b_Ga=T,U=1,f=100,q=2,i=300,c=3,r=2,m=1;A{4096}\x1b\\\x1b_Gm=0;A{904}\x1b\\$/);
});
