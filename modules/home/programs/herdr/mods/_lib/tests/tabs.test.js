import assert from "node:assert/strict";
import { test } from "node:test";
import { tabLabel, tabDropAt, tabMoveIndex } from "../tabs.js";

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
test("tabs: an idle shell at the worktree's root shows the worktree's folder", () => assert.equal(tabLabel({ named: false, name: "2", lead: sh(W + "/"), folder: W }), "wt-a"));
test("tabs: an idle shell elsewhere shows that folder's name", () => assert.equal(tabLabel({ named: false, name: "2", lead: sh("/tmp/x"), folder: W }), "x"));
test("tabs: nothing known reads Terminal", () => assert.equal(tabLabel({ named: false, name: "3", lead: null, folder: W }), "Terminal"));

const rects = [{ left: 0, width: 100 }, { left: 102, width: 80 }, { left: 184, width: 120 }];
test("tabs: the drop slot is the gap nearest the pointer", () => {
  assert.equal(tabDropAt(rects, -5), 0);
  assert.equal(tabDropAt(rects, 40), 0);
  assert.equal(tabDropAt(rects, 60), 1);
  assert.equal(tabDropAt(rects, 150), 2);
  assert.equal(tabDropAt(rects, 400), 3);
});
// tab.move's index is the final position from 1 (probed in the sandbox).
test("tabs: a drop slot becomes tab.move's final position, through hidden tabs", () => {
  const all = ["a", "b", "c", "d"], shown = ["a", "c", "d"]; // b is settled
  assert.equal(tabMoveIndex(all, shown, "a", 3), 4); // after d
  assert.equal(tabMoveIndex(all, shown, "d", 0), 1); // before a
  assert.equal(tabMoveIndex(all, shown, "a", 2), 3); // between c and d
  assert.equal(tabMoveIndex(all, shown, "c", 1), null); // its own place
  assert.equal(tabMoveIndex(all, shown, "c", 2), null); // its own place
});
