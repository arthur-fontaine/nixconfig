// Figures the Info panel gets wrong, found by the phase-1 reliability audit (inventory.md,
// "Reliability"), fixed in phase 2.
import assert from "node:assert/strict";
import { test } from "node:test";
import { infoFeed, infoFiles, infoKeep, infoNewSession, infoTools } from "../model.js";

const line = (o) => JSON.stringify(o) + "\n";
const call = (ts, calls, extra = {}) => line({ type: "message", timestamp: ts, ...extra, message: { role: "assistant", model: "claude-opus-5-5", timestamp: Date.parse(ts),
  usage: { input: 1, cacheRead: 100, cacheWrite: 10, output: 5 }, content: calls.map((c) => ({ type: "toolCall", ...c })) } });
const result = (ts, id, extra = {}) => line({ type: "message", timestamp: ts, ...extra, message: { role: "toolResult", toolCallId: id, timestamp: Date.parse(ts), content: [{ type: "text", text: "" }] } });
const start = line({ type: "session", cwd: "/repo", timestamp: "2026-11-17T10:00:00.000Z" });

test("a write's last newline isn't a line: a 2-line file is +2", () => {
  const s = infoNewSession("f");
  infoFeed(s, start + call("2026-11-17T10:00:01.000Z", [{ id: "w", name: "write", arguments: { path: "/repo/a.js", content: "a\nb\n" } }])
    + result("2026-11-17T10:00:02.000Z", "w"));
  // git diff --numstat counts 2 for this new file; the panel says +3.
  assert.deepEqual(infoFiles(s).map((f) => [f.rel, f.added, f.removed]), [["a.js", 2, 0]]);
});

test("Claude Code's tool names (Bash, Edit, Write, AskUserQuestion) count for the filters and the lines", () => {
  const s = infoNewSession("f");
  infoFeed(s, start + call("2026-11-17T10:00:01.000Z", [
    { id: "b", name: "Bash", arguments: { command: "ls", description: "List" } },
    { id: "q", name: "AskUserQuestion", arguments: { questions: [{ question: "Keep it?" }] } },
    { id: "w", name: "Write", arguments: { file_path: "/repo/a.js", content: "a\nb" } },
    { id: "e", name: "Edit", arguments: { file_path: "/repo/b.js", old_string: "x", new_string: "y\nz" } },
  ]) + ["b", "q", "w", "e"].map((id, i) => result(`2026-11-17T10:00:0${i + 2}.000Z`, id)).join(""));
  const tools = infoTools(s);
  // An older 182 MB session of 2067 such calls shows 0 under every filter and no lines changed.
  for (const kind of ["bash", "ask", "edit"]) assert.equal(tools.filter((c) => infoKeep(c, kind)).length >= 1, true, kind);
  assert.deepEqual(infoFiles(s).map((f) => f.rel).sort(), ["a.js", "b.js"]);
});


// Herdr runtime behaviour, not reproducible in Node: a loop spawned from render() through a kept
// cx stopped at its first await on a fresh view (stuck on "Loading session…" after every mount
// until some command came). The loop is spawned in init() with init's cx; this keeps it there.
test("the panel's loop is spawned in init() with its own cx, never from render() or a kept cx", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../main.js", import.meta.url), "utf8");
  const body = (name) => src.slice(src.indexOf(`\n  ${name}(`), src.indexOf("\n  }\n", src.indexOf(`\n  ${name}(`)));
  assert.match(body("init"), /this\.start\(cx\)/);
  assert.doesNotMatch(body("render"), /start\(/);
  assert.doesNotMatch(src, /this\.cx\b/);
});
