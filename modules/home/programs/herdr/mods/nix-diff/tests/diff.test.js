import assert from "node:assert/strict";
import { test } from "node:test";
import { addedFile, changedRanges, parsePatch, rowsOf } from "../model.js";
import { languageOf, splitAt, tokenize } from "../syntax.js";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ export function f()
 const a = 1;
-const b = foo(2);
+const b = bar(2);
 const c = 3;
+const d = 4;
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

test("parsePatch reads files, statuses, counts and line numbers", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.add, f.del, f.binary]), [
    ["src/a.ts", "M", 2, 1, false], ["new.md", "A", 1, 0, false], ["old.txt", "D", 0, 1, false], ["img.png", "M", 0, 0, true],
  ]);
  const h = files[0].hunks[0];
  assert.equal(h.context, "export function f()");
  assert.deepEqual(h.lines.map((l) => [l.kind, l.old ?? null, l.new ?? null]), [
    [" ", 1, 1], ["-", 2, null], ["+", null, 2], [" ", 3, 3], ["+", null, 4],
  ]);
});

test("a replaced line is a modified block with its changed word; a lone add is added", () => {
  const [, del, add, , extra] = parsePatch(PATCH)[0].hunks[0].lines;
  assert.equal(del.block, "modified");
  assert.equal(add.block, "modified");
  assert.equal(del.text.slice(...del.changed), "foo");
  assert.equal(add.text.slice(...add.changed), "bar");
  assert.equal(extra.block, "added");
  assert.equal(extra.changed, undefined);
});

test("changedRanges gives up on lines that share little", () => {
  assert.deepEqual(changedRanges("abc", "xyz"), [null, null]);
  assert.deepEqual(changedRanges("let x = 1;", "let x = 22;"), [[8, 9], [8, 10]]);
});

test("rowsOf folds files and notes binary ones", () => {
  const files = parsePatch(PATCH);
  const rows = rowsOf(files, new Set(["new.md"]));
  assert.deepEqual(rows.filter((r) => r.type === "file").length, 4);
  assert.equal(rows.some((r) => r.type === "line" && r.file === 1), false);
  assert.deepEqual(rows.find((r) => r.type === "note"), { type: "note", file: 3, text: "Binary file" });
});

test("addedFile numbers every line of a new file", () => {
  const f = addedFile("x.js", "a\nb\n");
  assert.deepEqual(f.hunks[0].lines.map((l) => [l.kind, l.new, l.text]), [["+", 1, "a"], ["+", 2, "b"]]);
  assert.equal(f.add, 2);
});

test("tokenize colors keywords, strings, calls, numbers and comments", () => {
  const kinds = (t, l) => tokenize(t, l).filter((x) => x.kind).map((x) => `${x.kind}:${x.text}`);
  assert.deepEqual(kinds('const s = run("x", 2); // hi', "js"), [
    "keyword:const", "operator:=", "function:run", "punctuation:(", 'string:"x"', "punctuation:,", "number:2", "punctuation:);", "comment:// hi",
  ]);
  assert.deepEqual(kinds("  a = ''b'';  # c", "nix"), ["property:a", "operator:=", "string:''b''", "punctuation:;", "comment:# c"]);
  assert.equal(tokenize("plain", null).length, 1);
  assert.equal(languageOf("lua/init.lua"), "lua");
  assert.equal(languageOf("README"), null);
});

test("splitAt cuts tokens at the changed range", () => {
  const parts = splitAt(tokenize("foo(bar)", "js"), [4, 7]);
  assert.deepEqual(parts.map((p) => [p.text, p.changed]), [["foo", false], ["(", false], ["bar", true], [")", false]]);
});
