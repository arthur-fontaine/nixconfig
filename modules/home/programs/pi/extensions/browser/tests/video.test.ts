import assert from "node:assert/strict";
import { test } from "node:test";
import { type Frame, FrameScheduler, layoutVideo } from "../video.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (key: string, width = 1280, height = 800): Frame => ({ png: Buffer.from(`png-${key}`).toString("base64"), width, height, key });

// The extension takes ~400 ms per screenshot over the bridge but runs several at once:
// one at a time gave 2.3 fps, three in flight 6 fps. So a few stay in flight, staggered.
test("pipelining: up to maxInFlight captures at once, the next sent as soon as one lands", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	let n = 0;
	const scheduler = new FrameScheduler({
		capture: async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await sleep(40);
			inFlight--;
			return frame(String(n++));
		},
		onFrame: () => {},
		maxInFlight: 3,
		minGapMs: 5,
	});
	scheduler.setActive(true);
	await sleep(300);
	scheduler.stop();
	assert.equal(maxInFlight, 3);
	// 300 ms of 40 ms captures, three at a time: about 22; one at a time would be 7.
	assert.ok(scheduler.requests >= 15, `requests: ${scheduler.requests}`);
});

test("request starts are spaced by minGapMs, so frames come evenly rather than in bursts", async () => {
	const starts: number[] = [];
	const scheduler = new FrameScheduler({
		capture: async () => {
			starts.push(Date.now());
			await sleep(200);
			return null;
		},
		onFrame: () => {},
		maxInFlight: 3,
		minGapMs: 50,
	});
	scheduler.setActive(true);
	await sleep(160);
	scheduler.stop();
	assert.equal(starts.length, 3);
	assert.ok(starts[1]! - starts[0]! >= 45 && starts[2]! - starts[1]! >= 45, `starts: ${starts.map((s) => s - starts[0]!)}`);
});

test("identical frames are skipped; a frame older than the one shown is dropped", async () => {
	// Requests 1..4 land out of order: 2 first, then 1 (stale), then 3 (same picture as 2), then 4.
	const plan = [
		{ delay: 60, key: "a" },
		{ delay: 10, key: "b" },
		{ delay: 80, key: "b" },
		{ delay: 100, key: "c" },
	];
	let i = 0;
	const seen: string[] = [];
	const scheduler = new FrameScheduler({
		capture: async () => {
			const step = plan[i++];
			if (!step) return new Promise<null>(() => {});
			await sleep(step.delay);
			return frame(step.key);
		},
		onFrame: (f) => seen.push(f.key),
		maxInFlight: 4,
		minGapMs: 1,
	});
	scheduler.setActive(true);
	await sleep(160);
	scheduler.stop();
	assert.deepEqual(seen, ["b", "c"]);
	assert.equal(scheduler.stale, 1);
	assert.equal(scheduler.skipped, 1);
});

test("paused: no capture runs and frames still in flight are not shown; resumed: it goes on", async () => {
	let calls = 0;
	const seen: string[] = [];
	const scheduler = new FrameScheduler({
		capture: async () => {
			calls++;
			await sleep(30);
			return frame(`f${calls}`);
		},
		onFrame: (f) => seen.push(f.key),
		maxInFlight: 1,
		minGapMs: 1,
	});
	assert.equal(scheduler.running, false);
	await sleep(50);
	assert.equal(calls, 0, "nothing runs before it is made active");
	scheduler.setActive(true);
	await sleep(10);
	scheduler.setActive(false);
	const atPause = calls;
	await sleep(100);
	assert.equal(calls, atPause, "no capture while paused");
	assert.deepEqual(seen, [], "the capture in flight at the pause is not shown");
	scheduler.setActive(true);
	await sleep(80);
	scheduler.stop();
	assert.ok(calls > atPause);
	assert.ok(seen.length >= 1);
});

test("stop aborts the captures in flight and nothing starts again", async () => {
	const signals: AbortSignal[] = [];
	let calls = 0;
	const scheduler = new FrameScheduler({
		capture: (signal) => {
			calls++;
			signals.push(signal);
			return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
		},
		onFrame: () => assert.fail("no frame after stop"),
		maxInFlight: 2,
		minGapMs: 1,
	});
	scheduler.setActive(true);
	await sleep(20);
	scheduler.stop();
	assert.equal(signals.length, 2);
	assert.ok(signals.every((s) => s.aborted));
	scheduler.setActive(true);
	await sleep(30);
	assert.equal(calls, 2);
	assert.equal(scheduler.running, false);
});

test("a failing capture backs off, then capture goes on", async () => {
	let n = 0;
	const seen: string[] = [];
	const scheduler = new FrameScheduler({
		capture: async () => {
			if (n++ < 2) throw new Error("tab busy");
			return frame("ok");
		},
		onFrame: (f) => seen.push(f.key),
		maxInFlight: 1,
		minGapMs: 1,
		errorBackoffMs: 20,
	});
	scheduler.setActive(true);
	await sleep(100);
	scheduler.stop();
	assert.deepEqual(seen, ["ok"]);
});

const cell = { widthPx: 10, heightPx: 20 };

test("the video takes ~40% of the width and keeps the page's aspect", () => {
	const layout = layoutVideo({ width: 1280, height: 800 }, { columns: 200, rows: 60 }, cell);
	assert.equal(layout.kind, "full");
	if (layout.kind !== "full") return;
	assert.equal(layout.width, 80);
	assert.equal(layout.imageColumns, 78);
	// 78 cells of 10 px = 780 px wide; 780 * 800 / 1280 = 487.5 px = 24 rows of 20 px.
	assert.equal(layout.imageRows, 24);
	assert.equal(layout.height, layout.imageRows + 2);
});

test("too tall for half the screen: narrower, so the aspect holds and the editor stays visible", () => {
	const layout = layoutVideo({ width: 800, height: 1200 }, { columns: 200, rows: 40 }, cell);
	assert.equal(layout.kind, "full");
	if (layout.kind !== "full") return;
	assert.equal(layout.height, 20, "half the 40 rows");
	assert.equal(layout.imageRows, 18);
	// 18 rows of 20 px = 360 px tall; 360 * 800 / 1200 = 240 px = 24 cells.
	assert.equal(layout.imageColumns, 24);
	assert.equal(layout.width, 26);
	const aspect = (layout.imageRows * cell.heightPx) / (layout.imageColumns * cell.widthPx);
	assert.ok(Math.abs(aspect - 1.5) < 0.1, `aspect ${aspect}`);
});

test("before the first frame a 16:10 page is assumed", () => {
	const a = layoutVideo(undefined, { columns: 200, rows: 60 }, cell);
	const b = layoutVideo({ width: 1600, height: 1000 }, { columns: 200, rows: 60 }, cell);
	assert.deepEqual(a, b);
});

test("below the minimum terminal size the video becomes the one-line pill", () => {
	assert.equal(layoutVideo(undefined, { columns: 60, rows: 40 }, cell).kind, "pill");
	assert.equal(layoutVideo(undefined, { columns: 200, rows: 14 }, cell).kind, "pill");
	assert.equal(layoutVideo(undefined, { columns: 100, rows: 24 }, cell).kind, "full");
});

test("the capture width is the video's pixel width, capped", () => {
	const layout = layoutVideo(undefined, { columns: 200, rows: 60 }, cell);
	assert.equal(layout.kind === "full" && layout.pixelWidth, 780);
	const big = layoutVideo(undefined, { columns: 400, rows: 120 }, { widthPx: 20, heightPx: 40 });
	assert.equal(big.kind === "full" && big.pixelWidth, 800);
});
