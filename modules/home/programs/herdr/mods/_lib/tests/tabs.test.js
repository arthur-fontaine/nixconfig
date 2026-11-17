import assert from "node:assert/strict";
import { test } from "node:test";
import { tabLabel, tabLabelIsPath, tabSlot, tabMoveIndex, tabWheel } from "../tabs.js";

const W = "/r/wt-a";
const sh = (cwd, name = "zsh") => ({ cwd, title: "", program: { shell: true, agent: false, name } });

test("tabs: a named tab keeps its name", () => assert.equal(tabLabel({ named: true, name: "fix login", lead: sh(W), folder: W }), "fix login"));
test("tabs: a Pi tab shows its session, even one named Pi at creation", () => {
  const lead = { app: "pi", title: "π - k31 islands - wt-a", program: { agent: true, name: "Pi" } };
  assert.equal(tabLabel({ named: false, name: "1", lead, folder: W }), "k31 islands");
  assert.equal(tabLabel({ named: true, name: "Pi", lead, folder: W }), "k31 islands");
});
test("tabs: a Pi tab before its session has a name reads Pi", () =>
  assert.equal(tabLabel({ named: false, name: "1", lead: { app: "pi", title: "π - wt-a", program: { agent: true, name: "Pi" } }, folder: W }), "Pi"));
test("tabs: a mod tab shows its title", () => assert.equal(tabLabel({ named: false, name: "2", lead: { mod: "nix-kanban", title: "Board" }, folder: W }), "Board"));
test("tabs: a shell running a program shows the program", () =>
  assert.equal(tabLabel({ named: false, name: "2", lead: { cwd: W, program: { shell: false, agent: false, name: "sleep" } }, folder: W }), "sleep"));
test("tabs: an idle shell shows its folder relative to the worktree", () => assert.equal(tabLabel({ named: false, name: "2", lead: sh(W + "/mods/nix-tabs"), folder: W }), "mods/nix-tabs"));
// At the root a folder name would be the same on every shell tab (they all read "main"): Terminal.
test("tabs: an idle shell at the worktree's root reads Terminal", () => assert.equal(tabLabel({ named: false, name: "2", lead: sh(W + "/"), folder: W }), "Terminal"));
test("tabs: an idle shell elsewhere shows that folder's name", () => assert.equal(tabLabel({ named: false, name: "2", lead: sh("/tmp/x"), folder: W }), "x"));
test("tabs: nothing known reads Terminal", () => assert.equal(tabLabel({ named: false, name: "3", lead: null, folder: W }), "Terminal"));

// Bounds only come with the hovered tab's own events: its index, the pointer in it, its length.
test("tabs: the drop slot is the gap on the pointer's side of the hovered tab", () => {
  assert.equal(tabSlot(0, 10, 100), 0);
  assert.equal(tabSlot(0, 60, 100), 1);
  assert.equal(tabSlot(2, 49, 100), 2);
  assert.equal(tabSlot(2, 50, 100), 3);
  assert.equal(tabSlot(1, -4, 80), 1);
});
test("tabs: a shell tab named Pi before k31 shows what runs now", () =>
  assert.equal(tabLabel({ named: true, name: "Pi", lead: { cwd: "/r/wt-a/src", program: { shell: true, agent: false, name: "zsh" } }, folder: "/r/wt-a" }), "src"));
// tab.move's index is the final position from 1 (probed in the sandbox).
test("tabs: a drop slot becomes tab.move's final position, through hidden tabs", () => {
  const all = ["a", "b", "c", "d"], shown = ["a", "c", "d"]; // b is settled
  assert.equal(tabMoveIndex(all, shown, "a", 3), 4); // after d
  assert.equal(tabMoveIndex(all, shown, "d", 0), 1); // before a
  assert.equal(tabMoveIndex(all, shown, "a", 2), 3); // between c and d
  assert.equal(tabMoveIndex(all, shown, "c", 1), null); // its own place
  assert.equal(tabMoveIndex(all, shown, "c", 2), null); // its own place
});
// A folder label is cut at its start (its end tells tabs apart); any other at its end.
test("tabs: only a shell's folder label is a path", () => {
  assert.equal(tabLabelIsPath({ named: false, name: "2", lead: sh(W + "/mods/nix-tabs"), folder: W }), true);
  assert.equal(tabLabelIsPath({ named: false, name: "2", lead: sh("/tmp/x"), folder: W }), true);
  assert.equal(tabLabelIsPath({ named: false, name: "2", lead: sh(W), folder: W }), false);
  assert.equal(tabLabelIsPath({ named: true, name: "fix login", lead: sh(W + "/a"), folder: W }), false);
  assert.equal(tabLabelIsPath({ named: false, name: "2", lead: { app: "pi", title: "π - a long session - wt-a", program: { agent: true } }, folder: W }), false);
  assert.equal(tabLabelIsPath({ named: false, name: "2", lead: { cwd: W, program: { shell: false, agent: false, name: "sleep" } }, folder: W }), false);
});
test("tabs: a tab dropped on another space's list doesn't move", () => assert.equal(tabMoveIndex(["a", "b"], ["a", "b"], "z", 1), null));
// The wheel over the strip: mostly-vertical deltas add up; every 40 px steps one tab (clamped).
test("tabs: small vertical wheel deltas add up before a step", () => {
  let s = { acc: 0, index: 2 };
  s = tabWheel(s, 15, 0, 6); assert.deepEqual(s, { acc: 15, index: 2, step: false });
  s = tabWheel(s, 30, 0, 6); assert.deepEqual(s, { acc: 5, index: 3, step: true });
});
test("tabs: wheel up steps back, and stops at the ends", () => {
  assert.deepEqual(tabWheel({ acc: 0, index: 1 }, -45, 0, 6), { acc: 0, index: 0, step: true });
  assert.deepEqual(tabWheel({ acc: 0, index: 0 }, -45, 0, 6), { acc: 0, index: 0, step: false });
  assert.deepEqual(tabWheel({ acc: 0, index: 5 }, 90, 0, 6), { acc: 0, index: 5, step: false });
});
test("tabs: a mostly-horizontal swipe is left to the strip", () => assert.deepEqual(tabWheel({ acc: 10, index: 2 }, 5, 30, 6), { acc: 10, index: 2, step: false }));
