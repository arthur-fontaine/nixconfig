import assert from "node:assert/strict";
import { test } from "node:test";
import "./stubs/hooks.ts";
import { tabsIn } from "../calls.ts";

const { default: browser, VIDEO_KEY } = await import("../index.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAB = 373894614;
const tabContext = `\n\nTab Context:\n- Executed on tabId: ${TAB}\n- Available tabs:\n  • tabId ${TAB}: "k22 motion test" ("http://127.0.0.1:8917/page.html")`;

function fakeClient(navigateMs = 0) {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let shot = 0;
	let inFlight = 0;
	const pacing = { maxInFlight: 0, starts: [] as number[] };
	return {
		calls,
		pacing,
		screenshots: () => calls.filter((c) => c.tool === "computer" && c.args.action === "screenshot").length,
		client: {
			async callTool(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
				calls.push({ tool, args });
				if (tool === "tabs_context_mcp")
					return { result: { content: [{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: TAB, title: "k22 motion test", url: "http://127.0.0.1:8917/page.html" }], tabGroupId: 5 }) }] } };
				if (tool === "navigate") {
					await new Promise((resolve, reject) => {
						const t = setTimeout(resolve, navigateMs);
						options.signal?.addEventListener("abort", () => {
							clearTimeout(t);
							reject(new Error("aborted"));
						});
					});
					return { result: { content: [{ type: "text", text: `Navigated to ${args.url}` }, { type: "text", text: tabContext }] } };
				}
				if (tool === "computer" && args.action === "screenshot") {
					pacing.starts.push(Date.now());
					pacing.maxInFlight = Math.max(pacing.maxInFlight, ++inFlight);
					await sleep(400);
					inFlight--;
					return { result: { content: [{ type: "image", data: Buffer.from(`shot-${shot++}`).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: tabContext }] } };
				}
				return { result: { content: [{ type: "text", text: "ok" }, { type: "text", text: tabContext }] } };
			},
			close() {},
			async listExtensions() {
				return [];
			},
			select() {},
		},
	};
}

function fakePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const shortcuts = new Map<string, any>();
	let renderers = 0;
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerToolRenderer: () => renderers++,
		registerShortcut: (key: string, o: any) => shortcuts.set(key, o),
		on: (event: string, h: Function) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		getSettings: () => ({}),
	};
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		for (const h of handlers.get(event) ?? []) await h(payload, ctx);
	};
	return { pi, tools, shortcuts, emit, renderers: () => renderers };
}

function fakeUi() {
	const overlays: { component: any; options: any; hidden: boolean; done: boolean; focused: boolean }[] = [];
	const writes: string[] = [];
	let renders = 0;
	const tui = { terminal: { columns: 200, rows: 60, write: (s: string) => writes.push(s) }, requestRender: () => renders++ };
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };
	const ui = {
		custom(factory: Function, options: any) {
			const entry = { component: undefined as any, options, hidden: false, done: false, focused: false };
			return new Promise((resolve) => {
				entry.component = factory(tui, theme, {}, () => {
					entry.done = true;
					resolve(undefined);
				});
				overlays.push(entry);
				options.onHandle?.({
					setHidden: (h: boolean) => (entry.hidden = h),
					unfocus: () => (entry.focused = false),
				});
			});
		},
		notify() {},
	};
	return { ui, overlays, writes, renders: () => renders };
}

const ctxFor = (ui: unknown) => ({ mode: "tui", hasUI: true, ui, sessionManager: { getSessionId: () => "s1" } });

test("browser rows are plain tool rows: no renderer of ours, no frame in a result", async () => {
	const { pi, tools, renderers } = fakePi();
	const fake = fakeClient();
	browser(pi as never, { client: fake.client as never });
	assert.equal(renderers(), 0, "compact-tools draws the rows as any tool's");
	const navigate = tools.get("mcp__claude-in-chrome__navigate");
	const result = await navigate.execute("t1", { url: "http://127.0.0.1:8917/page.html", tabId: TAB }, undefined, undefined, { hasUI: false });
	assert.ok(result.content.every((c: any) => c.type === "text"));
	assert.deepEqual(Object.keys(result.details), ["tabId"]);
	assert.ok(!JSON.stringify(result).includes("frame"));
});

test("a screenshot Pi asks for stays in its result, for the model and the row, drawn once", async () => {
	const { pi, tools } = fakePi();
	const fake = fakeClient();
	browser(pi as never, { client: fake.client as never });
	const computer = tools.get("mcp__claude-in-chrome__computer");
	const result = await computer.execute("t2", { action: "screenshot", tabId: TAB }, undefined, undefined, { hasUI: false });
	assert.equal(result.content.filter((c: any) => c.type === "image").length, 1);
	assert.equal(fake.screenshots(), 1, "no extra capture of ours");
});

