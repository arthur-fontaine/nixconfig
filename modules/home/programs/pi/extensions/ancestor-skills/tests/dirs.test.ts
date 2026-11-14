// Run: node --test 'modules/home/programs/pi/extensions/ancestor-skills/tests/*.test.ts'
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { skillDirsAboveGitRoot } from "../dirs.ts";

function setup() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ancestor-skills-")));
	const repo = join(home, "code", "monorepo");
	mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
	writeFileSync(join(repo, ".git"), "gitdir: ./.bare\n");
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	return { home, repo };
}

function worktree(at: string) {
	mkdirSync(at, { recursive: true });
	writeFileSync(join(at, ".git"), "gitdir: ../.bare/worktrees/x\n");
	return at;
}

test("a worktree directly under the bare-repo folder gets its skills", () => {
	const { home, repo } = setup();
	const tree = worktree(join(repo, "a-worktree"));
	assert.deepEqual(skillDirsAboveGitRoot(join(tree, "backend"), home), [join(repo, ".agents", "skills")]);
});

test("a worktree nested in a subfolder gets them too", () => {
	const { home, repo } = setup();
	const tree = worktree(join(repo, "chore", "a-worktree"));
	assert.deepEqual(skillDirsAboveGitRoot(tree, home), [join(repo, ".agents", "skills")]);
});

test("the bare-repo folder itself adds nothing Pi does not already load", () => {
	const { home, repo } = setup();
	assert.deepEqual(skillDirsAboveGitRoot(repo, home), []);
});

test("outside a repository nothing is added", () => {
	const { home } = setup();
	const plain = join(home, "notes");
	mkdirSync(plain);
	assert.deepEqual(skillDirsAboveGitRoot(plain, home), []);
});
