// The redesign's model (decisions.md D1–D11, O3, F1–F5): what the panel shows, pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  infoCallState, infoCounts, infoEdited, infoFeed, infoGitFiles, infoIdleSince, infoKeep, infoKindCounts, infoMeterTone,
  infoNewSession, infoPaceText, infoRows, infoStatusLine, infoStepsLabel, infoTools, infoViewCommand,
} from "../model.js";

const line = (o) => JSON.stringify(o) + "\n";
const at = (s) => `2026-11-17T10:${s}.000Z`;
const assistant = (ts, calls) => line({ type: "message", timestamp: ts, message: { role: "assistant", model: "claude-opus-5-5", timestamp: Date.parse(ts),
  usage: { input: 1, cacheRead: 100, cacheWrite: 10, output: 5 }, content: calls.map((c) => ({ type: "toolCall", ...c })) } });
const result = (ts, id, extra = {}) => line({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: id, timestamp: Date.parse(ts), content: [{ type: "text", text: "" }], ...extra } });
const start = line({ type: "session", cwd: "/repo", timestamp: at("00:00") }) + line({ type: "message", timestamp: at("00:01"), message: { role: "user", content: "go" } });
const feed = (text) => { const s = infoNewSession("f"); infoFeed(s, start + text); return s; };

// A script whose second step failed and was caught, one whose step failed and it threw too, a
// failed bash, a read; the first script's write keeps neither arguments nor a readable path.
const SESSION = assistant(at("00:02"), [
  { id: "s1", name: "codemode", arguments: { code: "x" } },
  { id: "s2", name: "codemode", arguments: { code: "y" } },
  { id: "b", name: "bash", arguments: { command: "make" } },
  { id: "r", name: "read", arguments: { path: "/repo/a.js" } },
  { id: "e", name: "edit", arguments: { path: "/repo/src/b.js", edits: [{ oldText: "a", newText: "b" }] } },
  { id: "w", name: "write", arguments: { path: "/tmp/scratch.txt", content: "x\n" } },
]) + result(at("00:03"), "s1", { durationMs: 900, nestedCalls: { calls: [
  { id: "s1/1", name: "bash", status: "ok", arguments: { command: "ls" } },
  { id: "s1/2", name: "bash", status: "error", arguments: { command: "false" } },
  { id: "s1/3", name: "write", status: "ok", argumentsBytes: 90000 },
] }, details: { calls: [{ id: "s1/3", name: "write", args: "{\"con" }] } })
  + result(at("00:04"), "s2", { durationMs: 500, isError: true, nestedCalls: { calls: [
    { id: "s2/1", name: "edit", status: "ok", arguments: { path: "/repo/c.md", edits: [{ oldText: "q", newText: "r" }] } },
    { id: "s2/2", name: "bash", status: "error", arguments: { command: "exit 1" } },
  ] } })
  + result(at("00:05"), "b", { durationMs: 1200, isError: true })
  + result(at("00:06"), "r", { durationMs: 10 })
  + result(at("00:07"), "e", { durationMs: 30 })
  + result(at("00:08"), "w", { durationMs: 20 });

test("counts: every call, nested included; failed = calls that failed themselves (D6, F5)", () => {
  const tools = infoTools(feed(SESSION));
  // 6 top-level + 5 nested.
  // Failed: s1/2, s2 (it threw) and s2/2 (its failing step: two failures), b. s1 went on: not failed.
  assert.deepEqual(infoCounts(tools), { calls: 11, failed: 4 });
  const s1 = infoRows(tools).find((r) => r.id === "s1");
  assert.equal(s1.failed, false);
  assert.equal(s1.stepFailed, true); // the hollow dot
  assert.equal(infoRows(tools).find((r) => r.id === "s2").failed, true);
  assert.equal(infoRows(tools).find((r) => r.id === "s1/2").failed, true);
});

test("kind chips count matching calls, nested included; 'failed' filters too", () => {
  const tools = infoTools(feed(SESSION));
  assert.deepEqual(infoKindCounts(tools), { all: 11, bash: 4, read: 1, edit: 4, ask: 0, failed: 4 });
  const kept = tools.map((c) => infoKeep(c, "failed")).filter(Boolean);
  assert.deepEqual(infoRows(kept).map((r) => r.id), ["b", "s2", "s2/2", "s1", "s1/2"]);
});

