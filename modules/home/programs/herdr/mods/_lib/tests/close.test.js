import assert from "node:assert/strict";
import { test } from "node:test";
import { closeAsk, closePlan } from "../close.js";

const shell = { kind: "terminal", shell: true, agent: false, name: "zsh" };
const prog = (name) => ({ kind: "terminal", shell: false, agent: false, name });
const agent = (app, status, resumable = null) => ({ kind: "terminal", shell: false, agent: true, app, status, name: app, resumable });
const board = { kind: "mod" };

// [what is closed, scope, items, extra, asks?]
const cases = [
  ["an idle shell, tab", "tab", [shell], {}, false],
  ["two idle shells, space", "space", [shell, shell], {}, false],
  ["a board, tab", "tab", [board], {}, false],
  ["a board, space (more than idle shells)", "space", [board], {}, true],
  ["sleep running, tab", "tab", [prog("sleep")], {}, true],
  ["nvim, pane", "pane", [prog("nvim")], {}, true],
  ["Pi working", "tab", [agent("pi", "working", true)], {}, true],
  ["Pi blocked", "tab", [agent("pi", "blocked", true)], {}, true],
  ["Pi idle, resumable, tab", "tab", [agent("pi", "idle", true)], {}, false],
  ["Pi done, resumable, pane", "pane", [agent("pi", "done", true)], {}, false],
  ["Pi idle, resumable, space", "space", [agent("pi", "idle", true)], {}, true],
  ["Pi idle, not resumable", "tab", [agent("pi", "idle", false)], {}, true],
  ["Pi idle, resumability unknown", "tab", [agent("pi", "idle", null)], {}, true],
  ["Claude Code idle (not resumable here)", "tab", [agent("claude-code", "idle")], {}, true],
  ["a shell whose sub-agent works", "tab", [shell], { workers: ["working"] }, true],
  ["a shell whose sub-agent is done", "tab", [shell], { workers: ["done"] }, false],
  ["nothing found", "tab", [], {}, true],
  ["a terminal without program facts", "tab", [{ kind: "terminal" }], {}, true],
  ["an idle shell on another machine", "tab", [shell], { remote: true }, true],
];

for (const [what, scope, items, extra, asks] of cases)
  test(`close: ${what} → ${asks ? "asks" : "no ask"}`, () => {
    const r = closeAsk({ scope, items, workers: [], remote: false, ...extra });
    assert.equal(r.ask, asks, JSON.stringify(r));
    if (asks) assert.ok(r.lost.length > 0, "an ask says what would be lost");
  });

// A world: space s1 (tabs t1 with panes p1+p2, t2 with p3), space s2 (one tab t3, one pane p4),
// s3 on another machine. t2 holds the board. A Pi worker (t9) started from p1's terminal.
const zsh = { shell: true, agent: false, name: "zsh" };
const world = {
  spaces: [
    { id: "s1", machine: null, tabs: [{ id: "t1" }, { id: "t2" }] },
    { id: "s2", machine: null, tabs: [{ id: "t3" }] },
    { id: "s3", machine: "vps", tabs: [{ id: "t4" }] },
  ],
  panes: [
    { pane: "p1", tab: "t1", terminal: "a1", program: zsh, status: null, app: null },
    { pane: "p2", tab: "t1", terminal: "a2", program: { shell: false, agent: true, name: "Pi" }, status: "idle", app: "pi" },
    { pane: "p3", tab: "t2", terminal: null, mod: "nix-kanban" },
    { pane: "p4", tab: "t3", terminal: "a4", program: zsh, status: null, app: null },
    { pane: "p5", tab: "t4", terminal: "a5", program: zsh, status: null, app: null },
  ],
  terminals: [
    { address: "a2", state: "live", labels: { "pi.session": "/s.jsonl" } },
    { address: "a9", state: "live", parent: "a1", status: "working" },
  ],
};

test("plan: a pane among others closes only that pane", () => {
  const p = closePlan(world, { pane: "p2" });
  assert.equal(p.scope, "pane");
  assert.deepEqual(p.commands, [["pane.close", { pane: "p2" }]]);
  assert.deepEqual(p.items, [{ kind: "terminal", shell: false, agent: true, app: "pi", status: "idle", name: "Pi", resumable: true }]);
});
test("plan: a tab's only pane closes the tab", () => {
  const p = closePlan(world, { pane: "p3" });
  assert.equal(p.scope, "tab");
  assert.deepEqual(p.commands, [["tab.close", { id: "t2", confirmed: true }]]);
});
test("plan: a space's only tab (its only pane) closes the space", () => {
  for (const target of [{ tab: "t3" }, { pane: "p4" }]) {
    const p = closePlan(world, target);
    assert.equal(p.scope, "space");
    assert.deepEqual(p.commands, [["space.close", { id: "s2", confirmed: true }]]);
  }
});
test("plan: a tab gathers its panes and its sub-agents", () => {
  const p = closePlan(world, { tab: "t1" });
  assert.equal(p.scope, "tab");
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.workers, ["working"]);
  assert.equal(closeAsk(p).ask, true);
});
test("plan: a pane reported as an agent by its status counts as one", () => {
  const w = { ...world, panes: world.panes.map((p) => (p.pane === "p1" ? { ...p, status: "working" } : p)) };
  assert.equal(closePlan(w, { pane: "p1" }).items[0].agent, true);
});
test("plan: several spaces at once", () => {
  const p = closePlan(world, { spaces: ["s1", "s2"] });
  assert.equal(p.scope, "space");
  assert.deepEqual(p.commands, [["space.close", { id: "s1", confirmed: true }], ["space.close", { id: "s2", confirmed: true }]]);
});
test("plan: another machine's space is remote", () => assert.equal(closePlan(world, { tab: "t4" }).remote, true));
test("plan: something gone plans nothing", () => {
  assert.equal(closePlan(world, { tab: "nope" }), null);
  assert.equal(closePlan(world, { pane: "nope" }), null);
});
