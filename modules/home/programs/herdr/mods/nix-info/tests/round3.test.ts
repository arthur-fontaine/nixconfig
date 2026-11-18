// Round 3 (brief-r3.md): the session's counts and age under its status line, and the Context
// expansion's step chart, pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { infoModelName, infoHeadLine, infoContextRight, infoCommandText, infoCallMeta, infoContextChart, infoContextLines, infoEditedText, infoFeed, infoFilesMeta, infoMeterRight, infoNewSession, infoSessionLine } from "../model.js";

const MIN = 60000;
const session = (o) => ({ ...infoNewSession("f"), ...o });

// ---- the second status line --------------------------------------------------------------

test("the session name's tooltip: prompts, replies and how long ago it started", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(infoSessionLine(session({ prompts: 3, replies: 76, started: now - 52 * MIN }), now), "3 prompts · 76 replies · started 52m ago");
  assert.equal(infoSessionLine(session({ prompts: 1, replies: 1, started: now - 3 * 60 * MIN }), now), "1 prompt · 1 reply · started 3h ago");
});

test("the session name's tooltip without a start time, and before any message", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(infoSessionLine(session({ prompts: 2, replies: 5, started: null }), now), "2 prompts · 5 replies");
  assert.equal(infoSessionLine(session({ prompts: 0, replies: 0, started: now - MIN }), now), "No prompts yet · started 1m ago");
  assert.equal(infoSessionLine(session({ prompts: 0, replies: 0, started: null }), now), "No prompts yet");
});

// ---- the context chart ---------------------------------------------------------------------

const req = (context, afterCompaction = false) => ({ input: 3, cacheRead: context - 3, cacheWrite: 0, output: 10, context, afterCompaction });

test("no request, no chart", () => {
  assert.equal(infoContextChart(session({})), null);
});

test("one bar per request, scaled to the peak of those plotted (round 3b), the caption counting them", () => {
  const c = infoContextChart(session({ requests: [req(100_000), req(250_000)] }));
  assert.deepEqual(c.bars, [{ ratio: 0.4 }, { ratio: 1 }]);
  assert.equal(c.caption, "All 2 requests");
  assert.equal(c.ceiling, "peak 250k");
  assert.equal(infoContextChart(session({ requests: [req(1000)] })).caption, "1 request");
});

test("only the last requests, and the caption says so; the peak is theirs", () => {
  const requests = [req(900_000), ...Array.from({ length: 99 }, (_, i) => req(1000 * (i + 1)))];
  const c = infoContextChart(session({ requests }), { max: 72 });
  assert.equal(c.bars.length, 72);
  assert.equal(c.bars.at(-1).ratio, 1);
  assert.equal(c.ceiling, "peak 99k");
  assert.equal(c.caption, "Last 72 requests");
});

test("a compaction's tick sits on the boundary before the first request after it", () => {
  const c = infoContextChart(session({ requests: [req(500_000), req(900_000), req(40_000, true), req(60_000)] }));
  assert.deepEqual(c.ticks, [{ at: 0.5, label: true }]);
});

test("a compaction before the plotted requests has no tick; one with no request after it yet ends the chart", () => {
  const requests = [req(900_000), req(40_000, true), ...Array.from({ length: 5 }, () => req(50_000))];
  assert.deepEqual(infoContextChart(session({ requests }), { max: 5 }).ticks, []);
  assert.deepEqual(infoContextChart(session({ requests: [req(900_000)], pendingCompaction: true })).ticks, [{ at: 1, label: true }]);
});

test("ticks too close to the last labelled one keep no label", () => {
  const requests = Array.from({ length: 20 }, (_, i) => req(10_000, i === 2 || i === 4 || i === 15));
  assert.deepEqual(infoContextChart(session({ requests })).ticks, [{ at: 0.1, label: true }, { at: 0.2, label: false }, { at: 0.75, label: true }]);
});

test("fed from a session: the tick follows the compaction entry", () => {
  const s = infoNewSession("f");
  const line = (o) => JSON.stringify(o) + "\n";
  const reply = (ts, n) => line({ type: "message", timestamp: ts, message: { role: "assistant", usage: { input: 3, cacheRead: n, cacheWrite: 0, output: 5 }, content: [] } });
  infoFeed(s, reply("2026-11-18T10:00:00Z", 800_000) + reply("2026-11-18T10:01:00Z", 950_000)
    + line({ type: "compaction", timestamp: "2026-11-18T10:02:00Z" }) + reply("2026-11-18T10:03:00Z", 30_000));
  const c = infoContextChart(s);
  assert.equal(c.bars.length, 3);
  assert.deepEqual(c.ticks, [{ at: 2 / 3, label: true }]);
});

// ---- the words pass: numbers and names first, the essential part never cut ----------------

test("a limit's right side is always and only when it resets", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const H = 3600_000;
  assert.equal(infoMeterRight({ resetsAt: now + 3 * H + 44 * MIN, ahead: 0.13 }, "five", { now }), "resets in 3h 44m");
  assert.equal(infoMeterRight({ resetsAt: now + 3 * 24 * H, ahead: -0.2 }, "week", { now }), "resets in 3 days");
  assert.equal(infoMeterRight({ resetsAt: now + 1 * 24 * H + 2 * H, ahead: 0 }, "week", { now }), "resets in 1 day");
  assert.equal(infoMeterRight({ resetsAt: now + 2 * H }, "five", { now }), "resets in 2h");
  assert.equal(infoMeterRight({ resetsAt: null }, "five", { now }), "");
});

test("the Context meter's right side: used of the maximum, each figure with its word", () => {
  assert.equal(infoContextRight(59_000, 1e6, true), "59k of 1M");
  assert.equal(infoContextRight(59_000, 1e6, false), "59k of 1M (assumed)");
});

