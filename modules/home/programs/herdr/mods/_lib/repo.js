// Git worktree conventions, detected rather than assumed, for the nix-* mods.
// Every function takes `git(cwd, args) -> { ok, out, err }`, so `node --test`
// runs it against real repos; nix joins this file into each mod's main.js
// (Herdr refuses imports that resolve outside a mod's folder).

export const HERDR_ROOT = (home) => `${home}/.herdr/worktrees`;
export const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const parentDir = (p) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
export const baseName = (p) => p.replace(/\/+$/, "").split("/").pop();

// Every checkout git knows (`git worktree list`), bare entries and missing folders left out.
export async function worktrees(git, dir) {
  const list = await git(dir, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return [];
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch });
  }
  return out;
}

// The repo a folder belongs to, null outside git:
//   top     the checkout the folder is in (null at a bare clone's container)
//   main    where repo-wide git commands run: the main checkout, or the bare git dir
//   name    the repo's name ("pnpm", not ".bare" or "main")
//   root    the folder new worktrees go in
//   layout  "sibling" (bare clone with worktrees beside it), "existing" (where its
//           worktrees already are), or "herdr" (~/.herdr/worktrees/<name>)
//   bare, linked (the folder is a linked worktree, not the main checkout)
export async function repoOf(git, folder, home) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.out.replace(/\/+$/, "");
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const bare = (await git(folder, ["--git-dir", dir, "rev-parse", "--is-bare-repository"])).out === "true";
  // A hidden bare dir (`repo/.bare`) is named after its container; `repo.git` after itself.
  const hidden = baseName(dir).startsWith(".");
  const main = bare ? dir : dir.endsWith("/.git") ? dir.slice(0, -5) : dir;
  const name = bare ? (hidden ? baseName(parentDir(dir)) : baseName(dir).replace(/\.git$/, "")) : baseName(main);
  const linked = top.ok ? top.out !== main : false;
  let root, layout;
  if (bare && hidden) {
    root = parentDir(dir);
    layout = "sibling";
  } else {
    // Wherever most of its worktrees already live, else Herdr's own place.
    const counts = {};
    for (const w of await worktrees(git, main)) if (w.path !== main) counts[parentDir(w.path)] = (counts[parentDir(w.path)] ?? 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    root = best ?? `${HERDR_ROOT(home)}/${name}`;
    layout = best ? "existing" : "herdr";
  }
  return { top: top.ok ? top.out : null, main, name, root, layout, bare, linked };
}

// The branch new work starts from: origin's HEAD, else the bare repo's HEAD,
// else main or master. null in a repo without commits.
export async function defaultBranch(git, main) {
  const origin = await git(main, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (origin.ok && origin.out) return origin.out.replace(/^origin\//, "");
  const head = await git(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  for (const b of [head.ok ? head.out : null, "main", "master"]) {
    if (b && (await git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`])).ok) return b;
  }
  return null;
}

const has = async (git, dir, ref) => (await git(dir, ["show-ref", "--verify", "--quiet", ref])).ok;

// A worktree for `branch` in the repo's root, as `git wt` makes one: a branch
// on origin is checked out tracking it (a stale local copy fast-forwarded), a
// local one reused, and a new one started from origin's default branch (fresher
// than the local copy a bare clone keeps), without tracking it.
export async function createWorktree(git, repo, branch) {
  const path = `${repo.root}/${slug(branch)}`;
  const run = (args) => git(repo.main, args);
  // Asks origin about this one branch: cheap, and finds a branch pushed since the last fetch.
  await run(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remote = await has(git, repo.main, `refs/remotes/origin/${branch}`);
  const local = await has(git, repo.main, `refs/heads/${branch}`);
  let add, how;
  if (remote && local) { add = ["worktree", "add", path, branch]; how = `tracks origin/${branch}`; }
  else if (remote) { add = ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]; how = `tracks origin/${branch}`; }
  else if (local) { add = ["worktree", "add", path, branch]; how = "existing local branch"; }
  else if (!(await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).ok && !(await defaultBranch(git, repo.main))) {
    add = ["worktree", "add", "--orphan", "-b", branch, path]; how = "first branch of an empty repo";
  } else {
    const def = await defaultBranch(git, repo.main);
    const base = def && (await has(git, repo.main, `refs/remotes/origin/${def}`)) ? `origin/${def}` : def ?? "HEAD";
    add = ["worktree", "add", "--no-track", "-b", branch, path, base]; how = `new branch from ${base}`;
  }
  const r = await run(add);
  if (!r.ok) throw new Error(r.err || "git worktree add failed");
  if (remote && local) {
    // Never discards local commits: only a fast-forward.
    await git(path, ["merge", "--ff-only", "--quiet", `origin/${branch}`]);
    await git(path, ["branch", "--set-upstream-to", `origin/${branch}`]);
  }
  return { path, how };
}

// Whether a branch's work is safely elsewhere: in the default branch, or its
// upstream deleted after a merge (squash merges never become ancestors).
export async function branchMerged(git, main, branch) {
  const def = await defaultBranch(git, main);
  if (!def || branch === def) return false;
  for (const target of [`refs/remotes/origin/${def}`, `refs/heads/${def}`]) {
    if ((await has(git, main, target)) && (await git(main, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, target])).ok) return true;
  }
  const track = await git(main, ["for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`]);
  return track.ok && track.out.includes("[gone]");
}

// Remove a worktree, then its branch if asked, then prune stale records.
export async function removeWorktree(git, repo, path, { branch = null, deleteBranch = false, force = false } = {}) {
  const r = await git(repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  if (!r.ok) throw new Error(r.err || "git worktree remove failed");
  let deleted = false;
  if (deleteBranch && branch && branch !== (await defaultBranch(git, repo.main))) {
    const merged = await branchMerged(git, repo.main, branch);
    deleted = (await git(repo.main, ["branch", merged ? "-d" : "-D", branch])).ok
      || (await git(repo.main, ["branch", "-D", branch])).ok;
  }
  await git(repo.main, ["worktree", "prune"]);
  return { deleted };
}

// Branches on origin without a checkout, most recently committed first.
export async function remoteOnly(git, main, taken, limit = 60) {
  const r = await git(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)", "refs/remotes/origin"]);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.out.split("\n")) {
    const [ref, at] = line.split("\t");
    const branch = ref?.replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || ref === "origin" || taken.has(branch)) continue;
    out.push({ branch, at: Number(at) || 0, remote: true });
    if (out.length >= limit) break;
  }
  return out;
}
