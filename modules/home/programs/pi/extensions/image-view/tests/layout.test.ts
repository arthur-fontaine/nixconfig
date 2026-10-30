import assert from "node:assert/strict";
import { test } from "node:test";
import { fitCells, fitRow, imageNumbers, pngSize } from "../layout.ts";

function pngHead(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

test("image numbers come from the draft, deduplicated, in order", () => {
	assert.deepEqual(imageNumbers("look [Image #2] and [Image #1] again [Image #2]"), [2, 1]);
	assert.deepEqual(imageNumbers("[Image 1] [image #3] #4"), []);
});

test("PNG size is read from the IHDR header", () => {
	assert.deepEqual(pngSize(pngHead(1630, 632)), { width: 1630, height: 632 });
	assert.equal(pngSize(Buffer.from("\xff\xd8\xff\xe0 this is a jpeg, not a png...", "latin1")), null);
});

test("thumbnails keep aspect ratio within the tile", () => {
	// Square: 6 rows tall, twice as many columns because cells are tall.
	assert.deepEqual(fitCells({ width: 500, height: 500 }), { columns: 12, rows: 6 });
	// Very wide: capped at 32 columns, rows shrink to match.
	assert.deepEqual(fitCells({ width: 3000, height: 500 }), { columns: 32, rows: 3 });
	// Very tall: never narrower than 4 columns.
	assert.deepEqual(fitCells({ width: 100, height: 2000 }), { columns: 4, rows: 6 });
});

test("a row of tiles shrinks to fit the band so it never scrolls", () => {
	const square = { width: 500, height: 500 };
	// Plenty of room: full 6-row tiles.
	assert.deepEqual(fitRow([square], 20, 120), [{ columns: 12, rows: 6 }]);
	// A short band: border and label take 3 rows, so the picture gets the rest.
	assert.deepEqual(fitRow([square], 7, 120), [{ columns: 8, rows: 4 }]);
	// A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
	assert.deepEqual(fitRow([square, square, square], 20, 40), [
		{ columns: 10, rows: 5 },
		{ columns: 10, rows: 5 },
		{ columns: 10, rows: 5 },
	]);
});
