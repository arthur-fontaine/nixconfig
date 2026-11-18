// Round 3c (brief-r3c.md), pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { infoContext, infoContextChart, infoFeed, infoNewSession, infoKindCounts, infoCounts, infoListRows, infoKeep, infoCallsIn, infoRowIcon, infoMeterMuted, infoChipCount } from "../model.js";

const line = (o) => JSON.stringify(o) + "\n";
const it = (type, input, read, write, model) => ({ type, input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, ...(model ? { model } : {}) });
// Pi's claude-code provider sums every API request of a turn into one usage; the carrier keeps them
// apart (iterations), the advisor's as "advisor_message". As in the info-nested session (0abb5d39).
const reply = (ts, usage, iterations) => line({ type: "message", id: ts, timestamp: ts, message: { role: "assistant", usage, content: [],
  ...(iterations ? { diagnostics: [{ type: "claude-code.native-assistant.v1", details: { carrier: { message: { usage: { iterations } } } } }] } : {}) } });

// ---- 4. the conversation's context, not a turn's sum ------------------------------------------

test("a turn that consulted the advisor: its context is the last request of the conversation, not the sum", () => {
  const s = infoNewSession("f");
  infoFeed(s, reply("2026-11-17T17:20:00Z", { input: 2, cacheRead: 276_000, cacheWrite: 2000, output: 10 })
    + reply("2026-11-17T17:23:29Z", { input: 4, cacheRead: 553_830, cacheWrite: 3778, output: 302 },
      [it("message", 2, 275_543, 2744), it("advisor_message", 281_430, 0, 0, "claude-fable-5-2"), it("message", 2, 278_287, 1034)]));
  assert.equal(s.requests.at(-1).context, 279_323);
  assert.equal(infoContext(s).used, 279_323);
  assert.equal(infoContextChart(s).ceiling, "peak 279k");
});

test("a turn without iterations keeps its usage as its context", () => {
  const s = infoNewSession("f");
  infoFeed(s, reply("2026-11-17T17:20:00Z", { input: 3, cacheRead: 100, cacheWrite: 7, output: 1 }));
  assert.equal(s.requests.at(-1).context, 110);
});

// ---- 7 and 8. scripts aren't calls, but a failure is never lost ---------------------------------

const step = (o) => ({ id: "s/1", kind: "bash", arg: "git status", full: "git status", path: null, duration: 100, error: false, ...o });
const script = (o) => ({ id: "s", kind: "code", name: "codemode", arg: "x", untitled: false, running: false, duration: 300, threw: false, nested: [], ...o });
// infoTools' fields from a raw call, as the model derives them (failed, stepFailed, unrecorded).
import { infoTool, infoTools } from "../model.js";
const tools = (...calls) => {
  const s = infoNewSession("f");
  const lines = calls.map((c, i) => {
    const ts = `2026-11-18T10:0${i}:00Z`;
    return line({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: c.id, name: "codemode", arguments: { code: c.code ?? "await tools.bash({ command: 'ls' })" } }] } })
      + line({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: c.id, toolName: "codemode", isError: Boolean(c.threw), durationMs: 50, content: [{ type: "text", text: c.threw ? "Error" : "ok" }],
        ...(c.steps ? { nestedCalls: { complete: true, calls: c.steps } } : {}) } });
  });
  infoFeed(s, lines.join(""));
  return infoTools(s);
};
const base = infoKindCounts(tools({ id: "d", steps: [{ id: "d/1", name: "bash", status: "ok", arguments: { command: "ls" } }] }));

