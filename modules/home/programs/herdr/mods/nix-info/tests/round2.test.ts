// Round 2 (decisions.md "Round 2", critique-2.md): the list's merge rule, its units, the type
// rule's flags and folder shortening, pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  infoFeed, infoFolder, infoKeep, infoListMeta, infoListRows, infoMergedRow, infoNavIds, infoNewSession, infoNum, infoRowDuration,
  infoRows, infoScriptArg, infoShowAll, infoStatusLine, infoTool, infoTools,
} from "../model.js";

const step = (o) => ({ id: "s/1", kind: "bash", arg: "git status", full: "git status", path: null, duration: 5200, error: false, ...o });
const script = (o) => ({ id: "s", kind: "code", name: "codemode", arg: "git status", untitled: true, running: false, duration: 5300,
  failed: false, stepFailed: false, nested: [step()], ...o });

// ---- R2-1: one row for an untitled script of one step ----------------------------------

test("an untitled finished script of one step is one row: the script's id and time, the step's kind and text", () => {
  const rows = infoListRows([script()], []);
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.id, "s");
  assert.equal(r.merged, true);
  assert.equal(r.kind, "bash");
  assert.equal(r.arg, "git status");
  assert.equal(r.duration, 5300);
  assert.equal(r.nested, null); // nothing to collapse
  assert.equal(r.tip, "Script with 1 step · step took 5.2s");
});

test("titled, running and many-step scripts keep their steps under them", () => {
  assert.equal(infoListRows([script({ untitled: false, arg: "Checks the status" })], []).length, 2);
  assert.equal(infoListRows([script({ running: true, duration: null })], []).length, 2);
  assert.equal(infoListRows([script({ nested: [step(), step({ id: "s/2" })] })], []).length, 3);
  assert.equal(infoListRows([script({ nested: [step(), step({ id: "s/2" })] })], ["s"]).length, 1);
});

test("a merged row's dot is the more severe of script and step", () => {
  const threw = infoMergedRow(script({ failed: true, nested: [step({ error: true })] }));
  assert.equal(threw.failed, true);
  assert.equal(threw.tip, "Script and its step failed");
  const went = infoMergedRow(script({ stepFailed: true, nested: [step({ error: true })] }));
  assert.equal(went.failed, false);
  assert.equal(went.stepFailed, true);
  assert.equal(infoMergedRow(script({ untitled: false })), null);
});

test("a merged row is never context: its step is what matched", () => {
  const kept = infoKeep(script(), "bash");
  assert.equal(kept.context, true); // the script itself isn't bash
  assert.equal(infoListRows([kept], [])[0].context, undefined);
  const went = infoKeep(script({ error: true, stepFailed: true, nested: [step({ error: true })] }), "failed");
  assert.equal(infoListRows([went], [])[0].context, undefined);
});

test("a filter never merges a script of several steps (decided on all its steps)", () => {
  const five = script({ nested: ["bash", "edit", "read", "edit", "edit"].map((kind, i) => step({ id: "s/" + i, kind })) });
  const kept = infoKeep(five, "bash");
  assert.equal(kept.nested.length, 1);
  assert.equal(infoListRows([kept], []).length, 2);
});

test("↑/↓ stop once on a merged row (the script)", () => {
  const view = { detail: "call", from: null, collapsed: [] };
  assert.deepEqual(infoNavIds(view, [], [script(), script({ id: "t", nested: [step({ id: "t/1" }), step({ id: "t/2" })] })]), ["s", "t", "t/1", "t/2"]);
});

// ---- R2-2: the list's unit, thousands, durations ----------------------------------------

test("the list counts rows, says so, and groups thousands", () => {
  assert.equal(infoNum(216), "216");
  assert.equal(infoNum(1467), "1,467");
  assert.equal(infoNum(1234567), "1,234,567");
  assert.equal(infoListMeta(216, 216, 0), "216 rows");
  assert.equal(infoListMeta(200, 216, 0), "200 of 216 rows");
  assert.equal(infoListMeta(3, 3, 1), "3 rows · 1 for context");
  assert.equal(infoListMeta(200, 1467, 12), "200 of 1,467 rows · 12 for context");
  assert.equal(infoListMeta(1, 1, 0), "1 row");
  assert.equal(infoShowAll(1467), "Show all 1,467 rows");
});

test("a parent kept only for its matching steps is marked as context", () => {
  const s = script({ nested: [step(), step({ id: "s/2", kind: "edit" })] });
  assert.equal(infoKeep(s, "bash").context, true);
  assert.equal(infoKeep(step(), "bash").context, undefined);
  // Under "failed", a script that went on after its failed step didn't fail itself (D6).
  const went = script({ error: true, failed: false, stepFailed: true, nested: [step({ error: true }), step({ id: "s/2" })] });
  assert.equal(infoKeep(went, "failed").context, true);
  assert.equal(infoKeep({ ...went, failed: true }, "failed").context, undefined);
});

