import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { branchMerged, createWorktree, defaultBranch, removeWorktree, remoteOnly, repoOf, worktrees } from "../repo.js";

// Never the person's ~/.gitconfig: a fixed identity, no signing, no hooks.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const git = async (cwd, args) => {
  const r = spawnSync("git", args, { cwd, env: ENV });
  return { ok: r.status === 0, out: (r.stdout ?? "").toString().trim(), err: (r.stderr ?? "").toString().trim() };
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-test-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

// origin with main and a pushed `feature`; a bare clone laid out as `git bclone` does.
function setup(name) {
  const base = join(tmp, name);
  sh(tmp, "init", "-q", "--bare", "-b", "main", `${base}-origin.git`);
  sh(tmp, "clone", "-q", `${base}-origin.git`, `${base}-seed`);
  sh(`${base}-seed`, "commit", "-q", "--allow-empty", "-m", "init");
  sh(`${base}-seed`, "push", "-q", "origin", "main");
  sh(`${base}-seed`, "switch", "-q", "-c", "feature");
  sh(`${base}-seed`, "commit", "-q", "--allow-empty", "-m", "feature work");
  sh(`${base}-seed`, "push", "-q", "origin", "feature");
  const repo = join(base, "repo");
  execFileSync("mkdir", ["-p", repo]);
  sh(repo, "clone", "-q", "--bare", `${base}-origin.git`, ".bare");
  writeFileSync(join(repo, ".git"), "gitdir: ./.bare\n");
  sh(repo, "--git-dir=.bare", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  sh(repo, "--git-dir=.bare", "fetch", "-q", "origin");
  sh(repo, "--git-dir=.bare", "remote", "set-head", "origin", "main");
  sh(join(repo, ".bare"), "worktree", "add", "-q", join(repo, "main"), "main");
  return { base, repo, seed: `${base}-seed` };
}

test("a bare clone is named after its folder and gets sibling worktrees", async () => {
  const { repo } = setup("bare");
  for (const at of [repo, join(repo, "main")]) {
    const r = await repoOf(git, at, "/home/x");
    assert.equal(r.name, "repo", at);
    assert.equal(r.layout, "sibling");
    assert.equal(r.root, repo);
    assert.equal(r.main, join(repo, ".bare"));
    assert.equal(r.bare, true);
  }
  assert.equal((await repoOf(git, join(repo, "main"), "/home/x")).linked, true);
  assert.equal(await defaultBranch(git, join(repo, ".bare")), "main");
});

test("createWorktree tracks a branch on origin and starts new ones from origin's default", async () => {
  const { repo, seed } = setup("create");
  const r = await repoOf(git, join(repo, "main"), "/home/x");
  const a = await createWorktree(git, r, "feature");
  assert.equal(a.path, join(repo, "feature"));
  assert.match(a.how, /tracks origin\/feature/);
  assert.equal(sh(a.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature");
  // origin moves on after our fetch: a new branch still starts from its tip.
  sh(seed, "switch", "-q", "main");
  sh(seed, "commit", "-q", "--allow-empty", "-m", "newer main");
  sh(seed, "push", "-q", "origin", "main");
  sh(r.main, "fetch", "-q", "origin");
  const b = await createWorktree(git, r, "fix/thing");
  assert.equal(b.path, join(repo, "fix-thing"));
  assert.match(b.how, /new branch from origin\/main/);
  assert.equal(sh(b.path, "log", "-1", "--format=%s"), "newer main");
  assert.equal(spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: b.path, env: ENV }).status !== 0, true);
  const all = await worktrees(git, r.main);
  assert.deepEqual(all.map((w) => w.branch).sort(), ["feature", "fix/thing", "main"]);
});

test("removeWorktree deletes a merged branch and prunes; an unmerged one only when forced", async () => {
  const { repo } = setup("remove");
  const r = await repoOf(git, join(repo, "main"), "/home/x");
  const w = await createWorktree(git, r, "done-work");
  assert.equal(await branchMerged(git, r.main, "done-work"), true); // no commits of its own
  assert.deepEqual(await removeWorktree(git, r, w.path, { branch: "done-work", deleteBranch: true }), { deleted: true });
  assert.equal(existsSync(w.path), false);
  assert.equal((await git(r.main, ["show-ref", "--verify", "--quiet", "refs/heads/done-work"])).ok, false);
  const u = await createWorktree(git, r, "wip");
  sh(u.path, "commit", "-q", "--allow-empty", "-m", "unmerged");
  assert.equal(await branchMerged(git, r.main, "wip"), false);
  await removeWorktree(git, r, u.path, { branch: "wip", deleteBranch: false });
  assert.equal((await git(r.main, ["show-ref", "--verify", "--quiet", "refs/heads/wip"])).ok, true);
});

test("a plain clone keeps Herdr's place until it has worktrees of its own", async () => {
  const { base } = setup("plain");
  const clone = join(base, "plain-clone");
  sh(tmp, "clone", "-q", `${base}-origin.git`, clone);
  const r = await repoOf(git, clone, "/home/x");
  assert.equal(r.name, "plain-clone");
  assert.equal(r.layout, "herdr");
  assert.equal(r.root, "/home/x/.herdr/worktrees/plain-clone");
  assert.equal(r.linked, false);
  sh(clone, "worktree", "add", "-q", join(base, "elsewhere", "x"), "-b", "x");
  const again = await repoOf(git, clone, "/home/x");
  assert.equal(again.layout, "existing");
  assert.equal(again.root, join(base, "elsewhere"));
});

test("outside git there is no repo", async () => {
  assert.equal(await repoOf(git, tmp, "/home/x"), null);
});

test("remoteOnly lists origin branches without a checkout", async () => {
  const { repo } = setup("remote");
  const r = await repoOf(git, join(repo, "main"), "/home/x");
  const list = await remoteOnly(git, r.main, new Set(["main"]));
  assert.deepEqual(list.map((b) => b.branch), ["feature"]);
});
