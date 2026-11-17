import assert from "node:assert/strict";
import { test } from "node:test";
import { closeAsk, closePlan, closeTarget } from "../close.js";

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
// What resolves Pi's resumability: the + popover's rule (sessionHidden, wtSessionDirName),
// and the git top of each Pi pane's folder (tops), all given by nix-status.
const rules = { hidden: (n) => /-orchestrator$|#[0-9a-f]{6,}$/.test(n ?? ""), dirName: (p) => `--${p.replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}--`, tops: { a2: "/r/wt" } };
const world = {
  ...rules,
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
    { address: "a2", state: "live", labels: { "pi.session": "/h/.pi/agent/sessions/--r-wt--/s.jsonl" } },
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

// nix-status.close-*: the command's name up to ":" (exactly), its ids after it, else what's focused.
const here = { pane: "pF", tab: "tF", space: "sF" };
for (const [cmd, want] of [
  ["close-pane", { pane: "pF" }], ["close-pane:p2", { pane: "p2" }],
  ["close-tab", { tab: "tF" }], ["close-tab:t3", { tab: "t3" }],
  ["close-space", { spaces: ["sF"] }], ["close-space:s2", { spaces: ["s2"] }],
  ["close-spaces:s1,s2", { spaces: ["s1", "s2"] }],
  ["close-spaces", null], ["close-confirmed", null], ["close-tabs:t1", null], ["jump", null],
]) test(`target: ${cmd}`, () => assert.deepEqual(closeTarget(cmd, here), want));
test("target: nothing focused targets nothing", () => {
  assert.equal(closeTarget("close-tab", {}), null);
  assert.equal(closeTarget("close-space", { space: null }), null);
});

// "Resumable" means the + popover would offer it again.
const piWorld = (over) => {
  const tab = { id: "t1", named: false, name: "1", ...over.tab };
  return {
    ...rules, tops: { a1: "/r/wt" }, ...over.rules,
    spaces: [{ id: "s1", machine: null, tabs: [tab, { id: "t2", named: false, name: "2" }] }],
    panes: [
      { pane: "p1", tab: "t1", terminal: "a1", program: { shell: false, agent: true, name: "Pi" }, status: "idle", app: "pi", title: over.title ?? "π - k31 islands - wt", cwd: "/r/wt" },
      { pane: "p2", tab: "t2", terminal: "a2", program: { shell: true, agent: false, name: "zsh" }, status: null, app: null },
    ],
    terminals: [{ address: "a1", state: "live", labels: over.labels ?? { "pi.session": "/h/.pi/agent/sessions/--r-wt--/s.jsonl" } }],
  };
};
const asks = (w) => closeAsk(closePlan(w, { tab: "t1" })).ask;
test("resumable: an idle Pi chat in its worktree's folder, in a tab with others → no ask", () => assert.equal(asks(piWorld({})), false));
test("resumable: idle main-orchestrator in a tab with others → asks", () => assert.equal(asks(piWorld({ tab: { named: true, name: "main-orchestrator" }, title: "π - main-orchestrator - main" })), true));
test("resumable: a project orchestrator's tab → asks", () => assert.equal(asks(piWorld({ tab: { named: true, name: "repo-project-orchestrator" } })), true));
test("resumable: a session named like an orchestrator in an unnamed tab → asks", () => assert.equal(asks(piWorld({ title: "π - wt-orchestrator - wt" })), true));
test("resumable: a pi-subagents worker given a pane → asks", () => assert.equal(asks(piWorld({ title: "π - general-purpose#534df88b - wt" })), true));
test("resumable: a session filed under another folder than the worktree's → asks", () =>
  assert.equal(asks(piWorld({ labels: { "pi.session": "/h/.pi/agent/sessions/--r-wt-src--/s.jsonl" } })), true));
test("resumable: no session label → asks", () => assert.equal(asks(piWorld({ labels: {} })), true));
test("resumable: no git top for the pane → asks", () => assert.equal(asks(piWorld({ rules: { tops: {} } })), true));
test("resumable: no popover rule given → asks", () => assert.equal(asks(piWorld({ rules: { hidden: undefined } })), true));
test("resumable: no session-folder rule given → asks", () => assert.equal(asks(piWorld({ rules: { dirName: undefined } })), true));
