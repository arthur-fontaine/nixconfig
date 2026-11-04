import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL, columnAt, editableFiles, liveFile, selectedCols, TEXT_X } from "../edit.js";

test("Neovim's hunks become the model's, changed words and blocks marked", () => {
  const f = liveFile({ path: "a.ts", status: "M" }, {
    add: 1, del: 1, modified: true,
    hunks: [{ oldStart: 1, newStart: 1, lines: [[" ", 1, 1, "a"], ["-", 2, null, "const b = foo(2);"], ["+", null, 2, "const b = foo(3);"]] }],
  });
  assert.equal(f.live, true);
  assert.equal(f.modified, true);
  assert.deepEqual([f.add, f.del, f.lines], [1, 1, 3]);
  const [ctx, del, add] = f.hunks[0].lines;
  assert.deepEqual(ctx, { kind: " ", old: 1, new: 1, text: "a" });
  assert.equal(del.new, undefined);
  assert.equal(add.block, "modified");
  assert.ok(add.changed);
});

test("a click lands on the nearest gap between characters", () => {
  assert.equal(columnAt(0), 0);
  assert.equal(columnAt(TEXT_X + CELL * 2.4), 2);
  assert.equal(columnAt(TEXT_X + CELL * 2.6), 3);
});

test("a selection covers its part of each line", () => {
  const sel = { from: [2, 3], to: [4, 1], lines: false };
  assert.equal(selectedCols(sel, 1, 10), null);
  assert.deepEqual(selectedCols(sel, 2, 10), [3, 11]);
  assert.deepEqual(selectedCols(sel, 3, 0), [0, 1]);
  assert.deepEqual(selectedCols(sel, 4, 10), [0, 1]);
  // Within one line: the cells before the caret.
  assert.deepEqual(selectedCols({ from: [5, 8], to: [5, 11], lines: false }, 5, 20), [8, 11]);
  assert.equal(selectedCols({ from: [5, 8], to: [5, 8], lines: false }, 5, 20), null);
  assert.deepEqual(selectedCols({ ...sel, lines: true }, 3, 5), [0, 5]);
});

test("binary and deleted files stay read-only; a rename is compared to its old name", () => {
  const files = [
    { path: "a.ts", status: "M" }, { path: "b.png", status: "M", binary: true },
    { path: "c.ts", status: "D" }, { path: "d.ts", status: "R", oldPath: "old/d.ts" },
  ];
  assert.deepEqual(editableFiles(files, "/r"), [
    { path: "/r/a.ts", root: "/r", base: "a.ts" },
    { path: "/r/d.ts", root: "/r", base: "old/d.ts" },
  ]);
});
