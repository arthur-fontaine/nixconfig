import assert from "node:assert/strict";
import { test } from "node:test";

import { allowed, blocked, fresh, limitPrompt, overLimit } from "../denials.ts";
import { destroysWork, parsePorcelain } from "../meta.ts";

test("three blocks in a row reach the limit; an allow starts the run over", () => {
	let d = fresh();
	d = blocked(blocked(d));
	assert.ok(!overLimit(d));
	d = allowed(d);
	assert.deepEqual(d, { consecutive: 0, total: 2 });
	d = blocked(blocked(blocked(d)));
	assert.ok(overLimit(d));
	const { text, next } = limitPrompt(d, "[Git Destructive]");
	assert.equal(text, "3 consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: [Git Destructive]");
	assert.deepEqual(next, d);
});

test("twenty blocks in a session reach the limit and reset both counts", () => {
	const d = { consecutive: 1, total: 20 };
	assert.ok(overLimit(d));
	const { text, next } = limitPrompt(d, "r");
	assert.match(text, /^20 actions were blocked this session\./);
	assert.deepEqual(next, fresh());
});

test("the git status line goes above commands that can destroy uncommitted work", () => {
	for (const cmd of ["git reset --hard HEAD~1", "git checkout .", "git restore --staged .", "git clean -fd", "rm -rf build", "rm -f x", "cd a && rm -r b"]) assert.ok(destroysWork(cmd), cmd);
	for (const cmd of ["git reset HEAD", "git checkout main", "rm-tool x", "ls -rf"]) assert.ok(!destroysWork(cmd), cmd);
	assert.deepEqual(parsePorcelain(""), { clean: true });
	assert.deepEqual(parsePorcelain("M  a\n M b\nMM c\n?? d\n"), { staged: 2, modified: 2, untracked: 1 });
});
