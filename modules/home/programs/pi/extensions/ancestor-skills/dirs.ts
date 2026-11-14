import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function nearestGitRoot(start: string): string | undefined {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

// Pi stops its own `.agents/skills` walk at the nearest `.git`, which in a worktree is the
// worktree itself. This returns the directories above that point, up to but excluding home.
export function skillDirsAboveGitRoot(cwd: string, home: string): string[] {
	const start = resolve(cwd);
	const gitRoot = nearestGitRoot(start);
	if (!gitRoot) return [];
	const stop = resolve(home);
	const found: string[] = [];
	for (let dir = dirname(gitRoot); dir !== stop && dirname(dir) !== dir; dir = dirname(dir)) {
		const skills = join(dir, ".agents", "skills");
		if (existsSync(skills)) found.push(skills);
	}
	return found;
}