test("a script that threw with no recorded steps counts as one failed call, under other, with the filled dot", () => {
  const t = tools({ id: "d", steps: [{ id: "d/1", name: "bash", status: "ok", arguments: { command: "ls" } }] }, { id: "x", threw: true });
  const n = infoKindCounts(t);
  assert.deepEqual(n, { ...base, all: base.all + 1, other: base.other + 1, failed: base.failed + 1 });
  assert.equal(n.bash + n.read + n.edit + n.ask + n.other, n.all);
  const row = infoListRows(t, []).find((r) => r.id === "x");
  assert.equal(row.failed, true);
  assert.equal(row.unrecorded, true);
  // The other and failed filters list it, and count it as their chips do.
  for (const kind of ["other", "failed", "all"]) {
    const rows = infoListRows(t.map((c) => infoKeep(c, kind)).filter(Boolean), []);
    assert.equal(infoCallsIn(rows, kind), n[kind], kind);
  }
});

test("a script with zero steps that didn't throw changes nothing, and has no dot", () => {
  const t = tools({ id: "d", steps: [{ id: "d/1", name: "bash", status: "ok", arguments: { command: "ls" } }] }, { id: "z" });
  assert.deepEqual(infoKindCounts(t), base);
  const row = infoListRows(t, []).find((r) => r.id === "z");
  assert.equal(row.failed, false);
  assert.equal(row.stepFailed, false);
});

test("a script that threw with recorded steps, none failed: a container, the hollow dot, counts unchanged", () => {
  const t = tools({ id: "d", steps: [{ id: "d/1", name: "bash", status: "ok", arguments: { command: "ls" } }] },
    { id: "y", threw: true, steps: [{ id: "y/1", name: "bash", status: "ok", arguments: { command: "ls" } }, { id: "y/2", name: "read", status: "ok", arguments: { path: "/a" } }] });
  const n = infoKindCounts(t);
  assert.equal(n.failed, base.failed);
  assert.equal(n.all, base.all + 2);
  const row = infoListRows(t, []).find((r) => r.id === "y");
  assert.equal(row.failed, false);
  assert.equal(row.stepFailed, true);
  assert.equal(infoCounts(t).failed, n.failed);
});

// ---- 2. a row's icon says what it ran ----------------------------------------------------------

test("a script named by its one call, with no steps listed (running), takes that call's icon", () => {
  assert.equal(infoRowIcon({ kind: "code", argKind: "bash", nested: [], titled: false }), "bash");
  assert.equal(infoRowIcon({ kind: "code", argKind: "read", nested: null, titled: false }), "read");
  // Titled, a list of calls, code, or steps listed under it: the script's own icon.
  assert.equal(infoRowIcon({ kind: "code", argKind: "bash", nested: [], titled: true }), "code");
  assert.equal(infoRowIcon({ kind: "code", argKind: "calls", nested: [] }), "code");
  assert.equal(infoRowIcon({ kind: "code", argKind: "code", nested: [] }), "code");
  assert.equal(infoRowIcon({ kind: "code", argKind: "bash", nested: [{}], titled: false }), "code");
  assert.equal(infoRowIcon({ kind: "bash" }), "bash");
});

// ---- 6. a meter it can't vouch for is drawn muted ----------------------------------------------

test("a limit is muted once its reset has passed or its usage is stale", () => {
  const now = Date.parse("2026-11-18T12:00:00Z"), MIN = 60000;
  assert.equal(infoMeterMuted({ resetsAt: now + 60 * MIN }, { now }), false);
  assert.equal(infoMeterMuted({ resetsAt: now - 5 * MIN }, { now }), true);
  assert.equal(infoMeterMuted({ resetsAt: now + 60 * MIN }, { now, staleFor: 12 * MIN }), true);
  assert.equal(infoMeterMuted({ resetsAt: null }, { now }), false);
});

// ---- 3. chip counts, abbreviated from a thousand (the person's option B) ------------------------

test("a chip's count: exact under 1,000, then 1k, 4.4k, 12k", () => {
  assert.equal(infoChipCount(0), "0");
  assert.equal(infoChipCount(999), "999");
  assert.equal(infoChipCount(1000), "1k");
  assert.equal(infoChipCount(1050), "1.1k");
  assert.equal(infoChipCount(4425), "4.4k");
  assert.equal(infoChipCount(9960), "10k");
  assert.equal(infoChipCount(12345), "12k");
  assert.equal(infoChipCount(123456), "123k");
});
