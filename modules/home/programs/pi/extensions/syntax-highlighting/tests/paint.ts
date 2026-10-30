// A Paint that writes real escapes, one 256-color index per token, and a
// reader that turns them back into `[token:text]` for readable assertions.
import { stripAnsi } from "../ansi.ts";
import type { Paint, Token } from "../highlight.ts";

const TOKENS: Token[] = [
	"toolTitle",
	"toolOutput",
	"text",
	"muted",
	"dim",
	"accent",
	"success",
	"warning",
	"error",
	"bashMode",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
];

const open = (token: Token) => `\x1b[38;5;${100 + TOKENS.indexOf(token)}m`;

/** Embedded code comes back with each line's first word as a `syntaxKeyword`, tagged with its language. */
export function fakePaint(languages: Record<string, boolean> = {}): Paint & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fg: (token, text) => `${open(token)}${text}\x1b[39m`,
		open,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		code: (code, language) => {
			if (languages[language] === false) return undefined;
			calls.push(`${language}:${code}`);
			return code.split("\n").map((line) => line.replace(/^(\s*)(\S+)/, (_, space, word) => `${space}${open("syntaxKeyword")}${word}\x1b[39m`));
		},
		languageForPath: (path) => ({ py: "python", ts: "typescript", js: "javascript" })[path.split(".").pop() ?? ""],
	};
}

const short = (token: Token) => token.replace(/^syntax/, "").replace(/^tool/, "").replace(/^./, (c) => c.toLowerCase());

/** `line`'s text in `[token:text]` runs; uncolored text as is. */
export function markup(line: string): string {
	let token: Token | undefined;
	let out = "";
	let run = "";
	const flush = () => {
		if (run) out += token ? `[${short(token)}:${run}]` : run;
		run = "";
	};
	for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
		const color = /^\x1b\[38;5;(\d+)m$/.exec(part);
		if (color) {
			flush();
			token = TOKENS[Number(color[1]) - 100];
		} else if (part === "\x1b[39m" || part === "\x1b[0m") {
			flush();
			token = undefined;
		} else if (!part.startsWith("\x1b[")) run += part;
	}
	flush();
	return out;
}

export { stripAnsi };
