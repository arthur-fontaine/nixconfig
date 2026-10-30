import assert from "node:assert/strict";
import { test } from "node:test";
import { isBinary, lineCounts, splitLines } from "../diff.ts";

test("splitLines drops the empty line after a final newline", () => {
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
	assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
});

test("lineCounts counts like git --numstat", () => {
	assert.deepEqual(lineCounts("a\nb\nc\n", "a\nb\nc\n"), { added: 0, removed: 0 });
	assert.deepEqual(lineCounts("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
	assert.deepEqual(lineCounts("", "x\ny\n"), { added: 2, removed: 0 });
	assert.deepEqual(lineCounts("x\ny\n", ""), { added: 0, removed: 2 });
	assert.deepEqual(lineCounts("a\nb\nc\nd\n", "a\nc\nd\ne\nf\n"), { added: 2, removed: 1 });
	assert.deepEqual(lineCounts("a\nb", "a\nb\n"), { added: 1, removed: 1 });
});

test("lineCounts handles moved blocks with the shortest edit", () => {
	const before = ["1", "2", "3", "4", "5", "6"].join("\n");
	const after = ["4", "5", "6", "1", "2", "3"].join("\n");
	assert.deepEqual(lineCounts(before, after), { added: 3, removed: 3 });
});

test("lineCounts stays bounded on large, unrelated files", () => {
	const before = Array.from({ length: 20_000 }, (_, i) => `old ${i}`).join("\n");
	const after = Array.from({ length: 20_000 }, (_, i) => `new ${i}`).join("\n");
	const started = Date.now();
	assert.deepEqual(lineCounts(before, after), { added: 20_000, removed: 20_000 });
	assert.ok(Date.now() - started < 5_000);
});

test("isBinary looks for a NUL byte", () => {
	assert.equal(isBinary(Buffer.from("text")), false);
	assert.equal(isBinary(Buffer.from([1, 0, 2])), true);
});
