// How a Bash command is shown: without the `cd` into the directory Pi already
// runs in, and folded to a few lines.
import path from "node:path";

const CD = /^cd\s+(?:"([^"$`\\]*)"|'([^']*)'|([^\s;&|<>()$`'"\\~]+))\s*&&\s*/;

const shellWord = (word: string) => (/^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * `command` with a leading `cd <dir> && ` dropped when it goes to `cwd`, and
 * shortened to a relative path when it goes below it. Other `cd`s stay.
 */
export function displayedCommand(command: string, cwd: string): string {
	const match = CD.exec(command);
	if (!match) return command;
	const target = path.resolve(cwd, match[1] ?? match[2] ?? match[3]!);
	const relative = path.relative(cwd, target);
	const rest = command.slice(match[0].length);
	if (relative === "") return displayedCommand(rest, cwd);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return command;
	return `cd ${shellWord(relative)} && ${displayedCommand(rest, target)}`;
}

/** Commands as Pi's renderers draw them: no carriage returns, tabs as three spaces. */
export function normalizeCommand(command: string): string {
	return command.replace(/\r/g, "").replace(/\t/g, "   ");
}

export type Preview = number | "all";

export function readPreview(value: unknown, fallback: Preview): Preview {
	if (value === "all") return "all";
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The first lines of a command to show, and how many are left out. */
export function fold(lines: readonly string[], limit: Preview): { shown: string[]; hidden: number } {
	const shown = limit === "all" ? [...lines] : lines.slice(0, limit);
	return { shown, hidden: lines.length - shown.length };
}
