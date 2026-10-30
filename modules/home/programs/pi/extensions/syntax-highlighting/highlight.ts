// Colors for Bash commands and embedded code, all from Pi's theme tokens so
// they follow the active theme (light or dark) like the rest of the UI.
import { FG_RESET, stripAnsi } from "./ansi.ts";
import { lexShell, type Role } from "./shell.ts";

export type Token =
	| "toolTitle"
	| "toolOutput"
	| "text"
	| "muted"
	| "dim"
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "bashMode"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation";

/** What the theme provides; index.ts builds it from Pi's `Theme` and `highlightCode`. */
export interface Paint {
	fg(token: Token, text: string): string;
	/** The escape that starts `token`'s color. */
	open(token: Token): string;
	bold(text: string): string;
	/** `code`'s lines highlighted as `language`, or undefined for a language Pi doesn't know. */
	code(code: string, language: string): string[] | undefined;
	languageForPath(path: string): string | undefined;
}

const ROLE_TOKENS: Record<Role, Token> = {
	command: "syntaxFunction",
	keyword: "syntaxKeyword",
	option: "syntaxType",
	string: "syntaxString",
	variable: "syntaxVariable",
	operator: "syntaxOperator",
	comment: "syntaxComment",
	number: "syntaxNumber",
};

// Colors each line on its own, so any line can be shown without the others.
export function fgLines(paint: Paint, token: Token, text: string): string {
	return text
		.split("\n")
		.map((line) => (line ? paint.fg(token, line) : ""))
		.join("\n");
}

/**
 * `code` highlighted as `language`, its unhighlighted text in `base`. Falls
 * back to `fallback` when the language is unknown or the highlighter would
 * change the text.
 */
export function highlightEmbedded(paint: Paint, code: string, language: string, base: Token, fallback: Token): string {
	const lines = paint.code(code, language);
	const plain = code.split("\n");
	if (!lines || lines.length !== plain.length || lines.some((line, i) => stripAnsi(line) !== plain[i])) return fgLines(paint, fallback, code);
	const open = paint.open(base);
	return lines.map((line) => (line ? open + line.replaceAll(FG_RESET, FG_RESET + open) + FG_RESET : "")).join("\n");
}

// `bash -c '…'` holding another `python -c "…"` is as deep as it usually gets.
const MAX_DEPTH = 4;

/** `command` highlighted, one string per line. Text no rule colors is `base`. */
export function highlightShell(paint: Paint, command: string, base: Token = "toolTitle", depth = 0): string[] {
	const spans = lexShell(command, (path) => paint.languageForPath(path));
	let out = "";
	let at = 0;
	for (const span of spans) {
		if (span.start < at) continue;
		out += fgLines(paint, base, command.slice(at, span.start));
		const text = command.slice(span.start, span.end);
		if (span.language === "bash" && depth < MAX_DEPTH) out += highlightShell(paint, text, base, depth + 1).join("\n");
		else if (span.language) out += highlightEmbedded(paint, text, span.language, base, "syntaxString");
		else out += fgLines(paint, ROLE_TOKENS[span.role!], text);
		at = span.end;
	}
	out += fgLines(paint, base, command.slice(at));
	return out.split("\n");
}
