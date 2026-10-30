// A shell lexer for display: what each part of a Bash command is (command
// name, option, string, variable…) and which parts are code in another
// language (`python -c '…'`, a heredoc fed to `node`). It reads commands as
// the model writes them, including unfinished ones while they stream in; it
// is not a full POSIX parser.

export type Role = "command" | "keyword" | "option" | "string" | "variable" | "operator" | "comment" | "number";

export interface Span {
	start: number;
	end: number;
	role?: Role;
	/** Code in another language, to highlight as such. */
	language?: string;
}

interface Segment {
	start: number;
	end: number;
	kind: "plain" | "string" | "variable" | "nested";
}

interface Word {
	start: number;
	end: number;
	/** The value with quotes and escapes removed, close enough to compare names and flags. */
	text: string;
	segments: Segment[];
	/** Set when the whole word is one quoted string: where its content is. */
	content?: { start: number; end: number };
}

interface Redirect {
	op: string;
	target: string;
}

interface Command {
	/** The command name, already painted, when the command has one. */
	name?: Word;
	words: Word[];
	redirects: Redirect[];
	/** The keyword that opened a `for`/`select`/`case` header, whose `in` is a keyword too. */
	header?: string;
}

type Expect = "command" | "argument" | "variable" | "redirect" | "heredoc";

interface Heredoc {
	delimiter: string;
	strip: boolean;
	command: Command;
}

// Flags whose next argument is a program, by interpreter.
const FLAG_PROGRAMS: Record<string, { flags: string[]; language: string }> = {
	node: { flags: ["-e", "--eval", "-p", "--print"], language: "javascript" },
	deno: { flags: ["eval"], language: "typescript" },
	python: { flags: ["-c"], language: "python" },
	perl: { flags: ["-e", "-E"], language: "perl" },
	ruby: { flags: ["-e"], language: "ruby" },
	php: { flags: ["-r"], language: "php" },
	lua: { flags: ["-e"], language: "lua" },
	sh: { flags: ["-c"], language: "bash" },
	bash: { flags: ["-c"], language: "bash" },
	zsh: { flags: ["-c"], language: "bash" },
	dash: { flags: ["-c"], language: "bash" },
	psql: { flags: ["-c", "--command"], language: "sql" },
	mysql: { flags: ["-e", "--execute"], language: "sql" },
	mariadb: { flags: ["-e", "--execute"], language: "sql" },
	osascript: { flags: ["-e"], language: "applescript" },
};

// Commands whose program is a quoted argument rather than a flag's value.
const QUOTED_PROGRAMS: Record<string, { pick: "first" | "last"; language: string }> = {
	awk: { pick: "first", language: "awk" },
	gawk: { pick: "first", language: "awk" },
	mawk: { pick: "first", language: "awk" },
	nawk: { pick: "first", language: "awk" },
	sqlite3: { pick: "last", language: "sql" },
	duckdb: { pick: "last", language: "sql" },
};

// What a heredoc fed to these commands is written in.
const HEREDOC_LANGUAGES: Record<string, string> = {
	node: "javascript",
	deno: "typescript",
	bun: "javascript",
	python: "python",
	perl: "perl",
	ruby: "ruby",
	php: "php",
	lua: "lua",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	dash: "bash",
	psql: "sql",
	mysql: "sql",
	mariadb: "sql",
	sqlite3: "sql",
	duckdb: "sql",
	jq: "json",
	yq: "yaml",
	osascript: "applescript",
};

