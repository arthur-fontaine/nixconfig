import assert from "node:assert/strict";
import { test } from "node:test";
import { displayedCommand, fold, normalizeCommand, readPreview } from "../command.ts";

test("a cd into the working directory is dropped, one below it made relative", () => {
	assert.equal(displayedCommand("cd /repo && make", "/repo"), "make");
	assert.equal(displayedCommand('cd "/repo" && cd . && make', "/repo"), "make");
	assert.equal(displayedCommand("cd /repo/src/app && ls", "/repo"), "cd src/app && ls");
	assert.equal(displayedCommand("cd '/repo/my dir' && ls", "/repo"), "cd 'my dir' && ls");
	assert.equal(displayedCommand("cd /repo/a && cd /repo/a/b && ls", "/repo"), "cd a && cd b && ls");
});

test("other cds stay as written", () => {
	assert.equal(displayedCommand("cd /tmp && ls", "/repo"), "cd /tmp && ls");
	assert.equal(displayedCommand("cd .. && ls", "/repo"), "cd .. && ls");
	assert.equal(displayedCommand("cd $HOME && ls", "/repo"), "cd $HOME && ls");
	assert.equal(displayedCommand("cd ~/x && ls", "/repo"), "cd ~/x && ls");
	assert.equal(displayedCommand("cd /repo; ls", "/repo"), "cd /repo; ls");
});

test("commands are drawn without carriage returns, with tabs as three spaces", () => {
	assert.equal(normalizeCommand("a\r\n\tb"), "a\n   b");
});

test("folding keeps the first lines", () => {
	assert.deepEqual(fold(["a", "b", "c"], 1), { shown: ["a"], hidden: 2 });
	assert.deepEqual(fold(["a", "b", "c"], 5), { shown: ["a", "b", "c"], hidden: 0 });
	assert.deepEqual(fold(["a", "b"], "all"), { shown: ["a", "b"], hidden: 0 });
});

test("preview settings", () => {
	assert.equal(readPreview("all", 2), "all");
	assert.equal(readPreview(5, 2), 5);
	assert.equal(readPreview(0, 2), 2);
	assert.equal(readPreview("5", 2), 2);
	assert.equal(readPreview(undefined, 2), 2);
});
