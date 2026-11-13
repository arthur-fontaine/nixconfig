import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeOverImages, OverlayState, VideoOverlay, type VideoOverlayOptions } from "../overlay.ts";
import type { Frame } from "../video.ts";

const LINGER = 4000;

test("hidden until Pi uses the browser; shown while it does; hidden a few seconds after", () => {
	const s = new OverlayState(LINGER);
	assert.equal(s.mode(0), "hidden");
	s.callStarted("a", 100);
	assert.equal(s.mode(100), "full");
	assert.equal(s.nextChange(100), undefined, "no timer while a call runs");
	s.callEnded("a", 1000);
	assert.equal(s.mode(1000 + LINGER - 1), "full");
	assert.equal(s.nextChange(1000), 1000 + LINGER);
	assert.equal(s.mode(1000 + LINGER), "hidden");
	assert.equal(s.nextChange(1000 + LINGER), undefined);
});

test("overlapping calls: it stays until the last one ends", () => {
	const s = new OverlayState(LINGER);
	s.callStarted("a", 0);
	s.callStarted("b", 10);
	s.callEnded("a", 20);
	assert.equal(s.mode(20 + LINGER + 1), "full", "b still runs");
	assert.equal(s.live(), true);
	s.callEnded("b", 5000);
	assert.equal(s.live(), false);
	assert.equal(s.mode(5000 + LINGER), "hidden");
});

test("collapse: the key turns the video into the pill, which stays a pill through later browser uses", () => {
	const s = new OverlayState(LINGER);
	s.callStarted("a", 0);
	s.toggle(10);
	assert.equal(s.collapsed, true);
	assert.equal(s.mode(10), "pill");
	s.callEnded("a", 100);
	assert.equal(s.mode(100 + LINGER), "hidden", "the pill goes too once the browser is idle");
	s.callStarted("b", 60_000);
	assert.equal(s.mode(60_000), "pill", "no reopening on its own");
	s.callEnded("b", 61_000);
	s.callStarted("c", 120_000);
	assert.equal(s.mode(120_000), "pill");
	s.toggle(120_500);
	assert.equal(s.collapsed, false);
	assert.equal(s.mode(120_500), "full", "the same key expands it");
});

test("the key while nothing shows flips the choice and shows it for a moment, so the change is seen", () => {
	const s = new OverlayState(LINGER);
	s.toggle(0);
	assert.equal(s.mode(0), "pill");
	assert.equal(s.mode(LINGER), "hidden");
	s.toggle(10_000);
	assert.equal(s.mode(10_000), "full");
	assert.equal(s.nextChange(10_000), 10_000 + LINGER);
	assert.equal(s.mode(10_000 + LINGER), "hidden");
});

test("only the full video captures: never while hidden or collapsed", () => {
	const s = new OverlayState(LINGER);
	assert.equal(s.capturing(0), false);
	s.callStarted("a", 0);
	assert.equal(s.capturing(0), true);
	s.toggle(1);
	assert.equal(s.capturing(1), false, "a pill needs no frames");
	s.toggle(2);
	s.callEnded("a", 3);
	assert.equal(s.capturing(3 + LINGER), false);
});

test("Esc (abort): gone at once, still collapsed if it was", () => {
	const s = new OverlayState(LINGER);
	s.callStarted("a", 0);
	s.toggle(1);
	s.abort();
	assert.equal(s.mode(2), "hidden");
	assert.equal(s.capturing(2), false);
	assert.equal(s.nextChange(2), undefined);
	assert.equal(s.collapsed, true);
});

test("over a chat row holding an image, the overlay's row is drawn after it rather than dropped", () => {
	const calls: string[] = [];
	const composite = compositeOverImages((base, ov) => {
		calls.push(base);
		return `${base}+${ov}`;
	});
	assert.equal(composite("chat text", "OV", 40, 2, 80), "chat text+OV");
	const image = "\x1b_Ga=p,i=9,c=30,r=10\x1b\\";
	assert.equal(composite(image, "OV", 40, 2, 80), `${image}\x1b[0m\x1b[41GOV\x1b[0m`);
	assert.deepEqual(calls, ["chat text"]);
});

test("a new session starts expanded and hidden", () => {
	const s = new OverlayState(LINGER);
	s.callStarted("a", 0);
	s.toggle(1);
	s.reset();
	assert.equal(s.collapsed, false);
	assert.equal(s.mode(2), "hidden");
	assert.equal(s.live(), false);
});

// --- the component ---

const strip = (s: string) => s.replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
const width = (s: string) => [...strip(s)].length;
const frame = (key: string): Frame => ({ png: Buffer.from(`png-${key}`).toString("base64"), width: 1280, height: 800, key });