test("list durations agree with the call view: <0.1s under 100 ms, blank without timing", () => {
  assert.equal(infoRowDuration(55), "<0.1s");
  assert.equal(infoRowDuration(0), "<0.1s");
  assert.equal(infoRowDuration(null), "");
  assert.equal(infoRowDuration(2400), "2.4s");
});

// ---- R2-3: flags for the type rule; no kind prefix ----------------------------------------

test("a script's arg has no kind prefix; its kind is kept apart", () => {
  assert.equal(infoScriptArg('await tools.bash({ command: "git status -sb" });', "/r"), "git status -sb");
  const t = infoTool({ id: "x", name: "codemode", arguments: { code: 'await tools.read({ path: "/r/src/a.ts" });' } }, "/r");
  assert.equal(t.arg, "src/a.ts");
  assert.equal(t.argKind, "read");
});

const line = (o) => JSON.stringify(o) + "\n";
test("titles and placeholders are flagged for the type rule, nested ones too", () => {
  const s = infoNewSession("x");
  infoFeed(s, line({ type: "session", cwd: "/r", timestamp: "2026-11-17T10:00:00.000Z" })
    + line({ type: "message", timestamp: "2026-11-17T10:00:01.000Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "b", name: "bash", arguments: { command: "cd /r && node --test tests && git status -sb && git diff --stat" } },
      { type: "toolCall", id: "c", name: "codemode", arguments: { code: "x" } }] } })
    + line({ type: "message", timestamp: "2026-11-17T10:00:02.000Z", message: { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "ok" }], details: { title: "Runs the tests" } } })
    + line({ type: "message", timestamp: "2026-11-17T10:00:03.000Z", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "ok" }],
      nestedCalls: { complete: true, calls: [{ id: "c/1", name: "write", status: "ok", argumentsBytes: 9999 }] }, details: { calls: [{ id: "c/1", name: "write", status: "ok", args: '{"pa' }] } } }));
  const rows = infoRows(infoTools(s));
  const b = rows.find((r) => r.id === "b"), lost = rows.find((r) => r.id === "c/1");
  assert.equal(b.arg, "Runs the tests");
  assert.equal(b.titled, true);
  assert.equal(lost.arg, "File not recorded");
  assert.equal(lost.placeholder, true);
});

test("the status line names a running script's command without its kind", () => {
  const tools = [{ id: "r", kind: "code", arg: "node --test tests --watch", running: true }];
  const line = infoStatusLine({ status: "working", since: 1000, state: {}, tools, now: 61000 });
  assert.equal(line.text, "Working · 1m 00s · node --test tests --watch");
});

// ---- R2-6: folders --------------------------------------------------------------------------

test("in the repo a file's folder is its last segment, the whole path in the tooltip", () => {
  assert.deepEqual(infoFolder("/r/modules/home/herdr/mods/nix-info/main.js", "/r", "/Users/a"), { name: "main.js", folder: "nix-info", tip: "modules/home/herdr/mods/nix-info/main.js" });
  assert.deepEqual(infoFolder("/r/README.md", "/r", "/Users/a"), { name: "README.md", folder: "", tip: "README.md" });
});

test("outside the repo it is its anchor and last segment", () => {
  assert.equal(infoFolder("/tmp/herdr-sandbox/info-fixture/scratch/probe.mjs", "/r", "/Users/a").folder, "/tmp/…/scratch");
  assert.equal(infoFolder("/Users/a/x/y/scratch/f.txt", "/r", "/Users/a").folder, "~/…/scratch");
  assert.equal(infoFolder("/Users/a/scratch/f.txt", "/r", "/Users/a").folder, "~/scratch");
  assert.equal(infoFolder("/tmp/scratch/f.txt", "/r", "/Users/a").folder, "/tmp/scratch");
  assert.equal(infoFolder("/Users/a/f.txt", "/r", "/Users/a").folder, "~");
  // macOS's /tmp, /var and /etc are /private's: named as you type them.
  assert.equal(infoFolder("/private/tmp/herdr-sandbox/info-fixture/scratch/probe.mjs", "/r", "/Users/a").folder, "/tmp/…/scratch");
  assert.equal(infoFolder("/private/var/folders/x/f", "/r", "/Users/a").folder, "/var/…/x");
  assert.equal(infoFolder("/tmp/herdr-sandbox/info-fixture/scratch/probe.mjs", "/r", "/Users/a").tip, "/tmp/herdr-sandbox/info-fixture/scratch/probe.mjs");
});
