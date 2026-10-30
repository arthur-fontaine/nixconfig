import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { bashFastPath, editable, fastPath, split } from "../fastpath.ts";

const cwd = mkdtempSync(path.join(os.tmpdir(), "auto-mode-"));
mkdirSync(path.join(cwd, "src"));
symlinkSync(os.tmpdir(), path.join(cwd, "escape"));
after(() => rmSync(cwd, { recursive: true, force: true }));

test("read-only lookups and the question tool skip the classifier", () => {
	for (const tool of ["read", "grep", "find", "ls"]) assert.deepEqual(fastPath(tool, { path: "/etc" }, cwd), { kind: "allow", why: "allowlist" });
	assert.deepEqual(fastPath("ask_user_question", {}, cwd), { kind: "interactive" });
	assert.equal(fastPath("mcp__x__y", {}, cwd), undefined);
});

test("edits run directly inside the working directory, except protected files", () => {
	assert.ok(editable(cwd, "src/a.ts"));
	assert.ok(editable(cwd, path.join(cwd, "new/dir/file")));
	assert.ok(!editable(cwd, "../outside"));
	assert.ok(!editable(cwd, "/etc/hosts"));
	assert.ok(!editable(cwd, "escape/x"), "a symlink out of the directory");
	assert.ok(!editable(cwd, ".git/config"));
	assert.ok(!editable(cwd, ".pi/settings.json"));
	assert.ok(!editable(cwd, "sub/.bashrc"));
	assert.ok(!editable(cwd, "."));
	assert.deepEqual(fastPath("write", { path: "src/a.ts", content: "" }, cwd), { kind: "allow", why: "acceptEdits" });
	assert.equal(fastPath("edit", { path: "~/.zshrc", edits: [] }, cwd), undefined);
});

test("the shell lexer splits commands and refuses what it cannot see through", () => {
	assert.deepEqual(split("ls -la 'a b' && git status | wc -l 2>&1"), [
		{ argv: ["ls", "-la", "a b"], redirects: [] },
		{ argv: ["git", "status"], redirects: [] },
		{ argv: ["wc", "-l"], redirects: [{ op: "2>&", target: "1" }] },
	]);
	for (const opaque of ["echo $HOME", "ls `pwd`", "(cd x)", "cat <<EOF", 'echo "$(id)"', "echo 'unterminated"]) assert.equal(split(opaque), null, opaque);
});

test("read-only commands, as Bash's own check allows them", () => {
	for (const cmd of ["ls -la", "git status && git diff --stat", "cat a | grep x | wc -l", "find . -name '*.ts'", "git log -5 > /dev/null 2>&1", "cd src && ls", "git branch -a"])
		assert.equal(bashFastPath(cmd, cwd), "readOnly", cmd);
	for (const cmd of ["echo x > f", "git push", "curl https://x", "find . -delete", "sort -o out in", "git -c core.pager=x log", "git branch -D main", "env", "npm test"])
		assert.notEqual(bashFastPath(cmd, cwd), "readOnly", cmd);
});

test("file commands inside the working directory, as acceptEdits allows them", () => {
	for (const cmd of ["mkdir -p a/b && touch a/b/c", "rm -rf src", "mv src/a src/b", "sed -i 's/a/b/g' src/x.ts", "cp src/a src/b; rmdir src/old"])
		assert.equal(bashFastPath(cmd, cwd), "acceptEdits", cmd);
	for (const cmd of ["rm -rf .", "rm -rf ../x", "rm -rf /tmp/x", "rm *.log", "rm -rf ~", "sed -i 's/a/b/w /etc/x' f", "sed -i -e 's/a/b/' f", "mv a b > log", "rm", "mkdir a && npm i"])
		assert.equal(bashFastPath(cmd, cwd), undefined, cmd);
});
