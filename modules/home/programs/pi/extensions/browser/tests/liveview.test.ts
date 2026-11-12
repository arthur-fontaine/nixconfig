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

test("kitty: each new frame is uploaded once and drawn as placeholders", () => {
	const { view, writes } = kittyView();
	view.setFrame(frame("a"));
	const rows = view.render(100);
	assert.equal(rows.length, 31);
	assert.ok(rows.every((row) => row.includes("\u{10eeee}")));
	// The id is the foreground colour of every placeholder cell.
	assert.ok(rows[0]!.includes("\x1b[38;2;0;3;232m"));
	assert.equal(writes.length, 1);
	assert.match(writes[0]!, /^\x1b_Ga=T,U=1,f=100,q=2,i=1000,c=100,r=31;/);
	view.render(100);
	assert.equal(writes.length, 1, "the same frame isn't uploaded again");

	view.setFrame(frame("b"));
	const next = view.render(100);
	assert.ok(next[0]!.includes("\x1b[38;2;0;3;233m"), "a new frame gets a new id, so its lines change");
	assert.match(writes[1]!, /i=1001,c=100,r=31;/);
	assert.equal(writes[2], "\x1b_Ga=d,d=I,i=1000,q=2\x1b\\", "the old frame is deleted");
});

test("kitty: a narrower row re-uploads at the new size; invalidate re-uploads", () => {
	const { view, writes } = kittyView();
	view.setFrame(frame("a"));
	view.render(100);
	view.render(50);
	assert.match(writes.at(-2)!, /c=50,r=16;/);
	view.invalidate();
	view.render(50);
	assert.match(writes.at(-2)!, /c=50,r=16;/);
	view.dispose();
	assert.match(writes.at(-1)!, /a=d,d=I/);
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
