// Round 3b (brief-r3b.md): defects found in the after-r3 shots, pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { infoFeed, infoKeep, infoKindCounts, infoCounts, infoListRows, infoNewSession, infoTools, infoListMeta, infoCallsIn, infoUnnamedText, infoEdited, infoRowTime, infoOutsideText, infoTool } from "../model.js";

// The fixture sessions, as info-shots shoots them.
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "info-r3b-"));
execFileSync("node", [join(here, "../../../scripts/info-session"), dir]);
const load = (name) => { const s = infoNewSession(name); infoFeed(s, readFileSync(join(dir, name + ".jsonl"), "utf8")); return infoTools(s); };
const FIXTURES = { session: load("session"), cc: load("cc"), big: load("big") };
const KINDS = ["all", "bash", "read", "edit", "ask", "other", "failed"];
const listed = (tools, kind) => infoListRows(tools.map((c) => infoKeep(c, kind)).filter(Boolean), []);

// ---- 1. one unit, calls: scripts are containers, failed = the filled red dots ---------------

test("All counts tool calls only, and the kind chips add up to it", () => {
  for (const [name, tools] of Object.entries(FIXTURES)) {
    const n = infoKindCounts(tools);
    assert.equal(n.bash + n.read + n.edit + n.ask + n.other, n.all, name);
    assert.equal(infoCounts(tools).calls, n.all, name);
    assert.equal(infoCounts(tools).failed, n.failed, name);
  }
  assert.equal(infoKindCounts(FIXTURES.session).all, 214);
  assert.equal(infoKindCounts(FIXTURES.session).other, 0);
  assert.equal(infoKindCounts(FIXTURES.cc).other, 1); // its Grep
});

test("failed is the number of filled red dots in the full list", () => {
  for (const [name, tools] of Object.entries(FIXTURES)) {
    const dots = listed(tools, "all").filter((r) => r.failed).length;
    assert.equal(infoKindCounts(tools).failed, dots, name);
  }
  assert.equal(infoKindCounts(FIXTURES.session).failed, 3);
});

test("a script row never has the filled dot; it has the hollow one when it threw or a step failed", () => {
  const rows = listed(FIXTURES.session, "all");
  for (const r of rows.filter((r) => r.kind === "code")) assert.equal(r.failed, false, r.id);
  assert.ok(rows.some((r) => r.kind === "code" && r.stepFailed));
});

test("the calls a list shows, counted as the chips count them, for every filter", () => {
  for (const [name, tools] of Object.entries(FIXTURES)) {
    const n = infoKindCounts(tools);
    for (const kind of KINDS) assert.equal(infoCallsIn(listed(tools, kind), kind), n[kind], `${name} ${kind}`);
  }
});

test("the Calls header: the latest N of the total, in calls, only when the list is capped", () => {
  assert.equal(infoListMeta(200, 214, true), "latest 200 of 214 calls");
  assert.equal(infoListMeta(1, 1467, true), "latest 1 of 1,467 calls");
  assert.equal(infoListMeta(214, 214, false), "");
});

// ---- 2. the edits with no file name, said once, in the detail --------------------------------

test("the edits with no file name: one muted row in the detail", () => {
  assert.equal(infoUnnamedText(1), "1 edit with no file name");
  assert.equal(infoUnnamedText(3), "3 edits with no file name");
  assert.equal(infoUnnamedText(0), null);
  const s = infoNewSession("session");
  infoFeed(s, readFileSync(join(dir, "session.jsonl"), "utf8"));
  const e = infoEdited(s, s.cwd);
  assert.equal(e.unnamed, 1);
  assert.equal(e.files.length, 8);
});

// ---- 8. a row's time column: what the call is doing when it has no time ----------------------

test("a row's time: its duration, \"running\" while it runs, \"stopped\" when cut off", () => {
  assert.equal(infoRowTime({ duration: 1300 }, "done"), "1.3s");
  assert.equal(infoRowTime({ duration: 40 }, "done"), "<0.1s");
  assert.equal(infoRowTime({ duration: null }, "running"), "running");
  assert.equal(infoRowTime({ duration: null }, "no-result"), "stopped");
  assert.equal(infoRowTime({ duration: null }, "done"), "");
});

// ---- 10. the overview's outside count says what it is outside of ------------------------------

test("files edited outside the repo: \"+2 outside repo\"", () => {
  assert.equal(infoOutsideText(2), "+2 outside repo");
  assert.equal(infoOutsideText(0), null);
});

// ---- 9. a Grep shows what it looked for, and where ------------------------------------------

test("Grep: its pattern quoted and its folder; Glob: its pattern", () => {
  // "DEFAULT" was the cc fixture's real pattern (the constant it searched for), read as a keyword.
  assert.equal(infoTool({ name: "Grep", arguments: { pattern: "DEFAULT", path: "/repo/src" } }, "/repo").arg, "\"DEFAULT\" in src");
  assert.equal(infoTool({ name: "Grep", arguments: { pattern: "TODO", output_mode: "count" } }, "/repo").arg, "\"TODO\"");
  assert.equal(infoTool({ name: "Glob", arguments: { pattern: "src/**/*.js" } }, "/repo").arg, "src/**/*.js");
  const cc = FIXTURES.cc.find((c) => c.name === "Grep");
  assert.equal(cc.arg, "\"DEFAULT\" in src");
});
