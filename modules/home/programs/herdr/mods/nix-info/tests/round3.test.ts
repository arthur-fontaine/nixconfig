// Round 3 (brief-r3.md): the session's counts and age under its status line, and the Context
// expansion's step chart, pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { infoCallMeta, infoContextChart, infoContextLines, infoEditedText, infoFeed, infoFilesMeta, infoMeterRight, infoNewSession, infoSessionLine } from "../model.js";

const MIN = 60000;
const session = (o) => ({ ...infoNewSession("f"), ...o });

// ---- the second status line --------------------------------------------------------------

test("the session line: prompts, replies and how long ago it started", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(infoSessionLine(session({ prompts: 3, replies: 76, started: now - 52 * MIN }), now), "3 prompts · 76 replies · 52m");
  assert.equal(infoSessionLine(session({ prompts: 1, replies: 1, started: now - 3 * 60 * MIN }), now), "1 prompt · 1 reply · 3h");
});

test("the session line without a start time, and before any message", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(infoSessionLine(session({ prompts: 2, replies: 5, started: null }), now), "2 prompts · 5 replies");
  assert.equal(infoSessionLine(session({ prompts: 0, replies: 0, started: now - MIN }), now), "No prompts yet · 1m");
  assert.equal(infoSessionLine(session({ prompts: 0, replies: 0, started: null }), now), "No prompts yet");
});

// ---- the context chart ---------------------------------------------------------------------

const req = (context, afterCompaction = false) => ({ input: 3, cacheRead: context - 3, cacheWrite: 0, output: 10, context, afterCompaction });

test("no request, no chart", () => {
  assert.equal(infoContextChart(session({}), 1e6), null);
});

test("one bar per request, to the window, the caption counting what is plotted", () => {
  const c = infoContextChart(session({ requests: [req(100_000), req(250_000)] }), 1e6);
  assert.deepEqual(c.bars, [{ ratio: 0.1, over: false }, { ratio: 0.25, over: false }]);
  assert.equal(c.caption, "All 2 requests");
  assert.equal(c.ceiling, "1M window");
  assert.equal(infoContextChart(session({ requests: [req(1000)] }), 1e6).caption, "1 request");
});

test("only the last requests, and the caption says so", () => {
  const requests = Array.from({ length: 100 }, (_, i) => req(1000 * (i + 1)));
  const c = infoContextChart(session({ requests }), 1e6, { max: 72 });
  assert.equal(c.bars.length, 72);
  assert.equal(c.bars[0].ratio, 29_000 / 1e6);
  assert.equal(c.caption, "Last 72 requests");
});

test("a request past the window is drawn at the ceiling, flagged", () => {
  const c = infoContextChart(session({ requests: [req(1_016_172)] }), 1e6);
  assert.deepEqual(c.bars, [{ ratio: 1, over: true }]);
});

test("an assumed window says so", () => {
  assert.equal(infoContextChart(session({ requests: [req(1000)] }), 1e6, { known: false }).ceiling, "1M window, assumed");
  assert.equal(infoContextChart(session({ requests: [req(1000)] }), 200_000).ceiling, "200k window");
});

test("a compaction's tick sits on the boundary before the first request after it", () => {
  const c = infoContextChart(session({ requests: [req(500_000), req(900_000), req(40_000, true), req(60_000)] }), 1e6);
  assert.deepEqual(c.ticks, [{ at: 0.5, label: true }]);
});

test("a compaction before the plotted requests has no tick; one with no request after it yet ends the chart", () => {
  const requests = [req(900_000), req(40_000, true), ...Array.from({ length: 5 }, () => req(50_000))];
  assert.deepEqual(infoContextChart(session({ requests }), 1e6, { max: 5 }).ticks, []);
  assert.deepEqual(infoContextChart(session({ requests: [req(900_000)], pendingCompaction: true }), 1e6).ticks, [{ at: 1, label: true }]);
});

test("ticks too close to the last labelled one keep no label", () => {
  const requests = Array.from({ length: 20 }, (_, i) => req(10_000, i === 2 || i === 4 || i === 15));
  assert.deepEqual(infoContextChart(session({ requests }), 1e6).ticks, [{ at: 0.1, label: true }, { at: 0.2, label: false }, { at: 0.75, label: true }]);
});

