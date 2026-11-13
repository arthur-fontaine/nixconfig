import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, showsGlow } from "../glow.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/frame-${name}.png`, import.meta.url));

// Frames of Pi's video from the live run, scaled to 320 px: the extension's orange glow
// (and its "Claude is working here" pill), the glow fading in, and a clean frame.
test("a frame showing the extension's glow is recognised, faint or not; a clean one isn't", () => {
	assert.equal(showsGlow(decodePng(fixture("glow"))!), true);
	assert.equal(showsGlow(decodePng(fixture("glow-faint"))!), true);
	assert.equal(showsGlow(decodePng(fixture("clean"))!), false);
});

/** A PNG of a flat colour, with a border of another on the given edges, rows written with `filter`. */
function png(width: number, height: number, fill: number[], border: number[], edges: string, filter = 0): Buffer {
	const px = (x: number, y: number) => {
		const band = Math.max(1, Math.round(width * 0.006));
		const on = (edges.includes("l") && x < band) || (edges.includes("r") && x >= width - band) || (edges.includes("t") && y < band) || (edges.includes("b") && y >= height - band);
		return on ? border : fill;
	};
	const raw: number[] = [];
	for (let y = 0; y < height; y++) {
		raw.push(filter);
		for (let x = 0; x < width; x++) {
			const cur = px(x, y);
			const left = x > 0 ? px(x - 1, y) : [0, 0, 0];
			const up = y > 0 ? px(x, y - 1) : [0, 0, 0];
			for (let c = 0; c < 3; c++) raw.push(filter === 1 ? (cur[c]! - left[c]! + 256) & 255 : filter === 2 ? (cur[c]! - up[c]! + 256) & 255 : cur[c]!);
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
}

const ORANGE = [217, 119, 87];
const WHITE = [255, 255, 255];

test("the glow is an orange band on (at least three of) the page's four edges", () => {
	assert.equal(showsGlow(decodePng(png(200, 150, WHITE, ORANGE, "lrtb"))!), true);
	assert.equal(showsGlow(decodePng(png(200, 150, WHITE, ORANGE, "lrt"))!), true);
	assert.equal(showsGlow(decodePng(png(200, 150, WHITE, ORANGE, "l"))!), false, "an orange sidebar is not the glow");
	assert.equal(showsGlow(decodePng(png(200, 150, ORANGE, ORANGE, "lrtb"))!), false, "an orange page is not the glow");
	assert.equal(showsGlow(decodePng(png(200, 150, WHITE, WHITE, ""))!), false);
});

test("rows written with the Sub and Up filters decode to the same pixels", () => {
	const plain = decodePng(png(40, 30, WHITE, ORANGE, "lrtb", 0))!;
	for (const filter of [1, 2]) assert.deepEqual(decodePng(png(40, 30, WHITE, ORANGE, "lrtb", filter))!.data, plain.data);
});

test("what isn't an 8-bit RGB(A) PNG decodes to nothing", () => {
	assert.equal(decodePng(Buffer.from("not a png")), undefined);
});
