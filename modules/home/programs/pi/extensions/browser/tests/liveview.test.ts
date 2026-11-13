import assert from "node:assert/strict";
import { test } from "node:test";
import { fitFrame, type Frame, FramePump, LiveView } from "../liveview.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (key: string, width = 1280, height = 800): Frame => ({ png: Buffer.from(`png-${key}`).toString("base64"), width, height, key });

test("captures never overlap and keep to the frame rate", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	let n = 0;
	const pump = new FramePump({
		capture: async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await sleep(5);
			inFlight--;
			return frame(String(n++));
		},
		onFrame: () => {},
		minIntervalMs: 40,
	});
	pump.start();
	await sleep(400);
	await pump.stop();
	assert.equal(maxInFlight, 1);
	// 400 ms at one capture per 40 ms at most: 10, plus the first one.
	assert.ok(pump.captures >= 5 && pump.captures <= 11, `captures: ${pump.captures}`);
});

test("slow captures are spaced out to stay within the CPU budget", async () => {
	const pump = new FramePump({
		capture: async () => {
			await sleep(30);
			return frame("same");
		},
		onFrame: () => {},
		minIntervalMs: 10,
		maxDuty: 0.5,
	});
	pump.start();
	await sleep(400);
	await pump.stop();
	// Each 30 ms capture is followed by 30 ms of rest: about 400 / 60.
	assert.ok(pump.captures <= 8, `captures: ${pump.captures}`);
	assert.ok(pump.captures >= 4, `captures: ${pump.captures}`);
});

test("an unchanged screen is not a new frame; the last one stays after stop", async () => {
	const keys = ["a", "a", "b", "b", "b", "c"];
	const seen: string[] = [];
	const pump = new FramePump({
		capture: async () => frame(keys.shift() ?? "c"),
		onFrame: (f) => seen.push(f.key),
		minIntervalMs: 5,
	});
	pump.start();
	await sleep(100);
	await pump.stop();
	assert.deepEqual(seen, ["a", "b", "c"]);
	assert.equal(pump.frame?.key, "c");
});

test("a failing capture doesn't stop the pump", async () => {
	let n = 0;
	const pump = new FramePump({
		capture: async () => {
			if (n++ < 2) throw new Error("tab busy");
			return frame("ok");
		},
		onFrame: () => {},
		minIntervalMs: 5,
		errorBackoffMs: 5,
	});
	pump.start();
	await sleep(100);
	await pump.stop();
	assert.equal(pump.frame?.key, "ok");
});

test("a frame fills the width and keeps its aspect, within the row budget", () => {
	const cell = { widthPx: 10, heightPx: 20 };
	assert.deepEqual(fitFrame({ width: 1280, height: 800 }, 100, cell, 40), { columns: 100, rows: 31 });
	// Too tall for the budget: narrower, so the aspect holds.
	assert.deepEqual(fitFrame({ width: 1280, height: 800 }, 100, cell, 20), { columns: 64, rows: 20 });
	assert.deepEqual(fitFrame({ width: 1280, height: 800 }, 100, cell, 200), { columns: 100, rows: 31 });
});

function kittyView(kitty = true) {
	const writes: string[] = [];
	let id = 1000;
	const view = new LiveView({
		kitty: () => kitty,
		write: (s) => writes.push(s),
		cell: () => ({ widthPx: 10, heightPx: 20 }),
		maxRows: () => 40,
		allocateId: () => id++,
	});
	return { view, writes };
}

// Placed directly, as Pi's own Image does: Herdr draws Unicode placeholder cells with the
// line gap between rows showing, which striped the live view.
test("kitty: a frame is placed directly on its first row, the others left empty", () => {
	const { view, writes } = kittyView();
	view.setFrame(frame("a"));
	const rows = view.render(100);
	assert.equal(rows.length, 31);
	assert.match(rows[0]!, /^\x1b_Ga=T,f=100,q=2,C=1,i=1000,c=100,r=31;/);
	assert.ok(rows.slice(1).every((row) => row === ""));
	assert.ok(!rows.join("").includes("\u{10eeee}"), "no placeholders");
	assert.equal(writes.length, 0, "nothing written outside the rows");
	assert.equal(view.render(100)[0], rows[0], "the same frame draws the same row");

	view.setFrame(frame("b"));
	const next = view.render(100);
	assert.notEqual(next[0], rows[0], "a new frame changes the row, so Pi redraws it");
	assert.match(next[0]!, /i=1000,c=100,r=31;/, "under the same id, replacing the old picture");
});

test("kitty: a narrower row places the frame at the new size; dispose deletes it", () => {
	const { view, writes } = kittyView();
	view.setFrame(frame("a"));
	view.render(100);
	assert.match(view.render(50)[0]!, /c=50,r=16;/);
	view.dispose();
	assert.equal(writes.at(-1), "\x1b_Ga=d,d=I,i=1000,q=2\x1b\\");
});

// Pi's fullscreen renderer deletes every placement on an image redraw and puts back only
// the images registered through pi-tui's renderImage (and crops those scrolled half out):
// a raw a=T line vanished on the next redraw, leaving its empty rows.
test("kitty: with Pi's renderImage, frames go through it under one stable id", () => {
	const calls: { id?: number; maxWidthCells?: number; maxHeightCells?: number; png: string }[] = [];
	const view = new LiveView({
		kitty: () => true,
		write: () => {},
		cell: () => ({ widthPx: 10, heightPx: 20 }),
		maxRows: () => 40,
		allocateId: () => 4242,
		renderImage: (png, _dims, options) => {
			calls.push({ id: options.imageId, maxWidthCells: options.maxWidthCells, maxHeightCells: options.maxHeightCells, png });
			return { sequence: `<img ${options.imageId}>`, rows: 3 };
		},
	});
	view.setFrame(frame("a"));
	assert.deepEqual(view.render(100), ["<img 4242>", "", ""]);
	view.setFrame(frame("b"));
	view.render(100);
	assert.deepEqual(calls.map((c) => c.id), [4242, 4242]);
	assert.deepEqual([calls[0]!.maxWidthCells, calls[0]!.maxHeightCells], [100, 31]);
	assert.notEqual(calls[0]!.png, calls[1]!.png);
});

test("without kitty graphics the view is a line of text", () => {
	const { view, writes } = kittyView(false);
	view.setFrame(frame("a"));
	view.setCaption("tab 7 · http://127.0.0.1:8917/");
	const rows = view.render(80);
	assert.equal(writes.length, 0);
	assert.equal(rows.length, 1);
	assert.match(rows[0]!, /tab 7 · http:\/\/127\.0\.0\.1:8917\/.*1280×800/);
});
