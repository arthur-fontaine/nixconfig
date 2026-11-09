// When a run changed code and ran nothing afterwards that could show it working, the
// agent is sent back once before it settles. No Pi imports, so tests run without
// node_modules.

// Commands that only look: running them after an edit shows nothing about whether
// the change works. Anything else (a build, a test, the program itself, a deploy, a
// request) counts as a check; this errs toward not nagging.
const LOOKING = new Set([
	"cat", "ls", "rg", "grep", "head", "tail", "wc", "find", "fd", "echo", "printf", "pwd",
	"cd", "sed", "awk", "sort", "uniq", "cut", "tr", "jq", "which", "file", "stat", "du",
	"df", "tree", "diff", "less", "true", "sleep", "mkdir", "touch", "cp", "mv", "rm",
]);
// git subcommands that don't run the code either.
const GIT_LOOKING = new Set([
	"status", "diff", "log", "show", "add", "commit", "branch", "stash", "restore", "checkout",
	"switch", "rev-parse", "ls-files", "blame", "grep", "worktree", "reset", "rm", "mv", "tag",
]);

function firstWords(segment: string): string[] {
	return segment
		.trim()
		.replace(/^(\w+=\S*\s+)+/, "")
		.split(/\s+/)
		.filter(Boolean);
}

/** True when every part of a shell command only reads or moves files around. */
export function onlyLooks(command: string): boolean {
	// Heredoc bodies are data, not commands.
	const code = command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, "");
	const segments = code.split(/&&|\|\||;|\||\n/).filter((segment) => segment.trim());
	return segments.every((segment) => {
		const [word, sub] = firstWords(segment);
		if (!word || word.startsWith("#")) return true;
		if (word === "git") return sub !== undefined && GIT_LOOKING.has(sub);
		return LOOKING.has(word);
	});
}

/** One run's record: the last step that changed code, and the last that could check it. */
export class Gate {
	private step = 0;
	private lastChange: number | undefined;
	private lastCheck: number | undefined;
	private files: string[] = [];
	private reminded = false;

	/** A tool call ended; `changed` lists the code files it changed, if any. */
	record(toolName: string, command: string | undefined, changed: string[] | undefined) {
		this.step++;
		if (changed?.length) {
			this.lastChange = this.step;
			this.files = [...new Set([...this.files, ...changed])];
		}
		if (toolName === "bash" && command !== undefined && !onlyLooks(command)) this.lastCheck = this.step;
	}

	/** The files to name in a reminder, once per run, when nothing ran after the last change. */
	reminder(): string[] | undefined {
		if (this.reminded || this.lastChange === undefined) return undefined;
		if (this.lastCheck !== undefined && this.lastCheck >= this.lastChange) return undefined;
		this.reminded = true;
		return this.files;
	}
}

export function reminderText(files: string[]): string {
	const shown = files.slice(0, 8).join(", ") + (files.length > 8 ? `, and ${files.length - 8} more` : "");
	return [
		`You changed code in this run (${shown}) and ran nothing afterwards that shows it working.`,
		"Before you finish, either run the check that shows it working where it really runs (the run-and-verify skill has the recipes),",
		"or say plainly in your reply what is not verified and why. If it needs no check, say so in one line.",
	].join(" ");
}