test("fed from a session: the tick follows the compaction entry", () => {
  const s = infoNewSession("f");
  const line = (o) => JSON.stringify(o) + "\n";
  const reply = (ts, n) => line({ type: "message", timestamp: ts, message: { role: "assistant", usage: { input: 3, cacheRead: n, cacheWrite: 0, output: 5 }, content: [] } });
  infoFeed(s, reply("2026-11-18T10:00:00Z", 800_000) + reply("2026-11-18T10:01:00Z", 950_000)
    + line({ type: "compaction", timestamp: "2026-11-18T10:02:00Z" }) + reply("2026-11-18T10:03:00Z", 30_000));
  const c = infoContextChart(s, 1e6);
  assert.equal(c.bars.length, 3);
  assert.deepEqual(c.ticks, [{ at: 2 / 3, label: true }]);
});

// ---- the words pass: numbers and names first, the essential part never cut ----------------

test("a limit's right side: the reset time is the essential part, pace and staleness secondary", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const H = 3600_000;
  assert.deepEqual(infoMeterRight({ resetsAt: now + 4 * H + 43 * MIN, ahead: 0.1 }, "five", { now }),
    { essential: "4h 43m", secondary: "10 pts ahead", tip: "Resets in 4h 43m" });
  assert.deepEqual(infoMeterRight({ resetsAt: now + 3 * 24 * H, ahead: -0.2 }, "week", { now }),
    { essential: "3 days", secondary: "", tip: "Resets in 3 days" });
  assert.deepEqual(infoMeterRight({ resetsAt: now + 2 * H, ahead: 0.05 }, "five", { now, staleFor: 12 * MIN }),
    { essential: "2h", secondary: "5 pts ahead · as of 12m ago", tip: "Resets in 2h" });
  assert.deepEqual(infoMeterRight({ resetsAt: null, ahead: null }, "five", { now }), { essential: "", secondary: "", tip: null });
});

test("the edited files row: the count first, + when it is a floor", () => {
  assert.equal(infoEditedText({ files: [1, 2, 3, 4, 5, 6, 7, 8], atLeast: true }), "8+ files edited");
  assert.equal(infoEditedText({ files: [1, 2], atLeast: false }), "2 files edited");
  assert.equal(infoEditedText({ files: [1], atLeast: false }), "1 file edited");
  assert.equal(infoEditedText({ files: [], atLeast: true }), "0+ files edited");
  assert.equal(infoEditedText({ files: [], atLeast: false }), "No files edited yet");
});

test("the Edited files view's meta", () => {
  assert.equal(infoFilesMeta(8, true), "8 files · since start");
  assert.equal(infoFilesMeta(1, false), "1 file");
});

test("a call's meta: its time first, then when it ran", () => {
  const at = (s) => Date.parse(`2026-11-18T00:27:${s}`);
  assert.equal(infoCallMeta({ duration: 3100, startedExact: at("42"), finished: at("45"), level: 0 }, "done"), "3.1s · 00:27:42–00:27:45");
  assert.equal(infoCallMeta({ duration: 3100, startedExact: null, finished: at("45"), level: 0 }, "done"), "3.1s · finished 00:27:45");
  assert.equal(infoCallMeta({ duration: 40, startedExact: null, finished: null, level: 1 }, "done"), "<0.1s");
  assert.equal(infoCallMeta({ duration: null, startedExact: null, finished: null, level: 1 }, "done"), "No timing");
  assert.equal(infoCallMeta({}, "running"), "Running");
  assert.equal(infoCallMeta({}, "no-result"), "No result");
});

test("the Context expansion's lines: figures first", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.deepEqual(infoContextLines({ session: 0.92, last: 0.9, read: 3_200_000, written: 278_000 }, { compactions: 1, lastCompaction: now - 45 * MIN }, now),
    ["92% cache hits · last 90%", "3.2M cache read · 278k written", "Compacted once · 45m ago"]);
  assert.deepEqual(infoContextLines({ session: null, last: null, read: 0, written: 0 }, { compactions: 3, lastCompaction: null }, now),
    ["— cache hits · last —", "0 cache read · 0 written", "Compacted 3 times"]);
  assert.equal(infoContextLines({ session: 1, last: 1, read: 1, written: 1 }, { compactions: 0 }, now)[2], "Not compacted yet");
});