test("edited files: in the repo only, outside ones apart, 'at least' when a write's path is unknown (O3)", () => {
  const e = infoEdited(feed(SESSION), "/repo");
  assert.deepEqual(e.files.map((f) => [f.rel, f.name, f.dir]), [["c.md", "c.md", ""], ["src/b.js", "b.js", "src"]]);
  assert.deepEqual(e.outside.map((f) => f.path), ["/tmp/scratch.txt"]);
  assert.equal(e.atLeast, true);
  // Cut arguments that end inside the path name no file.
  const cut = feed(assistant(at("00:02"), [{ id: "c", name: "codemode", arguments: { code: "x" } }])
    + result(at("00:03"), "c", { nestedCalls: { calls: [{ id: "c/1", name: "write", status: "ok", argumentsBytes: 9000 }] }, details: { calls: [{ id: "c/1", name: "write", args: "{\"path\":\"/repo/sr" }] } }));
  assert.deepEqual(infoEdited(cut, "/repo"), { files: [], outside: [], atLeast: true });
  const lost = infoRows(infoTools(cut)).find((r) => r.id === "c/1");
  assert.deepEqual([lost.arg, lost.path], ["File not recorded", null]);
  // A failed edit didn't edit anything.
  const s = feed(assistant(at("00:02"), [{ id: "x", name: "edit", arguments: { path: "/repo/z.js", edits: [{ oldText: "a", newText: "b" }] } }])
    + result(at("00:03"), "x", { isError: true }));
  assert.deepEqual(infoEdited(s, "/repo"), { files: [], outside: [], atLeast: false });
});

test("bash-changes records count as edits, by the record's root", () => {
  const s = feed(assistant(at("00:02"), [{ id: "b", name: "bash", arguments: { command: "sed -i x y" } }])
    + result(at("00:03"), "b", { details: { fileChanges: { root: "/repo", files: [{ path: "y", added: 1, removed: 1 }] } } }));
  assert.deepEqual(infoEdited(s, "/repo").files.map((f) => f.rel), ["y"]);
});

test("Claude Code's names: kinds, filters and edited files (F2)", () => {
  const s = feed(assistant(at("00:02"), [
    { id: "b", name: "Bash", arguments: { command: "ls", description: "List" } },
    { id: "q", name: "AskUserQuestion", arguments: { questions: [{ question: "Keep it?" }] } },
    { id: "w", name: "Write", arguments: { file_path: "/repo/a.js", content: "a\nb\n" } },
    { id: "e", name: "Edit", arguments: { file_path: "/repo/b.js", old_string: "x", new_string: "y\nz" } },
  ]) + ["b", "q", "w", "e"].map((id, i) => result(at(`00:0${i + 3}`), id)).join(""));
  const tools = infoTools(s);
  assert.deepEqual(tools.map((c) => [c.kind, c.arg]).reverse(), [["bash", "ls"], ["ask", "Keep it?"], ["write", "a.js"], ["edit", "b.js"]]);
  assert.deepEqual(infoKindCounts(tools), { all: 4, bash: 1, read: 0, edit: 2, ask: 1, failed: 0 });
  assert.deepEqual(infoEdited(s, "/repo").files.map((f) => f.rel), ["a.js", "b.js"]);
});

test("an open call: running while the agent works, 'no result' when it doesn't (F3)", () => {
  const s = feed(assistant(at("00:02"), [{ id: "o", name: "bash", arguments: { command: "sleep 9" } }]));
  const [o] = infoTools(s);
  assert.equal(infoCallState(o, true), "running");
  assert.equal(infoCallState(o, false), "no-result");
  const done = infoTools(feed(assistant(at("00:02"), [{ id: "d", name: "bash", arguments: { command: "ls" } }]) + result(at("00:03"), "d")))[0];
  assert.equal(infoCallState(done, false), "done");
});

test("started only when exact: finished − took, from Pi's durationMs (F4)", () => {
  const tools = infoTools(feed(SESSION));
  const b = tools.find((c) => c.id === "b");
  assert.equal(b.startedExact, Date.parse(at("00:05")) - 1200);
  const s = feed(assistant(at("00:02"), [{ id: "n", name: "bash", arguments: { command: "ls" } }]) + result(at("00:09"), "n"));
  assert.equal(infoTools(s)[0].startedExact, null);
  // Sub-rows have no clock.
  assert.equal(infoRows(tools).find((r) => r.id === "s1/1").startedExact, null);
});

test("idle since the last result, not the last call's start", () => {
  assert.equal(infoIdleSince(feed(SESSION)), Date.parse(at("00:08")));
  assert.equal(infoIdleSince(feed("")), null);
});