test("the edited files row: the count first, + when it is a floor", () => {
  // Round 3b: no "+": the edits with no file name get their own row in the detail.
  assert.equal(infoEditedText({ files: [1, 2, 3, 4, 5, 6, 7, 8], atLeast: true, unnamed: 1 }), "8 files edited");
  assert.equal(infoEditedText({ files: [1, 2], atLeast: false, unnamed: 0 }), "2 files edited");
  assert.equal(infoEditedText({ files: [1], atLeast: false, unnamed: 0 }), "1 file edited");
  assert.equal(infoEditedText({ files: [], atLeast: true, unnamed: 2 }), "File name not recorded (2 edits)");
  assert.equal(infoEditedText({ files: [], atLeast: false, unnamed: 0 }), "No files edited yet");
});

test("the Edited files view's meta", () => {
  assert.equal(infoFilesMeta(8, true), "8 files · since start");
  assert.equal(infoFilesMeta(1, false), "1 file");
});

test("a call's meta: its time first, then when it ran, each figure with its word", () => {
  const at = (s) => Date.parse(`2026-11-18T00:27:${s}`);
  assert.equal(infoCallMeta({ duration: 3100, startedExact: at("42"), finished: at("45"), level: 0 }, "done"), "Took 3.1s, from 00:27:42 to 00:27:45");
  assert.equal(infoCallMeta({ duration: 3100, startedExact: null, finished: at("45"), level: 0 }, "done"), "Took 3.1s, finished at 00:27:45");
  // Round 3b: start and end in the same second: one time.
  assert.equal(infoCallMeta({ duration: 40, startedExact: at("42.100"), finished: at("42.140"), level: 0 }, "done"), "Took <0.1s at 00:27:42");
  // A step has no clock of its own: the script's end, said as the script's.
  assert.equal(infoCallMeta({ duration: 100, startedExact: null, finished: null, level: 1 }, "done", at("45")), "Took 0.1s, in a script that ended at 00:27:45");
  assert.equal(infoCallMeta({ duration: 40, startedExact: null, finished: null, level: 1 }, "done"), "Took <0.1s");
  assert.equal(infoCallMeta({ duration: null, startedExact: null, finished: null, level: 1 }, "done"), "No timing");
  assert.equal(infoCallMeta({}, "running"), "Running");
  assert.equal(infoCallMeta({}, "no-result"), "Stopped");
});

test("the Context expansion's lines: figures first", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.deepEqual(infoContextLines({ session: 0.92, last: 0.9, read: 3_200_000, written: 278_000 }, { compactions: 1, lastCompaction: now - 45 * MIN }, now),
    ["92% of input reused from cache", "Compacted once, 45m ago"]);
  assert.deepEqual(infoContextLines({ session: null, last: null, read: 0, written: 0 }, { compactions: 3, lastCompaction: null }, now),
    ["Compacted 3 times"]);
  assert.equal(infoContextLines({ session: 1, last: 1, read: 1, written: 1 }, { compactions: 0 }, now)[1], "Not compacted yet");
});

test("a command as a row shows it: the program first, not the folder it runs in or its path", () => {
  assert.equal(infoCommandText("cd /Users/a/repo && node --test tests"), "node --test tests");
  assert.equal(infoCommandText("cd modules/home; cd x && git status -sb"), "git status -sb");
  assert.equal(infoCommandText("modules/home/programs/herdr/scripts/sandbox up"), "sandbox up");
  assert.equal(infoCommandText("./scripts/info-shots after /tmp/x"), "info-shots after /tmp/x");
  assert.equal(infoCommandText("cd /tmp && ~/bin/tool --flag"), "tool --flag");
  // A path as an argument stays; a lone cd stays as it is.
  assert.equal(infoCommandText("cat /etc/hosts"), "cat /etc/hosts");
  assert.equal(infoCommandText("cd /tmp"), "cd /tmp");
  assert.equal(infoCommandText(null), null);
  // An env assignment first: left alone, never read as a path to a program.
  assert.equal(infoCommandText("INFO_REAL=/tmp/x/nested.jsonl scripts/info-shots a"), "INFO_REAL=/tmp/x/nested.jsonl scripts/info-shots a");
  assert.equal(infoCommandText("cd /tmp && FOO=a/b ./run"), "FOO=a/b ./run");
});

// ---- the overview's top: no header, "π name", then "<status> · <model> · <thinking>" -------

test("a model id as a readable name; unknown ids unchanged", () => {
  assert.equal(infoModelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(infoModelName("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(infoModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(infoModelName("claude-opus-4-20250514"), "Opus 4");
  assert.equal(infoModelName("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
  assert.equal(infoModelName("gpt-5.1-codex"), "gpt-5.1-codex");
  assert.equal(infoModelName(null), null);
});

test("the line under the name: the status, then the model and thinking (off omitted)", () => {
  assert.deepEqual(infoHeadLine({ tone: "idle", text: "Idle 6h" }, "claude-opus-5-5", "high"), { status: "Idle 6h", rest: "Opus 5.5 · high" });
  assert.deepEqual(infoHeadLine({ tone: "working", text: "Working 1m 09s", call: "x" }, "claude-opus-5-5", "off"), { status: "Working 1m 09s", rest: "Opus 5.5" });
  assert.deepEqual(infoHeadLine({ tone: "idle", text: "No calls yet" }, null, null), { status: "No calls yet", rest: "" });
  assert.deepEqual(infoHeadLine({ tone: "idle", text: "Idle 2m" }, null, "high"), { status: "Idle 2m", rest: "high" });
});
