import assert from "node:assert/strict";
import { test } from "node:test";
import { tipText } from "../tip.js";

test("a tooltip is wrapped to a readable width and height", () => {
  // The script's own lines are kept; a long one wraps at a space.
  assert.equal(tipText("ls -la\necho " + "word ".repeat(20).trim(), 30),
    "ls -la\necho word word word word word\nword word word word word word\nword word word word word word\nword word word");
  // A token with no space (a path, base64) is cut hard.
  assert.equal(tipText("x".repeat(70), 30), "x".repeat(30) + "\n" + "x".repeat(30) + "\n" + "x".repeat(10));
  // Every line fits.
  const long = "hc kill t14p >/dev/null 2>&1; sleep 1; hc get t14p | python3 -c 'import json,sys;d=json.load(sys.stdin)'; cd /Users/arthur-fontaine/Developer/code/github.com/arthur-fontaine/nixconfig/.bare && git worktree list";
  for (const l of tipText(long).split("\n")) assert.ok(l.length <= 72, l);
  // A tall script stops after max lines, saying how many are left.
  const tall = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const tip = tipText(tall, 72, 24).split("\n");
  assert.equal(tip.length, 25);
  assert.equal(tip[24], "… +36 lines");
  assert.equal(tipText("short"), "short");
});