test("the status line comes from Herdr's status; the session only names the running call (D1)", () => {
  const s = feed(assistant(at("00:02"), [{ id: "o", name: "bash", arguments: { command: "node --test tests" } }]));
  const now = Date.parse(at("01:11"));
  const tools = infoTools(s);
  assert.deepEqual(infoStatusLine({ status: "working", since: Date.parse(at("00:02")), state: s, tools, now }),
    { tone: "working", text: "Working · 1m 09s · node --test tests" });
  assert.deepEqual(infoStatusLine({ status: "blocked", since: null, state: s, tools, now }), { tone: "waiting", text: "Waiting for your answer" });
  assert.deepEqual(infoStatusLine({ status: "idle", since: null, state: s, tools, now }), { tone: "stopped", text: "Stopped mid-call" });
  const d = feed(SESSION);
  assert.deepEqual(infoStatusLine({ status: "done", since: null, state: d, tools: infoTools(d), now: Date.parse(at("43:08")) }), { tone: "idle", text: "Idle for 43m" });
  assert.deepEqual(infoStatusLine({ status: "idle", since: null, state: feed(""), tools: [], now }), { tone: "idle", text: "No calls yet" });
});

test("meters: neutral, warning at 80 %, error at 95 %; pace text only when ahead (D2)", () => {
  assert.deepEqual([0.2, 0.79, 0.8, 0.949, 0.95, 1].map(infoMeterTone), ["normal", "normal", "warning", "warning", "error", "error"]);
  assert.equal(infoPaceText(0.12), "12 pts ahead of pace");
  assert.equal(infoPaceText(0.004), null);
  assert.equal(infoPaceText(-0.3), null);
  assert.equal(infoPaceText(null), null);
});

test("git's per-file stats: status letter and +/−, new files too (O3)", () => {
  const files = infoGitFiles("1\t1\tsrc/a.js\n-\t-\timg.png\n", "M\tsrc/a.js\nM\timg.png\n", ["new.js"], { "new.js": 14 });
  assert.deepEqual(files, { "src/a.js": { status: "M", added: 1, removed: 1 }, "img.png": { status: "M", added: null, removed: null }, "new.js": { status: "A", added: 14, removed: 0 } });
});

test("an untitled script reads as its steps", () => {
  assert.equal(infoStepsLabel([{ kind: "read" }, { kind: "edit" }, { kind: "write" }, { kind: "edit" }]), "4 steps: read, edit, write");
  assert.equal(infoStepsLabel([{ kind: "bash" }]), "1 step: bash");
  assert.equal(infoStepsLabel([]), null);
});

test("nix-info.<verb> commands put the panel in any state; Back keeps filter and selection (D10)", () => {
  const home = { detail: null, from: null, kind: "all", sel: null, all: false, collapsed: [], context: false, outside: false, fill: null };
  const on = (v, c, ids) => infoViewCommand(v, c, ids);
  assert.deepEqual(on(home, "detail:calls"), { ...home, detail: "calls" });
  assert.deepEqual(on(home, "detail:files"), { ...home, detail: "files" });
  assert.equal(on(home, "detail:context"), null);
  assert.deepEqual(on(home, "kind:failed"), { ...home, detail: "calls", kind: "failed" });
  assert.equal(on(home, "kind:errors"), null);
  // A call is pushed over the list it came from; back returns there with the call still selected.
  const call = on({ ...home, detail: "calls", kind: "bash" }, "select:s1/2");
  assert.deepEqual(call, { ...home, detail: "call", from: "calls", kind: "bash", sel: "s1/2" });
  assert.deepEqual(on(call, "back"), { ...home, detail: "calls", kind: "bash", sel: "s1/2" });
  assert.deepEqual(on(on(home, "select:x"), "back"), { ...home, sel: "x" });
  assert.deepEqual(on(call, "select:"), { ...home, detail: "calls", kind: "bash", sel: "s1/2" });
  // ↑/↓ through the listed ids.
  assert.equal(on(call, "next", ["s1", "s1/2", "b"]).sel, "b");
  assert.equal(on(call, "prev", ["s1", "s1/2", "b"]).sel, "s1");
  assert.equal(on(call, "next", ["s1", "s1/2"]).sel, "s1/2");
  // Back from a list keeps the filter, the selection and Show all.
  assert.deepEqual(on({ ...home, detail: "calls", kind: "read", all: true, sel: "r" }, "back"), { ...home, kind: "read", all: true, sel: "r" });
  assert.deepEqual(on(home, "all"), { ...home, all: true });
  assert.deepEqual(on(on(home, "toggle:s1"), "toggle:s2"), { ...home, collapsed: ["s1", "s2"] });
  assert.deepEqual(on({ ...home, collapsed: ["s1"] }, "toggle:s1"), home);
  assert.deepEqual(on(home, "open:context"), { ...home, context: true });
  assert.deepEqual(on({ ...home, context: true }, "close:context"), home);
  assert.deepEqual(on(home, "open:outside"), { ...home, outside: true });
  assert.deepEqual(on(home, "fill:#ff00ff"), { ...home, fill: "#ff00ff" });
  assert.deepEqual(on({ ...home, fill: "#ff00ff", kind: "bash", detail: "calls" }, "reset"), home);
  assert.equal(on(home, "whatever"), null);
});