test("the video: a non-capturing top-right overlay that plays while a call runs and stops at session end", async () => {
	const { pi, tools, shortcuts, emit } = fakePi();
	const fake = fakeClient(1200);
	const { ui, overlays, writes } = fakeUi();
	browser(pi as never, { client: fake.client as never });
	assert.ok(shortcuts.has(VIDEO_KEY));
	assert.equal(VIDEO_KEY, "ctrl+alt+b");
	await emit("session_start", {}, ctxFor(ui));
	assert.equal(overlays.length, 1);
	const o = overlays[0]!;
	assert.equal(o.options.overlay, true);
	assert.equal(o.options.overlayOptions.anchor, "top-right");
	assert.equal(o.options.overlayOptions.nonCapturing, true);
	assert.equal(o.hidden, true, "hidden until the browser is used");
	assert.equal(fake.screenshots(), 0, "nothing runs while idle");

	const navigate = tools.get("mcp__claude-in-chrome__navigate");
	const running = navigate.execute("t3", { url: "http://127.0.0.1:8917/page.html", tabId: TAB }, new AbortController().signal, undefined, ctxFor(ui));
	await sleep(900);
	assert.equal(o.hidden, false);
	assert.ok(fake.screenshots() >= 3, `screenshots while navigating: ${fake.screenshots()}`);
	const lines = o.component.render(o.options.overlayOptions.width);
	assert.match(lines[0], /● 127\.0\.0\.1:8917  k22 motion test/);
	assert.ok(lines[1].includes("\x1b_G"), "the frame is drawn");
	await running;

	await emit("session_shutdown", {}, ctxFor(ui));
	const atEnd = fake.screenshots();
	await sleep(200);
	assert.equal(fake.screenshots(), atEnd, "no capture after session end");
	assert.equal(o.done, true, "the overlay is closed");
	assert.match(writes.at(-1)!, /^\x1b_Ga=d,d=I,i=\d+/, "its image is freed");
});

// Each screenshot hides the extension's glow, captures, then shows it again. Overlapping
// screenshots let one's "show" land during another's capture, so the glow got into 36% of
// the frames at 3 in flight. 2 in flight started 200 ms apart (the extension's ~215 ms of
// work per shot) gave 0 of 378 frames with the glow, at ~4.4 fps.
test("the video's screenshots: at most 2 in flight, started at least 200 ms apart", async () => {
	const { pi, tools, emit } = fakePi();
	const fake = fakeClient(2500);
	const { ui } = fakeUi();
	browser(pi as never, { client: fake.client as never });
	await emit("session_start", {}, ctxFor(ui));
	await tools.get("mcp__claude-in-chrome__navigate").execute("tp", { url: "http://127.0.0.1:8917/", tabId: TAB }, undefined, undefined, ctxFor(ui));
	await emit("session_shutdown", {}, ctxFor(ui));
	const { starts, maxInFlight } = fake.pacing;
	assert.ok(starts.length >= 4, `screenshots: ${starts.length}`);
	assert.equal(maxInFlight, 2);
	const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
	assert.ok(Math.min(...gaps) >= 195, `gaps: ${gaps}`);
});

test("Esc: the call's abort hides the video and stops capture at once", async () => {
	const { pi, tools, emit } = fakePi();
	const fake = fakeClient(5_000);
	const { ui, overlays } = fakeUi();
	browser(pi as never, { client: fake.client as never });
	await emit("session_start", {}, ctxFor(ui));
	const abort = new AbortController();
	const running = tools.get("mcp__claude-in-chrome__navigate").execute("t4", { url: "http://127.0.0.1:8917/", tabId: TAB }, abort.signal, undefined, ctxFor(ui)).catch(() => {});
	await sleep(250);
	assert.equal(overlays[0]!.hidden, false);
	abort.abort();
	await running;
	assert.equal(overlays[0]!.hidden, true);
	const atAbort = fake.screenshots();
	await sleep(200);
	assert.ok(fake.screenshots() <= atAbort + 0, "nothing more after the abort");
	await emit("session_shutdown", {}, ctxFor(ui));
});

test("collapsed by the key, the next browser use shows the pill and captures nothing", async () => {
	const { pi, tools, shortcuts, emit } = fakePi();
	const fake = fakeClient(400);
	const { ui, overlays } = fakeUi();
	browser(pi as never, { client: fake.client as never });
	await emit("session_start", {}, ctxFor(ui));
	const navigate = tools.get("mcp__claude-in-chrome__navigate");
	await navigate.execute("t5", { url: "http://127.0.0.1:8917/", tabId: TAB }, undefined, undefined, ctxFor(ui));
	await shortcuts.get(VIDEO_KEY).handler(ctxFor(ui));
	const before = fake.screenshots();
	const running = navigate.execute("t6", { url: "http://127.0.0.1:8917/", tabId: TAB }, undefined, undefined, ctxFor(ui));
	await sleep(200);
	const o = overlays[0]!;
	assert.equal(o.hidden, false);
	assert.equal(o.component.render(o.options.overlayOptions.width).length, 1, "the pill");
	assert.equal(fake.screenshots(), before, "no frames for a pill");
	await running;
	await emit("session_shutdown", {}, ctxFor(ui));
});

test("only the session's own tabs are shown: a tab the extension doesn't list is never captured", async () => {
	const { pi, tools, emit } = fakePi();
	const fake = fakeClient(300);
	const { ui } = fakeUi();
	browser(pi as never, { client: fake.client as never });
	await emit("session_start", {}, ctxFor(ui));
	await tools.get("mcp__claude-in-chrome__navigate").execute("t7", { url: "http://127.0.0.1:8917/", tabId: 999 }, undefined, undefined, ctxFor(ui));
	assert.ok(!fake.calls.some((c) => c.tool === "computer" && c.args.tabId === 999));
	await emit("session_shutdown", {}, ctxFor(ui));
});

test("tab titles and URLs come from the results' tab context", () => {
	const tabs = tabsIn([{ type: "text", text: tabContext }]);
	assert.deepEqual(tabs.get(TAB), { title: "k22 motion test", url: "http://127.0.0.1:8917/page.html" });
	const json = tabsIn([{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: 7, title: "T", url: "https://x.dev/" }] }) }]);
	assert.deepEqual(json.get(7), { title: "T", url: "https://x.dev/" });
});
