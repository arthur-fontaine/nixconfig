// Run: node --test 'modules/home/programs/pi/extensions/output-budget/tests/*.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAD, KEEP_ABOVE, TAIL, trimmed } from "../budget.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");

test("a short output is left alone", () => {
	assert.equal(trimmed(lines(10), "/tmp/o.txt"), undefined);
	assert.equal(trimmed("y".repeat(KEEP_ABOVE), "/tmp/o.txt"), undefined);
});

test("a long output keeps whole lines at both ends and says where the rest is", () => {
	const text = lines(2000);
	const out = trimmed(text, "/tmp/o.txt")!;
	assert.ok(out.length < HEAD + TAIL + 400);
	assert.ok(out.startsWith("line 0 "));
	assert.ok(out.endsWith(`line 1999 ${"x".repeat(40)}`));
	assert.match(out, /\n\[… \d+ lines \(\d+ characters\) left out to save context; the whole output is in \/tmp\/o\.txt\./);
	const [head] = out.split("\n[…");
	assert.match(head, /x$/, "the head ends on a whole line");
});

test("one huge line is still cut", () => {
	const out = trimmed("z".repeat(50_000), "/tmp/o.txt")!;
	assert.ok(out.length < HEAD + TAIL + 400);
});
