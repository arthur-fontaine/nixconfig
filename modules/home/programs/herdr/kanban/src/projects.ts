// The repos Herdr knows, as the nix-sidebar names them: a space's folder → its git
// common dir → a key `JSON [machine, common]`, a name and the repo's own folder.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { run } from "./run.ts";
import type { Project } from "./types.ts";

// As nix-sidebar's repoName / repoPath / distinctNames (keep them in step): a common dir
// `repo/.git` or `repo/.bare` (a dot folder) is named after its parent, `repo.git` after itself.
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
export function repoPath(common: string): string[] {
  const dir = common.replace(/\/+$/, "");
  const root = base(dir).startsWith(".") ? dir.slice(0, dir.lastIndexOf("/")) : dir.replace(/\.git$/, "");
  return root.split("/").filter(Boolean);
}
export function repoName(common: string): string {
  const p = repoPath(common);
  return p[p.length - 1] ?? "repo";
}

export function projectOf(common: string): Project {
  return { key: JSON.stringify([null, common]), name: repoName(common), root: "/" + repoPath(common).join("/") };
}

/** Names unique among the projects: a shared name takes parent folders (application/monorepo). */
export function distinct(projects: Project[]): Project[] {
  const paths = projects.map((p) => repoPath(JSON.parse(p.key)[1]));
  const depth = projects.map(() => 1);
  const name = (i: number) => paths[i].slice(-depth[i]).join("/");
  for (let changed = true; changed;) {
    changed = false;
    const seen = new Map<string, number[]>();
    projects.forEach((_, i) => seen.set(name(i), [...(seen.get(name(i)) ?? []), i]));
    for (const group of seen.values()) {
      if (group.length < 2) continue;
      for (const i of group) if (depth[i] < paths[i].length) { depth[i]++; changed = true; }
    }
  }
  return projects.map((p, i) => ({ ...p, name: name(i) }));
}

export async function commonDir(folder: string): Promise<string | null> {
  const r = await run("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 });
  return r.code === 0 ? r.stdout.trim().replace(/\/+$/, "") : null;
}

export function herdrHome() {
  return process.env.HERDR_APP_HOME ?? `${homedir()}/.config/herdr-app`;
}

/** Repo keys the sidebar has made a project space for (shared "nix.orchestrators"). */
export async function projectSpaces(): Promise<Record<string, string>> {
  try {
    const shared = JSON.parse(await readFile(`${herdrHome()}/shared.json`, "utf8"));
    return shared["nix.orchestrators"] ?? {};
  } catch { return {}; }
}

/** This computer's repos: every local space's folder, plus the project spaces' keys. */
export async function discover(spaceFolders: string[], known: Project[]): Promise<Project[]> {
  const commons = new Set<string>();
  for (const p of known) commons.add(JSON.parse(p.key)[1]);
  for (const key of Object.keys(await projectSpaces())) {
    const [machine, common] = JSON.parse(key);
    if (machine === null && typeof common === "string") commons.add(common);
  }
  for (const f of new Set(spaceFolders.filter(Boolean))) {
    const c = await commonDir(f);
    if (c) commons.add(c);
  }
  return distinct([...commons].sort().map(projectOf));
}
