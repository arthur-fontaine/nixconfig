// The {"meta":{"gitStatus":…}} line Claude Code puts above a command that can destroy
// uncommitted work, so the classifier knows whether there is any (SPEC.md §2).
const DESTROYS_WORK = [
	/\bgit\s+(?:-\S+\s+)*reset\b[^;&|\n]*\s--hard\b/,
	/\bgit\s+(?:-\S+\s+)*checkout\s+(?:--\s+)?\.(?=\s|$|[;&|])/,
	/\bgit\s+(?:-\S+\s+)*restore\s+(?:\S+\s+)*\.(?=\s|$|[;&|])/,
	/\bgit\s+(?:-\S+\s+)*clean\b[^;&|\n]*\s-(?:\w*f|-force)/,
	/\brm\s+(?:\S+\s+)*?-(?:\w*[rRf]\w*|-recursive|-force)\b/,
];

export function destroysWork(command: string): boolean {
	const head = command.length > 10_000 ? command.slice(0, 10_000) : command;
	return DESTROYS_WORK.some((re) => re.test(head));
}

export type GitStatus = { clean: true } | { staged: number; modified: number; untracked: number };

export function parsePorcelain(porcelain: string): GitStatus {
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	for (const row of porcelain.split("\n")) {
		if (row.length < 2) continue;
		const [x, y] = [row[0], row[1]];
		if (x === "?" && y === "?") {
			untracked++;
			continue;
		}
		if (x !== " " && x !== "?") staged++;
		if (y !== " ") modified++;
	}
	return staged + modified + untracked === 0 ? { clean: true } : { staged, modified, untracked };
}