// Words that may come before the interpreter: `sudo`, `env X=1`, `uv run`, `timeout 10`.
const PREFIXES = new Set(["sudo", "doas", "env", "nohup", "exec", "command", "nice", "time", "timeout", "xargs", "uv", "uvx", "poetry", "pipenv", "pnpm", "npx", "bunx", "run"]);

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "select", "while", "until", "do", "done", "case", "esac", "in", "function", "time", "!", "{", "}", "[[", "]]", "coproc"]);
const DECLARATIONS = new Set(["export", "local", "declare", "readonly", "typeset"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const OPERATOR = /(\d*)(&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)|&&|\|\||;;&?|;&|\|&|[|;&()]/y;
const SPECIAL_VARIABLE = /[0-9@*#?$!-]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

export function interpreterName(word: string): string {
	const base = (word.split("/").pop() ?? word).toLowerCase().replace(/\.exe$/, "");
	if (/^python[0-9.]*$/.test(base)) return "python";
	if (base === "nodejs") return "node";
	return base;
}

class Lexer {
	readonly spans: Span[] = [];
	private heredocs: Heredoc[] = [];
	private readonly src: string;
	private readonly languageForPath: (path: string) => string | undefined;

	constructor(src: string, languageForPath: (path: string) => string | undefined) {
		this.src = src;
		this.languageForPath = languageForPath;
	}

	private push(start: number, end: number, role: Role) {
		if (end > start) this.spans.push({ start, end, role });
	}

	/** Lexes commands from `i` up to `close` (`)` of `$(`, a backquote) or the end; returns where it stopped. */
	commands(i: number, close?: string): number {
		const src = this.src;
		let command: Command = { words: [], redirects: [] };
		let expect = "command" as Expect;
		let pending: { op: string; strip: boolean } | undefined;
		let depth = 0;
		const next = () => {
			this.finish(command);
			command = { words: [], redirects: [] };
			expect = "command";
		};
		while (i < src.length) {
			const ch = src[i]!;
			if (ch === "\\" && src[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (ch === " " || ch === "\t" || ch === "\r") {
				i++;
				continue;
			}
			if (ch === "\n") {
				next();
				i = this.heredocBodies(i + 1);
				continue;
			}
			if (close && depth === 0 && src.startsWith(close, i)) {
				next();
				this.push(i, i + close.length, "operator");
				return i + close.length;
			}
			if (ch === "#") {
				const end = src.indexOf("\n", i);
				this.push(i, end < 0 ? src.length : end, "comment");
				i = end < 0 ? src.length : end;
				continue;
			}
			OPERATOR.lastIndex = i;
			const op: RegExpExecArray | null = expect === "redirect" || expect === "heredoc" ? null : OPERATOR.exec(src);
			if (op) {
				const end = i + op[0].length;
				this.push(i, end, "operator");
				i = end;
				if (op[2]) {
					pending = { op: op[2], strip: op[2] === "<<-" };
					expect = op[2] === "<<" || op[2] === "<<-" ? "heredoc" : "redirect";
				} else if (op[0] === "(") {
					depth++;
					next();
				} else if (op[0] === ")") {
					depth = Math.max(0, depth - 1);
					next();
				} else next();
				continue;
			}
			const word = this.word(i, close);
			if (word.end === i) {
				// A character no rule takes, such as a stray close of a `$(` at top level.
				i++;
				continue;
			}
			i = word.end;
			const resume = command.name || command.header ? "argument" : "command";
			switch (expect) {
				case "heredoc":
					this.heredocs.push({ delimiter: word.text, strip: pending?.strip ?? false, command });
					this.push(word.start, word.end, "keyword");
					expect = resume;
					break;
				case "redirect":
					command.redirects.push({ op: pending?.op ?? ">", target: word.text });
					this.paint(word);
					expect = resume;
					break;
				case "variable":
					this.push(word.start, word.end, "variable");
					expect = "argument";
					break;
				case "command":
					expect = this.commandWord(word, command);
					break;
				case "argument":
					if (word.text === "]]" && plainWord(word)) this.push(word.start, word.end, "keyword");
					else if (command.header && word.text === "in" && plainWord(word)) {
						this.push(word.start, word.end, "keyword");
						if (command.header === "case") next();
					} else command.words.push(word);
					break;
			}
		}
		this.finish(command);
		return i;
	}

	private commandWord(word: Word, command: Command): "command" | "argument" | "variable" {
		if (plainWord(word) && KEYWORDS.has(word.text)) {
			this.push(word.start, word.end, "keyword");
			if (word.text === "for" || word.text === "select") {
				command.header = word.text;
				return "variable";
			}
			if (word.text === "case") {
				command.header = word.text;
				return "argument";
			}
			// `[[ -f x ]]` holds a test, not a command.
			return word.text === "[[" ? "argument" : "command";
		}
		if (ASSIGNMENT.test(word.text) && word.segments[0]?.kind === "plain") {
			this.assignment(word);
			return "command";
		}
		command.name = word;
		command.words.push(word);
		this.paint(word, "command");
		return "argument";
	}

	private assignment(word: Word) {
		const equals = this.src.indexOf("=", word.start);
		this.push(word.start, equals, "variable");
		this.push(equals, equals + 1, "operator");
		this.paint({ ...word, segments: clip(word.segments, equals + 1) });
	}

	// Colors a word's parts; plain parts take `role` (a command name, an option).
	private paint(word: Word, role?: Role) {
		for (const segment of word.segments) {
			if (segment.kind === "string") this.push(segment.start, segment.end, "string");
			else if (segment.kind === "variable") this.push(segment.start, segment.end, "variable");
			else if (segment.kind === "plain" && role) this.push(segment.start, segment.end, role);
		}
	}

	private argument(word: Word, command: Command) {
		const first = word.segments[0];
		if (plainWord(word) && NUMBER.test(word.text)) return this.paint(word, "number");
		if (first?.kind === "plain" && this.src[first.start] === "-" && word.text.length > 1) {
			const equals = this.src.slice(first.start, first.end).indexOf("=");
			const end = equals < 0 ? first.end : first.start + equals;
			this.push(first.start, end, "option");
			return this.paint({ ...word, segments: clip(word.segments, end) });
		}
		const name = command.name && interpreterName(command.name.text);
		if (name && DECLARATIONS.has(name) && ASSIGNMENT.test(word.text) && first?.kind === "plain") return this.assignment(word);
		this.paint(word);
	}

	private finish(command: Command) {
		const words = command.words;
		if (words.length === 0) return;
		if (command.header) {
			for (const word of words) this.argument(word, command);
			return;
		}
		const embedded = new Map<Word, string>();
		const at = interpreterIndex(words);
		const name = at < 0 ? undefined : interpreterName(words[at]!.text);
		const byFlag = name ? FLAG_PROGRAMS[name] : undefined;
		if (byFlag) {
			for (let j = at + 1; j < words.length - 1; j++) {
				if (byFlag.flags.includes(words[j]!.text) && words[j + 1]!.content) embedded.set(words[j + 1]!, byFlag.language);
			}
		}
		const byQuote = name ? QUOTED_PROGRAMS[name] : undefined;
		if (byQuote) {
			const quoted = words.slice(at + 1).filter((word) => word.content);
			const word = byQuote.pick === "first" ? quoted[0] : quoted.at(-1);
			if (word) embedded.set(word, byQuote.language);
		}
		for (const word of words) {
			if (word === command.name) continue;
			const language = embedded.get(word);
			if (language && word.content) {
				this.push(word.start, word.content.start, "string");
				this.spans.push({ start: word.content.start, end: word.content.end, language });
				this.push(word.content.end, word.end, "string");
			} else this.argument(word, command);
		}
	}

	private heredocLanguage(command: Command): string | undefined {
		const words = command.words;
		const at = interpreterIndex(words);
		if (at < 0) return undefined;
		const name = interpreterName(words[at]!.text);
		if (HEREDOC_LANGUAGES[name]) return HEREDOC_LANGUAGES[name];
		// `cat > file.py <<EOF` and `tee file.py <<EOF` write a file: its extension says what it is.
		if (name === "cat") {
			const target = command.redirects.findLast((redirect) => redirect.op.endsWith(">") || redirect.op === ">>")?.target;
			return target ? this.languageForPath(target) : undefined;
		}
		if (name === "tee") {
			const target = words.slice(at + 1).find((word) => !word.text.startsWith("-"))?.text;
			return target ? this.languageForPath(target) : undefined;
		}
		return undefined;
	}

	// Heredoc bodies start on the line after their operator, in the order of the operators.
	private heredocBodies(i: number): number {
		const src = this.src;
		for (const heredoc of this.heredocs) {
			const start = i;
			let end = src.length;
			let after = src.length;
			while (i < src.length) {
				const newline = src.indexOf("\n", i);
				const lineEnd = newline < 0 ? src.length : newline;
				const line = src.slice(i, lineEnd);
				if ((heredoc.strip ? line.trimStart() : line) === heredoc.delimiter) {
					end = Math.max(start, i - 1);
					this.push(i, lineEnd, "keyword");
					after = newline < 0 ? src.length : newline + 1;
					break;
				}
				i = newline < 0 ? src.length : newline + 1;
			}
			if (end > start) {
				const language = this.heredocLanguage(heredoc.command);
				if (language) this.spans.push({ start, end, language });
				else this.push(start, end, "string");
			}
			i = after;
		}
		this.heredocs = [];
		return i;
	}

	private word(i: number, close?: string): Word {
		const src = this.src;
		const start = i;
		const segments: Segment[] = [];
		let text = "";
		// Where a quoted string that starts the word has its content, and where it ends.
		let content: Word["content"];
		let quoteEnd = -1;
		const add = (from: number, to: number, kind: Segment["kind"]) => {
			const last = segments.at(-1);
			if (kind === "plain" && last?.kind === "plain" && last.end === from) last.end = to;
			else segments.push({ start: from, end: to, kind });
		};
		while (i < src.length) {
			const ch = src[i]!;
			if (/\s/.test(ch) || /[;&|()<>]/.test(ch) || (close && src.startsWith(close, i))) break;
			const first = i === start;
			if (ch === "\\") {
				text += src[i + 1] ?? "";
				add(i, Math.min(src.length, i + 2), "plain");
				i += 2;
			} else if (ch === "'" || (ch === "$" && src[i + 1] === "'")) {
				const open = ch === "'" ? i + 1 : i + 2;
				const end = ch === "'" ? closingQuote(src, open, false) : closingQuote(src, open, true);
				const closed = src[end - 1] === "'" && end - 1 >= open;
				text += src.slice(open, closed ? end - 1 : end);
				add(i, end, "string");
				if (first && closed) [content, quoteEnd] = [{ start: open, end: end - 1 }, end];
				i = end;
			} else if (ch === '"') {
				const end = this.doubleQuoted(i, add);
				const closed = src[end - 1] === '"' && end - 1 > i;
				text += src.slice(i + 1, closed ? end - 1 : end);
				if (first && closed) [content, quoteEnd] = [{ start: i + 1, end: end - 1 }, end];
				i = end;
			} else {
				const substitution = ch === "$" || ch === "`" ? this.substitution(i) : undefined;
				const end = substitution?.end ?? i + 1;
				text += src.slice(i, end);
				add(i, end, substitution?.kind ?? "plain");
				i = end;
			}
		}
		// A quoted string followed by more (`'a'b`) is not the whole word.
		if (quoteEnd !== i) content = undefined;
		return { start, end: i, text, segments, content };
	}

	private doubleQuoted(i: number, add: (from: number, to: number, kind: Segment["kind"]) => void): number {
		const src = this.src;
		let from = i;
		i++;
		while (i < src.length && src[i] !== '"') {
			if (src[i] === "\\") {
				i += 2;
				continue;
			}
			const substitution = src[i] === "$" || src[i] === "`" ? this.substitution(i) : undefined;
			if (substitution) {
				add(from, i, "string");
				add(i, substitution.end, substitution.kind);
				from = i = substitution.end;
				continue;
			}
			i++;
		}
		const end = Math.min(src.length, i + 1);
		add(from, end, "string");
		return end;
	}

	// `$name`, `${…}`, `$((…))`, `$(…)` and backquotes. Command substitutions
	// are lexed as commands, so their spans are already pushed ("nested").
	private substitution(i: number): { end: number; kind: "variable" | "nested" } | undefined {
		const src = this.src;
		if (src[i] === "`") {
			this.push(i, i + 1, "operator");
			return { end: this.commands(i + 1, "`"), kind: "nested" };
		}
		const next = src[i + 1];
		if (next === "(" && src[i + 2] === "(") {
			const end = matching(src, i + 1, "(", ")");
			return { end: src.startsWith("))", end - 1) ? end + 1 : end, kind: "variable" };
		}
		if (next === "(") {
			this.push(i, i + 2, "operator");
			return { end: this.commands(i + 2, ")"), kind: "nested" };
		}
		if (next === "{") return { end: matching(src, i + 1, "{", "}"), kind: "variable" };
		if (next && SPECIAL_VARIABLE.test(next)) return { end: i + 2, kind: "variable" };
		let end = i + 1;
		while (end < src.length && NAME_CHAR.test(src[end]!)) end++;
		return end > i + 1 ? { end, kind: "variable" } : undefined;
	}
}

function plainWord(word: Word): boolean {
	return word.segments.length === 1 && word.segments[0]!.kind === "plain";
}

function clip(segments: Segment[], from: number): Segment[] {
	return segments.filter((s) => s.end > from).map((s) => (s.start < from ? { ...s, start: from } : s));
}

// The index after the `'` closing a string whose content starts at `i`; `$'…'` strings have escapes.
function closingQuote(src: string, i: number, escapes: boolean): number {
	while (i < src.length && src[i] !== "'") i += escapes && src[i] === "\\" ? 2 : 1;
	return Math.min(src.length, i + 1);
}

// The index after the bracket that closes the one at `open`, or the end.
function matching(src: string, open: number, left: string, right: string): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === left) depth++;
		else if (src[i] === right && --depth === 0) return i + 1;
	}
	return src.length;
}

function interpreterIndex(words: Word[]): number {
	for (const [index, word] of words.entries()) {
		const name = interpreterName(word.text);
		if (FLAG_PROGRAMS[name] || QUOTED_PROGRAMS[name] || HEREDOC_LANGUAGES[name] || name === "cat" || name === "tee") return index;
		const skippable = PREFIXES.has(name) || word.text.startsWith("-") || ASSIGNMENT.test(word.text) || /^\d+[smhd]?$/.test(word.text);
		if (!skippable) return -1;
	}
	return -1;
}

/** The colored and embedded parts of `command`, sorted; the rest is plain. */
export function lexShell(command: string, languageForPath: (path: string) => string | undefined = () => undefined): Span[] {
	const lexer = new Lexer(command, languageForPath);
	lexer.commands(0);
	return lexer.spans.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start || b.end - a.end);
}