function overlay(over: Partial<VideoOverlayOptions> = {}) {
	const state = new OverlayState(LINGER);
	let current: Frame | undefined;
	const uploads: { id: number; png: string; columns: number; rows: number }[] = [];
	let toggles = 0;
	let terminal = { columns: 200, rows: 60 };
	const view = new VideoOverlay({
		state,
		now: () => 0,
		frame: () => current,
		tab: () => ({ host: "127.0.0.1:8917", title: "k22 motion test" }),
		terminal: () => terminal,
		cell: () => ({ widthPx: 10, heightPx: 20 }),
		theme: { fg: (c, t) => `<${c}>${t}</${c}>`, bg: (c, t) => `[${c}]${t}[/${c}]` },
		keyHint: "ctrl+alt+b",
		imageId: 4242,
		visibleWidth: (s) => width(s.replace(/<\/?[a-zA-Z]+>|\[\/?[a-zA-Z]+\]/g, "")),
		truncate: (s, w) => (width(s) <= w ? s : `${[...s].slice(0, Math.max(0, w - 1)).join("")}…`),
		renderImage: (png, _dims, o) => {
			uploads.push({ id: o.imageId, png, columns: o.maxWidthCells, rows: o.maxHeightCells });
			return { sequence: `\x1b_Ga=T,f=100,q=2,C=1,c=${o.maxWidthCells},r=${o.maxHeightCells},i=${o.imageId};${png}\x1b\\`, rows: o.maxHeightCells, columns: o.maxWidthCells };
		},
		onToggle: () => toggles++,
		...over,
	});
	return {
		state,
		view,
		uploads,
		setFrame: (f: Frame | undefined) => (current = f),
		setTerminal: (t: { columns: number; rows: number }) => (terminal = t),
		toggles: () => toggles,
	};
}
const plain = (s: string) => strip(s).replace(/<\/?[a-zA-Z]+>|\[\/?[a-zA-Z]+\]/g, "");

test("hidden: nothing drawn", () => {
	const { view } = overlay();
	assert.deepEqual(view.render(80), []);
});

test("full: a bordered video, the title bar on the top edge with the live dot, host, title and key", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	o.setFrame(frame("a"));
	const w = o.view.width();
	assert.equal(w, 80);
	const lines = o.view.render(w);
	assert.equal(lines.length, 26);
	const title = plain(lines[0]!);
	assert.match(title, /^╭─ ● 127\.0\.0\.1:8917  k22 motion test ─+ ctrl\+alt\+b ─╮$/);
	assert.match(lines[0]!, /<success>●<\/success>/, "live dot in the theme's success colour");
	assert.match(plain(lines.at(-1)!), /^╰─+╯$/);
	for (const line of lines) assert.equal(width(line.replace(/<\/?[a-zA-Z]+>|\[\/?[a-zA-Z]+\]/g, "")), w, `width of ${JSON.stringify(plain(line))}`);
	// The picture is placed once, on the first row inside the border, under one id, above the chat's images.
	assert.match(lines[1]!, /│<\/borderMuted>\x1b_Gz=1,a=T,f=100,q=2,C=1,c=78,r=24,i=4242;/);
	assert.ok(lines.slice(2).every((l) => !l.includes("\x1b_G")));
	assert.deepEqual(o.uploads.map((u) => u.id), [4242]);
});

test("the same frame is not sent again; a new frame replaces the picture under the same id", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	o.setFrame(frame("a"));
	const first = o.view.render(80);
	assert.deepEqual(o.view.render(80), first);
	assert.equal(o.uploads.length, 1);
	o.setFrame(frame("b"));
	const next = o.view.render(80);
	assert.notEqual(next[1], first[1]);
	assert.deepEqual(o.uploads.map((u) => u.id), [4242, 4242]);
});

test("before the first frame the video area says it is connecting, with no image", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	const lines = o.view.render(o.view.width());
	assert.ok(lines.every((l) => !l.includes("\x1b_G")));
	assert.ok(lines.some((l) => plain(l).includes("Waiting for the first frame")));
});

test("a page with no host (a new tab) is named by its title alone", () => {
	const o = overlay({ tab: () => ({ title: "New Tab" }) });
	o.state.callStarted("a", 0);
	o.setFrame(frame("a"));
	assert.match(plain(o.view.render(80)[0]!), /^╭─ ● New Tab ─+ ctrl\+alt\+b ─╮$/);
});

test("idle (lingering after the last call): the dot goes dim", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	o.state.callEnded("a", 0);
	o.setFrame(frame("a"));
	assert.match(o.view.render(80)[0]!, /<dim>●<\/dim>/);
});

test("collapsed: a one-line pill with the dot, host and key", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	o.state.toggle(0);
	o.setFrame(frame("a"));
	const w = o.view.width();
	const lines = o.view.render(w);
	assert.equal(lines.length, 1);
	assert.equal(plain(lines[0]!), " ● 127.0.0.1:8917  ctrl+alt+b ");
	assert.equal(w, plain(lines[0]!).length);
	assert.match(lines[0]!, /^\[selectedBg\]/);
	assert.ok(!lines[0]!.includes("\x1b_G"));
});

test("a small terminal shows the pill even when expanded", () => {
	const o = overlay();
	o.setTerminal({ columns: 60, rows: 20 });
	o.state.callStarted("a", 0);
	o.setFrame(frame("a"));
	assert.equal(o.view.render(o.view.width()).length, 1);
});

test("a click on the pill expands it; a click on the video's title bar collapses it", () => {
	const o = overlay();
	o.state.callStarted("a", 0);
	o.state.toggle(0);
	const ev = (type: "press" | "click", y = 0) => ({ type, button: "left", x: 3, y, screenX: 0, screenY: 0, width: 10, height: 1, shift: false, alt: false, ctrl: false }) as never;
	assert.deepEqual(o.view.handleMouse(ev("press")), { handled: true });
	o.view.handleMouse(ev("click"));
	assert.equal(o.toggles(), 1);
	o.state.toggle(0);
	o.view.render(o.view.width());
	o.view.handleMouse(ev("click", 5));
	assert.equal(o.toggles(), 1, "a click on the picture does nothing");
	o.view.handleMouse(ev("click", 0));
	assert.equal(o.toggles(), 2);
});
