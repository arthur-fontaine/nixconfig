import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { gitDirTrusted, parse, readOnlyRefusal } from "../readonly.ts";

// A repository laid out as git makes one, without running git.
const repo = mkdtempSync(path.join(os.tmpdir(), "auto-mode-ro-"));
mkdirSync(path.join(repo, ".git", "objects"), { recursive: true });
mkdirSync(path.join(repo, ".git", "refs"));
writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "a.txt"), "a\n");
writeFileSync(path.join(repo, "b.txt"), "b\n");

// A worktree of a bare repository kept in `.bare`, as in this nixconfig checkout.
const bare = mkdtempSync(path.join(os.tmpdir(), "auto-mode-bare-"));
const gitdir = path.join(bare, ".bare", "worktrees", "main");
mkdirSync(gitdir, { recursive: true });
writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
mkdirSync(path.join(bare, "main"));
writeFileSync(path.join(bare, "main", ".git"), `gitdir: ${gitdir}\n`);
const worktree = path.join(bare, "main");

after(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(bare, { recursive: true, force: true });
});

const allowed = (cmd: string, cwd = repo) => assert.equal(readOnlyRefusal(cmd, cwd), null, cmd);
const refused = (cmd: string, why?: string, cwd = repo) => {
	const refusal = readOnlyRefusal(cmd, cwd);
	assert.notEqual(refusal, null, cmd);
	if (why) assert.equal(refusal, why, cmd);
};

test("the parser reads plain commands and refuses what it cannot see through", () => {
	const script = parse("LANG=C grep -n 'a b' \"c\" x\\ y 2>&1 && ls *.ts | wc -l\n# note\n");
	assert.deepEqual(
		script?.commands.map((c) => [c.env, c.argv, c.redirects]),
		[
			[[{ name: "LANG", value: "C" }], ["grep", "-n", "a b", "c", "x y"], [{ op: ">&", target: "1" }]],
			[[], ["ls", "*.ts"], []],
			[[], ["wc", "-l"], []],
		],
	);
	assert.deepEqual(script?.joins, ["&&", "|"]);
	assert.equal(script?.commands[1]!.words[1]!.glob, true);
	assert.equal(parse("ls '*.ts'")?.commands[0]!.words[1]!.glob, false);
	for (const opaque of ["echo $HOME", 'echo "$(id)"', "ls `pwd`", "(ls)", "{ ls; }", "cat <<EOF\nx\nEOF", "cat <<< x", "diff <(ls) <(ls)", "sleep 1 &", "X=1", "ls &&", "; ls", "echo 'open", "ls |& cat"])
		assert.equal(parse(opaque), null, opaque);
});

test("read-only commands run without the classifier", () => {
	for (const cmd of [
		"ls -la",
		"cat a.txt | grep -n x | wc -l",
		"find . -name '*.ts' -type f -maxdepth 2",
		"sed -n 1,20p a.txt",
		"sed -n '1p;5,9p' a.txt",
		"cat a.txt | sed 's/a/b/g'",
		"head -n 5 a.txt && tail -n 5 a.txt; wc -c a.txt",
		"grep -rn foo src 2>/dev/null | head -20",
		"grep -A3 -i foo a.txt",
		"rg -n --hidden -g '*.ts' foo",
		"jq -r '.name' a.txt",
		"sort -u a.txt | uniq -c",
		"ls *.txt",
		"wc -l *.txt",
		"diff a.txt b.txt",
		"tree -L 2",
		"file a.txt; stat a.txt",
		"echo hi; pwd; date +%Y",
		"printf '%s\\n' x",
		"test -f a.txt",
		"fd -e ts",
		"find . -type f | xargs grep -l foo",
		"LANG=C sort a.txt",
		"command ls src",
		"ls\n# a comment\nls src\n",
		"cat < a.txt",
	])
		allowed(cmd);
});

test("git's read-only subcommands, with their safe flags only", () => {
	for (const cmd of [
		"git status --short",
		"git log --oneline -5",
		"git log --format='%h %s' -n 3",
		"git diff --stat HEAD~1",
		"git diff a.txt",
		"git show HEAD --stat",
		"git branch -a",
		"git branch --merged main",
		"git tag -l 'v*'",
		"git rev-parse --show-toplevel",
		"git ls-files src",
		"git blame -L 1,5 a.txt",
		"git config --get user.name",
		"git remote -v",
		"git stash list",
		"git worktree list",
		"git grep -n foo src",
	])
		allowed(cmd);
	for (const cmd of [
		"git log --output=x",
		"git diff --output=x",
		"git show --output=x",
		"git branch -D main",
		"git branch new-branch",
		"git tag v1",
		"git fetch",
		"git push",
		"git stash",
		"git reflog expire --all",
		"git remote add x y",
		"git config user.name x",
		"git -c core.pager=x log",
		"git -C src log",
		"git --no-pager log",
		"git log --format=%G?",
		"git log --pretty=myalias",
		"git ls-remote origin",
		"git diff /etc/hosts",
	])
		refused(cmd);
});

test("write-capable flags and commands still go to the classifier", () => {
	for (const cmd of [
		"find . -exec cat {} \\;",
		"find . -delete",
		"find . -fprint out",
		"find *.ts",
		"sed -i 's/a/b/' a.txt",
		"sed 's/a/b/' a.txt",
		"cat a.txt | sed 's/a/b/w out'",
		"sed -n '1e date' a.txt",
		"sort -o out a.txt",
		"tree -o out",
		"date 0101",
		"ps e",
		"xargs rm",
		"rg --pre cat foo",
		"grep 'end$' a.txt",
		"echo x > f",
		"ls >> f",
		"ls 2> err",
		"FOO=bar ls",
		"LANG=./x ls",
		"npm test",
		"env",
		"awk '{print}' a.txt",
		"cat ~root/x",
		"[ -f a.txt ]",
	])
		refused(cmd);
});

test("paths must resolve inside the working directory", () => {
	for (const cmd of ["cat /etc/hosts", "ls ~", "cat ../x", "grep foo /etc/passwd", "ls /", "cat src/../../x", "cat < /etc/hosts", "ls /etc/*"]) refused(cmd);
	allowed(`cat ${path.join(repo, "a.txt")}`);
	// Claude Code follows such a path segment by segment for symlinks; here it is refused.
	refused("ls src/../src");
});

test("cd: one directory change, inside the working directory, and not before git", () => {
	allowed("cd src && ls");
	allowed("cd ./src && cat ../a.txt", repo);
	allowed(`cd ${repo} && git log -1`);
	allowed(`cd ${repo} && git status | head`);
	allowed("cd . && git status");
	refused("cd /tmp && ls", "outside the working directory");
	refused("cd", "outside the working directory");
	refused("cd - && ls", "cd -");
	refused("cd src && cd .. && ls", "several cd");
	refused("cd src && git status", "cd then git");
	refused("cd src | git status", "cd then git");
	refused("cd src; cat ../../x", "outside the working directory");
	refused("cd src; cat < a.txt", "input redirect after cd");
});

test("git is refused where the repository could have been planted", () => {
	assert.equal(gitDirTrusted(repo), true);
	assert.equal(gitDirTrusted(worktree), false, "a .git file pointing outside a .git directory");
	refused("git status", "git repository not trusted", worktree);
	allowed("ls", worktree);
});
