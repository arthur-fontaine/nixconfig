import assert from "node:assert/strict";
import { test } from "node:test";
import { halfBlockRows, parseBmp } from "../halfblock.ts";

// Written by `sips -s format bmp`: 32-bit BI_BITFIELDS, top-down.
// 5×3, pixel (x, y) = rgb(50x, 100y, 128).
const GRADIENT = Buffer.from(
	"Qk3GAAAAAAAAAIoAAAB8AAAABQAAAP3///8BACAAAwAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA/4AAMv+AAGT/gACW/4AAyP+AZAD/gGQy/4BkZP+AZJb/gGTI/4DIAP+AyDL/gMhk/4DIlv+AyMj/",
	"base64",
);
// 2×4: red green / blue white / rgb(10,20,30) transparent / rgb(200,100,50) rgb(1,2,3).
const TILE = Buffer.from(
	"Qk2qAAAAAAAAAIoAAAB8AAAAAgAAAPz///8BACAAAwAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wD/AP//AAD//////x4UCv8AAAAAMmTI/wMCAf8=",
	"base64",
);

test("a sips BMP parses to top-down RGBA", () => {
	const bitmap = parseBmp(GRADIENT);
	assert.equal(bitmap?.width, 5);
	assert.equal(bitmap?.height, 3);
	const at = (x: number, y: number) => Array.from(bitmap!.rgba.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 4));
	assert.deepEqual(at(0, 0), [0, 0, 128, 255]);
	assert.deepEqual(at(4, 0), [200, 0, 128, 255]);
	assert.deepEqual(at(2, 2), [100, 200, 128, 255]);
});

test("a bottom-up 24-bit BMP parses too", () => {
	// 1×2, rows padded to 4 bytes, bottom row first: blue at the bottom, red on top.
	const bytes = new Uint8Array(54 + 8);
	const view = new DataView(bytes.buffer);
	bytes.set([0x42, 0x4d]);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, 1, true);
	view.setInt32(22, 2, true);
	view.setUint16(28, 24, true);
	bytes.set([255, 0, 0, 0, 0, 0, 255, 0], 54);
	assert.deepEqual(Array.from(parseBmp(bytes)!.rgba), [255, 0, 0, 255, 0, 0, 255, 255]);
});

test("not a BMP, or one this parser does not read, is null", () => {
	assert.equal(parseBmp(Buffer.from("\x89PNG\r\n\x1a\n not a bitmap at all, just a png header....", "latin1")), null);
});

test("each cell is an upper half block over two pixels", () => {
	const rows = halfBlockRows(parseBmp(TILE)!, 2, 2);
	assert.deepEqual(rows, [
		"\x1b[38;2;255;0;0;48;2;0;0;255m▀\x1b[38;2;0;255;0;48;2;255;255;255m▀\x1b[39;49m",
		// The transparent pixel takes the terminal's default color.
		"\x1b[38;2;10;20;30;48;2;200;100;50m▀\x1b[39;48;2;1;2;3m▀\x1b[39;49m",
	]);
	// A bitmap that isn't the tile's size is refused rather than drawn skewed.
	assert.equal(halfBlockRows(parseBmp(TILE)!, 2, 3), null);
});

test("a run of one color is set once", () => {
	const bitmap = { width: 3, height: 2, rgba: new Uint8Array(3 * 2 * 4).fill(255) };
	assert.deepEqual(halfBlockRows(bitmap, 3, 1), ["\x1b[38;2;255;255;255;48;2;255;255;255m▀▀▀\x1b[39;49m"]);
});
