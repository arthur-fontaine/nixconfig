import assert from "node:assert/strict";
import { test } from "node:test";
import { wtClick, wtOrchestrator, wtArgv, ORCHESTRATOR_RE } from "../worktree.js";
import { isOrchestratorTab, orchestratorName } from "../../../kanban/src/herdr.ts";

test("worktree: a click on an open worktree only selects its space (its last tab shows)", () =>
  assert.deepEqual(wtClick({ space: { id: "s1" } }), [["space.select", { id: "s1" }]]));
test("worktree: a click on a checkout without a space opens one with a plain shell", () =>
  assert.deepEqual(wtClick({ space: null, path: "/r/wt-a", machine: null }), [["space.new", { folder: "/r/wt-a", machine: "" }]]));
test("worktree: Orchestrator focuses the one there", () =>
  assert.deepEqual(wtOrchestrator({ space: { id: "s1", tabs: [{ id: "t1", named: true, name: "wt-a-orchestrator" }] }, label: "wt-a", folder: "/r/wt-a", home: "/h" }),
    [["space.select", { id: "s1" }], ["tab.select", { id: "t1" }]]));
test("worktree: Orchestrator starts one when there is none", () =>
  assert.deepEqual(wtOrchestrator({ space: { id: "s1", tabs: [] }, label: "wt a", folder: "/r/wt-a", home: "/h" }),
    [["space.select", { id: "s1" }], ["tab.new", { space: "s1", name: "wt-a-orchestrator", folder: "/r/wt-a", argv: wtArgv("wt-a", "/h") }]]));
test("worktree: without a space, Orchestrator opens one with it", () =>
  assert.deepEqual(wtOrchestrator({ space: null, label: "wt-a", folder: "/r/wt-a", home: "/h", machine: null }),
    [["space.new", { folder: "/r/wt-a", machine: "", tab: "wt-a-orchestrator", argv: wtArgv("wt-a", "/h") }]]));
// The kanban finds the project orchestrator by the same names the mods give it.
test("worktree: the mods' orchestrator names match the kanban's", () => {
  for (const name of ["Orchestrator", "wt-a-orchestrator", "monorepo-project-orchestrator", orchestratorName("ddd ts/mono")])
    assert.equal(ORCHESTRATOR_RE.test(name), isOrchestratorTab(name), name);
  for (const name of ["Pi", "orchestrator-notes", "shell-1"]) assert.equal(ORCHESTRATOR_RE.test(name), false, name);
});
test("worktree: Orchestrator finds the one there under any worktree name, never the project's", () => {
  const space = { id: "s1", tabs: [{ id: "tp", named: true, name: "repo-project-orchestrator" }, { id: "t2", named: true, name: "old-name-orchestrator" }] };
  assert.deepEqual(wtOrchestrator({ space, label: "wt-a", folder: "/r/wt-a", home: "/h" }), [["space.select", { id: "s1" }], ["tab.select", { id: "t2" }]]);
});
test("worktree: an unnamed tab is never taken for an orchestrator", () =>
  assert.equal(wtOrchestrator({ space: { id: "s1", tabs: [{ id: "t1", named: false, name: "wt-a-orchestrator" }] }, label: "wt-a", folder: "/r/wt-a", home: "/h" })[1][0], "tab.new"));
test("worktree: the orchestrator's argv is nix-sidebar's (name, role prompt)", () =>
  assert.deepEqual(wtArgv("wt a", "/h"), ["pi", "--name", "wt-a-orchestrator", "--append-system-prompt", "/h/.pi/agent/orchestrator/worktree.md"]));
