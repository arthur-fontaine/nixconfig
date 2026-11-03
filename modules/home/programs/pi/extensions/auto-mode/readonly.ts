// Claude Code 2.1.317's Bash read-only check: commands it runs without a permission check
// before auto mode ever sees them. Claude Code parses with tree-sitter; the parser here only
// reads plain commands joined by `&&`, `||`, `;`, `|` and newlines, and refuses (sends to the
// classifier) anything it cannot see through.
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	BARE_ONLY,
	COMMAND_ALLOWLIST,
	type CommandConfig,
	EXACT_COMMANDS,
	FIND_ACTIONS,
	FIND_BAD_OPTION,
	FIND_NEWER,
	FIND_TAKES_NEXT,
	FIND_VALUED,
	GLOB_COMMANDS,
	PATH_LIKE,
	READONLY_COMMANDS,
	READONLY_PATTERNS,
	SAFE_ENV,
	XARGS_TARGETS,
	dockerHostFlag,
	isFlag,
	sedReadOnly,
	tildeLike,
	userTilde,
} from "./readonly-tables.ts";

export interface Word {
	value: string;
	raw: string;
	glob: boolean;
	brace: boolean;
}

export interface Redirect {
	op: string;
	target: string;
}

export interface Command {
	argv: string[];
	words: Word[];
	env: { name: string; value: string }[];
	redirects: Redirect[];
	text: string;
}

export type Join = "&&" | "||" | ";" | "|";

export interface Script {
	commands: Command[];
	joins: Join[];
}

const MAX_LENGTH = 10_000;

// Plain commands only: `$`, backticks, subshells, groups, heredocs, process substitution and
// background jobs make it return null.
export function parse(source: string): Script | null {
	if (source.length > MAX_LENGTH) return null;
	const commands: Command[] = [];
	const joins: Join[] = [];
	let current: Command = { argv: [], words: [], env: [], redirects: [], text: "" };
	let word: Word | null = null;
	let pendingRedirect: string | null = null;
	const raws: string[] = [];

	const flush = (): boolean => {
		if (!word) return true;
		const w = word;
		word = null;
		if (w.brace && w.raw !== "{}") return false;
		if (pendingRedirect) {
			current.redirects.push({ op: pendingRedirect, target: w.value });
			pendingRedirect = null;
			return true;
		}
		const assignment = current.words.length === 0 ? /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(w.raw) : null;
		if (assignment) current.env.push({ name: assignment[1]!, value: w.value.slice(w.value.indexOf("=") + 1) });
		else {
			current.words.push(w);
			current.argv.push(w.value);
		}
		raws.push(w.raw);
		return true;
	};
	const end = (join: Join | null, newline = false): boolean => {
		if (!flush() || pendingRedirect) return false;
		if (current.words.length === 0) {
			// A bare assignment changes the shell for what follows.
			if (current.env.length || current.redirects.length) return false;
			if (newline) return true;
			if (join !== null) return false;
			if (joins.length === commands.length) {
				if (joins.at(-1) !== ";") return false;
				joins.pop();
			}
			return commands.length > 0;
		}
		if (current.words[0]!.raw === "!") return false;
		current.text = raws.join(" ");
		raws.length = 0;
		commands.push(current);
		if (join) joins.push(join);
		current = { argv: [], words: [], env: [], redirects: [], text: "" };
		return true;
	};
	const extend = (value: string, raw: string, glob = false) => {
		word ??= { value: "", raw: "", glob: false, brace: false };
		word.value += value;
		word.raw += raw;
		word.glob ||= glob;
	};

	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (c === "'") {
			const close = source.indexOf("'", i + 1);
			if (close === -1) return null;
			extend(source.slice(i + 1, close), source.slice(i, close + 1));
			i = close;
		} else if (c === '"') {
			let value = "";
			let j = i + 1;
			for (; j < source.length && source[j] !== '"'; j++) {
				const d = source[j]!;
				if (d === "$" || d === "`") return null;
				if (d === "\\" && j + 1 < source.length && '$`"\\\n'.includes(source[j + 1]!)) {
					if (source[j + 1] !== "\n") value += source[j + 1];
					j++;
				} else value += d;
			}
			if (j >= source.length) return null;
			extend(value, source.slice(i, j + 1));
			i = j;
		} else if (c === "\\") {
			if (i + 1 >= source.length) return null;
			if (source[i + 1] !== "\n") extend(source[i + 1]!, source.slice(i, i + 2));
			i++;
		} else if (c === "$" || c === "`" || c === "(" || c === ")") {
			return null;
		} else if (c === "#" && !word) {
			while (i + 1 < source.length && source[i + 1] !== "\n") i++;
		} else if (c === " " || c === "\t") {
			if (!flush()) return null;
		} else if (c === "\n" || c === ";") {
			if (c === ";" && source[i + 1] === ";") return null;
			if (!end(";", c === "\n")) return null;
		} else if (c === "&") {
			if (source[i + 1] === "&") {
				if (!end("&&")) return null;
				i++;
			} else if (source[i + 1] === ">") {
				if (!flush() || pendingRedirect) return null;
				i += 2;
				pendingRedirect = source[i] === ">" ? "&>>" : "&>";
				if (pendingRedirect === "&>") i--;
			} else return null;
		} else if (c === "|") {
			if (source[i + 1] === "|") {
				if (!end("||")) return null;
				i++;
			} else if (source[i + 1] === "&") return null;
			else if (!end("|")) return null;
		} else if (c === "<" || c === ">") {
			const next = source[i + 1];
			if (next === "(" || (c === "<" && (next === "<" || next === ">"))) return null;
			// `2>`: a word of digits right before the operator is its file descriptor.
			if (word && /^\d+$/.test(word.raw)) word = null;
			else if (!flush()) return null;
			if (pendingRedirect) return null;
			let op: string = c;
			if (c === ">" && (next === ">" || next === "|")) op += source[++i];
			if (source[i + 1] === "&") {
				op += "&";
				i++;
			}
			pendingRedirect = op;
		} else {
			const glob = c === "*" || c === "?" || c === "[";
			extend(c, c, glob);
			if (c === "{" || c === "}") word!.brace = true;
		}
	}
	if (!end(null)) return null;
	return { commands, joins };
}

// `command`, `builtin` and `noglob` only change how the name is looked up.
function unwrap(argv: string[]): string[] {
	let a = argv;
	for (;;) {
		if (a[0] === "command") {
			let i = 1;
			while (a[i] !== undefined && /^-p+$/.test(a[i]!)) i++;
			if (a[i] === "--") i++;
			if (i >= a.length || a[i]!.startsWith("-")) return a;
			a = a.slice(i);
		} else if (a[0] === "builtin") {
			const i = a[1] === "--" ? 2 : 1;
			if (i >= a.length) return a;
			a = a.slice(i);
		} else if (a[0] === "noglob") {
			if (a.length <= 1) return a;
			a = a.slice(1);
		} else return a;
	}
}

function unwrapText(text: string): string {
	const prefix = /^(?:(?:command(?:[ \t]+-p+)*|builtin)(?:[ \t]+--)?|noglob)[ \t]+(?!-)/;
	let t = text;
	while (prefix.test(t)) t = t.replace(prefix, "");
	return t;
}

const valueMatches = (value: string, type: string) =>
	type === "number" ? /^\d+$/.test(value) : type === "string" ? true : type === "char" ? value.length === 1 : type === "{}" ? value === "{}" : type === "EOF" ? value === "EOF" : false;

// Every flag must be in the command's safe list, with a value of the right type when it takes one.
function flagsAllowed(argv: string[], start: number, config: CommandConfig, xargsTargets?: string[]): boolean {
	const name = argv[0];
	for (let i = start; i < argv.length; ) {
		let a = argv[i]!;
		if (!a) {
			i++;
			continue;
		}
		if (xargsTargets && (!a.startsWith("-") || a === "--")) {
			if (a === "--" && i + 1 < argv.length) a = argv[++i]!;
			if (xargsTargets.includes(a)) break;
			return false;
		}
		if (a === "--") {
			if (config.respectsDoubleDash !== false) break;
			i++;
			continue;
		}
		if (!(a.startsWith("-") && a.length > 1)) {
			i++;
			continue;
		}
		const attached = a.includes("=");
		const [flag, ...rest] = a.split("=");
		const inline = rest.join("=");
		if (!flag) return false;
		const type = config.safeFlags[flag];
		if (!type) {
			if (name === "git" && /^-\d+$/.test(flag)) {
				i++;
				continue;
			}
			if ((name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") && !flag.startsWith("--") && flag.length > 2) {
				const short = config.safeFlags[flag.slice(0, 2)];
				if (short && /^\d+$/.test(flag.slice(2)) && (short === "number" || short === "string")) {
					i++;
					continue;
				}
			}
			if (!flag.startsWith("--") && flag.length > 2) {
				if (![...flag.slice(1)].every((ch) => config.safeFlags[`-${ch}`] === "none")) return false;
				i++;
				continue;
			}
			return false;
		}
		if (type === "none") {
			if (attached) return false;
			i++;
			continue;
		}
		let value: string;
		if (attached) {
			value = inline;
			i++;
		} else {
			if (i + 1 >= argv.length || (argv[i + 1] && isFlag(argv[i + 1]!))) return false;
			value = argv[i + 1] || "";
			i += 2;
		}
		if (type === "string" && value.startsWith("-") && !(flag === "--sort" && name === "git" && /^-[a-zA-Z]/.test(value))) return false;
		if (!valueMatches(value, type)) return false;
	}
	return true;
}

function allowlisted(text: string, argv: string[]): boolean {
	if (argv.length === 0) return false;
	let config: CommandConfig | undefined;
	let start = 0;
	for (const [key, c] of Object.entries(COMMAND_ALLOWLIST)) {
		const words = key.split(" ");
		if (argv.length >= words.length && words.every((w, i) => argv[i] === w)) {
			config = c;
			start = words.length;
			break;
		}
	}
	if (!config) return false;
	if (argv[0] === "git" && argv[1] === "ls-remote") {
		if (argv.some((a) => a === "-o" || a === "--server-option" || a.startsWith("--server-option="))) return false;
		let dashdash = false;
		for (const a of argv.slice(2)) {
			if (!a) continue;
			if (!dashdash && a === "--") {
				dashdash = true;
				continue;
			}
			if (dashdash || a === "-" || !a.startsWith("-")) return false;
		}
	}
	for (const a of argv.slice(start)) {
		if (a.includes("$")) return false;
		if (a.includes("{") && (a.includes(",") || a.includes(".."))) return false;
	}
	if (!flagsAllowed(argv, start, config, argv[0] === "xargs" ? XARGS_TARGETS : undefined)) return false;
	if (config.regex && !config.regex.test(text)) return false;
	if (!config.regex && /`/.test(text)) return false;
	if (!config.regex && ["rg", "grep", "egrep", "fgrep"].includes(argv[0]!) && /[\n\r]/.test(text)) return false;
	return !config.isDangerous?.(text, argv.slice(start));
}

const NUMBER = /^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/;

// Claude Code's argv-level verdicts; null means "decide from the text".
function argvVerdict(argv: string[]): boolean | null {
	const [name] = argv;
	if (name === undefined) return false;
	if (BARE_ONLY.has(name)) return argv.length === 1;
	if (EXACT_COMMANDS.some((e) => e.length === argv.length && e.every((w, i) => argv[i] === w))) return true;
	if (READONLY_COMMANDS.includes(name)) return true;
	for (const multi of READONLY_COMMANDS.filter((c) => c.includes(" "))) {
		const words = multi.split(" ");
		if (argv.length >= words.length && words.every((w, i) => argv[i] === w)) {
			return !(words[0] === "docker" && (dockerHostFlag(argv) || tildeLike(argv.slice(words.length))));
		}
	}
	if (name === "echo" || name === "ls") return true;
	if (name === "printf") {
		if (argv[1]?.startsWith("-") && argv[1] !== "--") return false;
		const at = argv[1] === "--" ? 2 : 1;
		const format = argv[at] ?? "";
		if (format.includes("$")) return false;
		const f = format.replace(/%%/g, "");
		// %b-style escapes and \u can write arbitrary bytes; numeric conversions evaluate their argument.
		if (/%[^%a-zA-Z]*[lLhqjzZt]*\\[0-7xX]/.test(f) || /\\[uU]/.test(f)) return false;
		if (/%[-+ 0#']*[0-9.*]*[lLhqjzZt]*[diouxXeEfFgGaAn]/.test(f) || /%[^%a-zA-Z]*\*/.test(f))
			for (const a of argv.slice(at + 1)) if (a.includes("[") || a.includes("`") || a.includes("$(") || !NUMBER.test(a)) return false;
		return true;
	}
	if (name === "cd") return argv.length <= 2;
	if (name === "find") {
		let takesNext = false;
		for (let i = 1; i < argv.length; i++) {
			const a = argv[i]!;
			const skip = takesNext;
			takesNext = false;
			if (FIND_ACTIONS.has(a)) return false;
			if (FIND_BAD_OPTION.test(a)) return false;
			if (!skip && FIND_TAKES_NEXT.test(a)) {
				takesNext = true;
				continue;
			}
			if (!skip && (FIND_VALUED.has(a) || FIND_NEWER.test(a) || FIND_TAKES_NEXT.test(a))) i++;
		}
		return true;
	}
	if (name === "history") return argv.length === 1 || (argv.length === 2 && /^\d+$/.test(argv[1]!));
	if (name === "arch") return argv.length === 1 || (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help"));
	if (name === "ifconfig") return argv.length === 1 || (argv.length === 2 && /^[a-zA-Z]/.test(argv[1]!));
	return null;
}

function textVerdict(text: string, argv: string[]): boolean {
	let t = text.trim();
	if (t.endsWith(" 2>&1")) t = t.slice(0, -5).trim();
	if (allowlisted(t, argv)) return true;
	for (const pattern of READONLY_PATTERNS) {
		if (!pattern.test(t)) continue;
		if (t.startsWith("find") && /-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b/.test(t.replace(/['"\\]/g, ""))) return false;
		if (t.includes("git") && (/\s-c[\s=]/.test(t) || /\s--exec-path[\s=]/.test(t) || /\s--config-env[\s=]/.test(t))) return false;
		return true;
	}
	return false;
}

const INPUT_OPS = new Set(["<", "<&"]);

export type Refusal = string;

// One simple command, as Claude Code's per-command read-only check sees it.
export function commandReadOnly(cmd: Command): Refusal | null {
	for (const r of cmd.redirects) {
		if (/^\/dev\/(tcp|udp)\//.test(r.target)) return "network redirect";
		if (INPUT_OPS.has(r.op) || r.target === "/dev/null" || (r.op === ">&" && /^\d+$/.test(r.target))) continue;
		return "output redirect";
	}
	if (cmd.env.some((e) => !SAFE_ENV.has(e.name) || PATH_LIKE.test(e.value))) return "environment prefix";
	if (cmd.argv.slice(1).some(userTilde) || cmd.redirects.some((r) => r.op === "<" && userTilde(r.target))) return "~user path";
	const argv = unwrap(cmd.argv);
	if (cmd.words.some((w) => w.glob)) return GLOB_COMMANDS.has(argv[0] ?? "") ? null : "glob";
	const verdict = argvVerdict(argv);
	if (verdict !== null) return verdict ? null : "not read-only";
	return textVerdict(unwrapText(cmd.text), argv) ? null : "not read-only";
}

const home = () => os.homedir();

function realish(p: string): string {
	const missing: string[] = [];
	let at = p;
	for (;;) {
		try {
			return path.join(realpathSync(at), ...missing.reverse());
		} catch {
			const parent = path.dirname(at);
			if (parent === at) return p;
			missing.push(path.basename(at));
			at = parent;
		}
	}
}

const expandHome = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? path.join(home(), p.slice(2)) : p);

const inside = (root: string, p: string) => {
	const rel = path.relative(root, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// `..` after a named segment can climb back out through a symlink.
const climbsAfterName = (p: string) => {
	let named = false;
	for (const s of p.split("/")) {
		if (s === "" || s === ".") continue;
		if (s === "..") {
			if (named) return true;
		} else named = true;
	}
	return false;
};

// Claude Code's read check: the path resolves inside the working directory.
export function readable(root: string, base: string, target: string): boolean {
	if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return false;
	if (target.includes("$") || target.includes("`") || target.startsWith("=")) return false;
	let p = expandHome(target);
	if (climbsAfterName(p)) return false;
	const glob = p.search(/[*?[]/);
	if (glob !== -1) {
		const cut = p.lastIndexOf("/", glob);
		p = cut === -1 ? "." : p.slice(0, cut) || "/";
	}
	return inside(root, realish(path.resolve(base, p)));
}

// gm: operands, counting everything after the first one.
function operands(args: string[]): string[] {
	const out: string[] = [];
	let dashdash = false;
	let started = false;
	for (const a of args) {
		if (dashdash || started) out.push(a);
		else if (a === "--") dashdash = true;
		else if (a === "-" || !a.startsWith("-")) {
			out.push(a);
			started = true;
		}
	}
	return out;
}

interface FlagShape {
	booleanShort: string;
	valuedShort: string;
	attachedShort?: string;
	booleanLong: string[];
	valuedLong: string[];
	attachedLong?: string[];
}

function shaped(shape: FlagShape): (args: string[]) => string[] {
	const kind = (a: string) => {
		if (a.startsWith("--")) {
			if (a.includes("=")) return "attached";
			if (shape.booleanLong.includes(a)) return "boolean";
			if (shape.attachedLong?.includes(a)) return "attached";
			return shape.valuedLong.includes(a) ? "valued" : "unknown";
		}
		if (/^-\d+$/.test(a)) return "attached";
		for (let i = 1; i < a.length; i++) {
			const ch = a[i]!;
			if (shape.booleanShort.includes(ch)) continue;
			if (shape.attachedShort?.includes(ch)) return "attached";
			if (!shape.valuedShort.includes(ch)) return "unknown";
			return i === a.length - 1 ? "valued" : "attached";
		}
		return "boolean";
	};
	return (args) => {
		const out: string[] = [];
		let dashdash = false;
		let started = false;
		let known = true;
		for (let i = 0; i < args.length; i++) {
			const a = args[i]!;
			if (dashdash || started) out.push(a);
			else if (a === "--") dashdash = true;
			else if (a !== "-" && a.startsWith("-")) {
				if (!known) continue;
				const k = kind(a);
				if (k === "valued") i++;
				else if (k === "unknown") known = false;
			} else {
				out.push(a);
				started = true;
			}
		}
		return out;
	};
}

const attachedValue = (a: string, flags: string[]) => {
	if (!a.startsWith("-")) return undefined;
	const eq = a.indexOf("=");
	if (eq >= 0) return flags.includes(a.slice(0, eq)) ? a.slice(eq + 1) : undefined;
	for (const f of flags) if (f.length === 2 && f[0] === "-" && a.startsWith(f) && a !== f) return a.slice(2);
	return undefined;
};

// grep/rg: the first operand is the pattern unless -e/-f gave one; pattern files are read too.
function patternOperands(args: string[], valued: Set<string>, fallback: string[] = []): string[] {
	const out: string[] = [];
	let havePattern = false;
	let dashdash = false;
	let started = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!dashdash && !started && a === "--") {
			dashdash = true;
			continue;
		}
		if (!dashdash && !started && a !== "-" && a.startsWith("-")) {
			const eq = a.indexOf("=");
			const flag = eq >= 0 ? a.slice(0, eq) : a;
			if (["-e", "--regexp", "-f", "--file"].includes(flag)) {
				havePattern = true;
				if (flag === "-f" || flag === "--file") {
					const file = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
					if (file) out.push(file);
				}
			}
			if (/^-[a-zA-Z]*f$/.test(flag) && flag !== "-f" && eq < 0 && args[i + 1] !== undefined) {
				havePattern = true;
				out.push(args[++i]!);
				continue;
			}
			if (["--exclude-from", "--include-from", "--ignore-file"].includes(flag)) {
				const file = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
				if (file) out.push(file);
				if (eq < 0) i++;
				continue;
			}
			if (eq < 0) {
				const file = attachedValue(a, ["-f", "--file"]);
				if (file !== undefined) {
					havePattern = true;
					out.push(file);
					continue;
				}
				if (a.length > 2 && a.startsWith("-e")) {
					havePattern = true;
					continue;
				}
			}
			if (valued.has(flag) && eq < 0) i++;
			continue;
		}
		if (started && !dashdash) {
			const file = attachedValue(a, ["-f", "--file"]);
			if (file !== undefined) out.push(file);
		}
		started = true;
		if (!havePattern) {
			havePattern = true;
			continue;
		}
		out.push(a);
	}
	return out.length > 0 ? out : fallback;
}

const GREP_VALUED = new Set(["-e", "--regexp", "-f", "--file", "--exclude", "--include", "--exclude-dir", "--include-dir", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context"]);
const RG_VALUED = new Set(["-e", "--regexp", "-f", "--file", "-t", "--type", "-T", "--type-not", "-g", "--glob", "-m", "--max-count", "--max-depth", "-r", "--replace", "-A", "--after-context", "-B", "--before-context", "-C", "--context"]);
const GIT_GREP_VALUED = new Set(["-e", "--regexp", "-f", "--file", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-m", "--max-count", "--max-depth", "--threads"]);
const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--shallow-file"]);
const DEVICE = (p: string) => ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"].includes(p) || /^\/dev\/fd\/\d+$/.test(p) || /^\/proc\/self\/fd\/[0-2]$/.test(p);

function grepPaths(args: string[]): string[] {
	const out = patternOperands(args, GREP_VALUED);
	return out.length === 0 && args.some((a) => a === "-r" || a === "-R" || a === "--recursive") ? ["."] : out;
}

const findPaths = (args: string[]) => {
	const out: string[] = [];
	const valued = new Set(["-newer", "-anewer", "-cnewer", "-mnewer", "-samefile", "-path", "-wholename", "-ilname", "-lname", "-ipath", "-iwholename"]);
	let predicates = false;
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a) continue;
		if (dashdash) {
			out.push(a);
			continue;
		}
		if (a === "--") {
			dashdash = true;
			continue;
		}
		if (a.startsWith("-")) {
			if (["-H", "-L", "-P"].includes(a)) continue;
			predicates = true;
			if (valued.has(a) || /^-newer[acmBt][acmtB]$/.test(a)) {
				const next = args[i + 1];
				if (next) {
					out.push(next);
					i++;
				}
			}
			continue;
		}
		if (!predicates) out.push(a);
	}
	return out.length > 0 ? out : ["."];
};

function sedPaths(args: string[]): string[] {
	const out: string[] = [];
	let skip = false;
	let haveScript = false;
	let dashdash = false;
	let started = false;
	for (let i = 0; i < args.length; i++) {
		if (skip) {
			skip = false;
			continue;
		}
		const a = args[i]!;
		if (!a) continue;
		if (!dashdash && !started && a === "--") {
			dashdash = true;
			continue;
		}
		if (!dashdash && !started && a !== "-" && a.startsWith("-")) {
			if (a === "-f" || a === "--file") {
				const file = args[i + 1];
				if (file) out.push(file);
				skip = true;
				haveScript = true;
			} else if (a === "-e" || a === "--expression") {
				skip = true;
				haveScript = true;
			} else if (a.includes("e") || a.includes("f")) haveScript = true;
			continue;
		}
		started = true;
		if (!haveScript) {
			haveScript = true;
			continue;
		}
		out.push(a);
	}
	return out;
}

function jqPaths(args: string[]): string[] {
	const out: string[] = [];
	const valued = new Set(["-e", "--expression", "--arg", "--argjson", "--args", "--jsonargs", "-L", "--library-path", "--indent", "--tab"]);
	let haveFilter = false;
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!dashdash && a === "--") {
			dashdash = true;
			continue;
		}
		if (!dashdash && a.startsWith("-")) {
			const eq = a.indexOf("=");
			const flag = eq >= 0 ? a.slice(0, eq) : a;
			if (flag === "-e" || flag === "--expression") haveFilter = true;
			if (flag === "-f" || flag === "--from-file") {
				haveFilter = true;
				if (eq >= 0) out.push(a.slice(eq + 1));
				else if (args[i + 1] !== undefined) out.push(args[++i]!);
				continue;
			}
			if (flag === "--slurpfile" || flag === "--rawfile") {
				if (args[i + 2] !== undefined) out.push(args[i + 2]!);
				i += 2;
				continue;
			}
			if (valued.has(flag) && eq < 0) i++;
			continue;
		}
		if (!haveFilter) {
			haveFilter = true;
			continue;
		}
		out.push(a);
	}
	return out;
}

function gitPaths(args: string[]): string[] {
	let i = 0;
	let dir = "";
	while (i < args.length && args[i]!.startsWith("-")) {
		const opt = args[i++]!;
		if (GIT_GLOBAL_VALUED.has(opt) && i < args.length) {
			const value = args[i++]!;
			if (opt === "-C" || opt === "--work-tree") dir = path.isAbsolute(expandHome(value)) || value.startsWith("~") ? value : dir ? `${dir.replace(/\/+$/, "")}/${value}` : value;
		} else if (opt.startsWith("--work-tree=")) dir = opt.slice(12);
	}
	const under = (p: string) => (dir === "" || path.isAbsolute(expandHome(p)) || p.startsWith("~") ? p : `${dir.replace(/\/+$/, "")}/${p}`);
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (sub === "grep") {
		const found = patternOperands(rest, GIT_GREP_VALUED);
		return found.length > 0 ? found.map(under) : [dir === "" ? "." : dir];
	}
	if (sub !== "diff") return [];
	const out: string[] = [];
	let dashdash = false;
	for (const a of rest) {
		if (!dashdash && a === "--") dashdash = true;
		else if (dashdash || a === "-" || !a.startsWith("-")) {
			const p = under(a);
			if (!DEVICE(p)) out.push(p);
		}
	}
	return out;
}

function manPaths(args: string[]): string[] {
	const local = args.some((a) => a === "--local-file" || (/^-[^-]/.test(a) && a.includes("l")));
	return args.flatMap((a, i) => {
		if (i > 0 && (args[i - 1] === "-C" || args[i - 1] === "--config-file")) return [a];
		const slash = a.search(/[\\/~]/);
		const parts = !a.startsWith("-")
			? [a]
			: [...new Set([...(a.includes("=") ? [a.slice(a.indexOf("=") + 1)] : []), ...(a.length > 2 && !a.startsWith("--") ? [a.slice(2)] : []), ...(slash > 0 ? [a.slice(slash)] : [])])];
		return parts.filter((p) => p !== "" && (local || /[\\/]/.test(p) || p.startsWith("~") || p.startsWith(".")));
	});
}

// The read commands whose path operands Claude Code checks against the working directories.
const PATHS: Record<string, (args: string[]) => string[]> = {
	cd: (args) => {
		const ops = operands(args);
		if (ops.length === 0) return args.at(-1) === "-" ? ["-"] : ["~"];
		return [ops[0]!];
	},
	ls: (args) => {
		const ops = operands(args);
		return ops.length > 0 ? ops : ["."];
	},
	find: findPaths,
	...Object.fromEntries("cat head tail sort uniq wc file stat diff strings hexdump od base64 nl sha256sum sha1sum md5sum rev tsort".split(" ").map((c) => [c, operands])),
	cut: shaped({ booleanShort: "nswz", valuedShort: "bcdf", booleanLong: ["--complement", "--only-delimited", "--zero-terminated"], valuedLong: ["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"] }),
	paste: shaped({ booleanShort: "sz", valuedShort: "d", booleanLong: ["--serial", "--zero-terminated"], valuedLong: ["--delimiters"] }),
	column: shaped({
		booleanShort: "txdemLJhV",
		valuedShort: "cosNOClEHRTWrip",
		booleanLong: ["--table", "--fillrows", "--table-noheadings", "--table-header-repeat", "--table-maxout", "--keep-empty-lines", "--json"],
		valuedLong: "--separator --output-separator --output-width --table-name --table-order --table-column --table-columns --table-columns-limit --table-noextreme --table-hide --table-right --table-truncate --table-wrap --tree --tree-id --tree-parent".split(" "),
	}),
	tr: (args) => {
		const deletes = args.some((a) => a === "-d" || a === "--delete" || (a.startsWith("-") && a.includes("d")));
		return operands(args).slice(deletes ? 1 : 2);
	},
	grep: grepPaths,
	egrep: grepPaths,
	fgrep: grepPaths,
	tac: shaped({ booleanShort: "br", valuedShort: "s", booleanLong: ["--before", "--regex"], valuedLong: ["--separator"] }),
	fold: shaped({ booleanShort: "bs", valuedShort: "w", booleanLong: ["--bytes", "--spaces"], valuedLong: ["--width"] }),
	expand: shaped({ booleanShort: "i", valuedShort: "t", booleanLong: ["--initial"], valuedLong: ["--tabs"] }),
	unexpand: shaped({ booleanShort: "af", valuedShort: "t", booleanLong: ["--all", "--first-only"], valuedLong: ["--tabs"] }),
	fmt: shaped({ booleanShort: "csumn", valuedShort: "wgdl", booleanLong: ["--crown-margin", "--split-only", "--tagged-paragraph", "--uniform-spacing"], valuedLong: ["--width", "--goal", "--prefix"] }),
	comm: shaped({ booleanShort: "123iz", valuedShort: "", booleanLong: ["--check-order", "--nocheck-order", "--total", "--zero-terminated"], valuedLong: ["--output-delimiter"] }),
	cmp: shaped({ booleanShort: "blsvxzh", valuedShort: "", booleanLong: ["--print-bytes", "--verbose", "--quiet", "--silent"], valuedLong: ["--ignore-initial", "--bytes"] }),
	pr: shaped({
		booleanShort: "acdFfJmprtTv",
		attachedShort: "einsS",
		valuedShort: "hlwWoND",
		booleanLong: "--across --show-control-chars --double-space --form-feed --join-lines --merge --no-file-warnings --omit-header --omit-pagination --show-nonprinting".split(" "),
		attachedLong: ["--expand-tabs", "--output-tabs", "--number-lines", "--separator", "--sep-string"],
		valuedLong: ["--header", "--length", "--width", "--page-width", "--indent", "--first-line-number", "--date-format", "--columns"],
	}),
	numfmt: shaped({
		booleanShort: "z",
		valuedShort: "d",
		booleanLong: ["--grouping", "--zero-terminated", "--debug"],
		attachedLong: ["--header"],
		valuedLong: ["--from", "--to", "--from-unit", "--to-unit", "--format", "--padding", "--delimiter", "--field", "--round", "--suffix", "--invalid"],
	}),
	man: manPaths,
	rg: (args) => patternOperands(args, RG_VALUED, ["."]),
	sed: sedPaths,
	jq: jqPaths,
	git: gitPaths,
};

const isCd = (argv: string[]) => ["cd", "pushd", "popd", "chdir"].includes(argv[0] ?? "");
const isGit = (cmd: Command) => cmd.text.startsWith("git ") || cmd.text === "git" || cmd.argv[0] === "git" || (cmd.argv[0] === "xargs" && cmd.argv.includes("git"));

// The paths a read-only command names, checked as Claude Code's path validation does.
function pathsReadable(cmd: Command, root: string, bases: string[], afterCd: boolean): Refusal | null {
	const argv = unwrap(cmd.argv);
	const name = argv[0] ?? "";
	for (const r of cmd.redirects) {
		if (r.op === "<&" ? /^\d+$|^-$/.test(r.target) : r.op !== "<" || DEVICE(r.target)) continue;
		if (/[*?[]/.test(r.target) || (afterCd && !path.isAbsolute(r.target) && !r.target.startsWith("~"))) return "input redirect after cd";
		if (!bases.every((b) => readable(root, b, r.target))) return "outside the working directory";
	}
	const extract = PATHS[name];
	if (!extract) return null;
	if (name === "sed" && !sedReadOnly(argv)) return "not read-only";
	const args = argv.slice(1);
	if (name === "cd" && operands(args).length > 1) return "cd with two operands";
	// The previous directory is unknown here.
	if (name === "cd" && args.at(-1) === "-") return "cd -";
	return extract(args).every((p) => bases.every((b) => readable(root, b, p))) ? null : "outside the working directory";
}

const sameDir = (a: string, b: string) => {
	try {
		const x = statSync(a);
		const y = statSync(b);
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
};

// `cd` targets Claude Code trusts before a git command: the working directory itself.
function cdKeepsRepo(target: string, cwd: string): boolean {
	if (target.startsWith("-")) return false;
	const explicit = path.isAbsolute(target) || target.startsWith("./") || target.startsWith("../") || target === "." || target === "..";
	if (!explicit || /[$`*?[\\]/.test(target)) return false;
	let named = false;
	for (const s of target.split("/")) {
		if (s === "" || s === ".") continue;
		if (s === "..") {
			if (!path.isAbsolute(target) || named) return false;
		} else named = true;
	}
	return sameDir(path.resolve(cwd, target), cwd);
}

const HEAD = /^ref:[ \t]*refs\/|^[0-9a-f]{40}([0-9a-f]{24})?[ \t\n\r]*$/;
const headValid = (dir: string) => {
	try {
		const st = lstatSync(path.join(dir, "HEAD"));
		return st.isFile() && st.size <= 4096 && HEAD.test(readFileSync(path.join(dir, "HEAD"), "utf8").slice(0, 255));
	} catch {
		return false;
	}
};

// Claude Code refuses git in a directory whose repository could have been planted: a .git file
// or symlink pointing outside a `.git` directory (as in a bare-repo + worktree layout), or bare
// repository files lying around.
export function gitDirTrusted(cwd: string): boolean {
	const root = realish(cwd);
	const dotGit = (dir: string): "trusted" | "plantable" | "none" => {
		const target = (raw: string) => {
			let t: string;
			try {
				t = realpathSync(path.resolve(dir, raw));
			} catch {
				return "plantable";
			}
			if (inside(root, t)) return "plantable";
			if (!t.split(path.sep).some((s) => s.toLowerCase() === ".git")) return "plantable";
			return headValid(t) ? "trusted" : "none";
		};
		try {
			const st = lstatSync(path.join(dir, ".git"));
			if (st.isSymbolicLink()) return target(readlinkSync(path.join(dir, ".git")));
			if (st.isFile()) {
				if (st.size > 65536) return "plantable";
				const content = readFileSync(path.join(dir, ".git"), "utf8");
				if (content.includes("\0")) return "plantable";
				if (!content.startsWith("gitdir: ")) return "none";
				return target(content.slice(8).replace(/[\r\n]+$/, ""));
			}
			if (st.isDirectory()) {
				const g = path.join(dir, ".git");
				if (!headValid(g)) return "none";
				for (const d of ["objects", "refs"]) if (!statSync(path.join(g, d)).isDirectory()) return "none";
				try {
					statSync(path.join(g, "commondir"));
					return "none";
				} catch {
					return "trusted";
				}
			}
		} catch {}
		return "none";
	};
	const bareIndicators = (dir: string) => {
		try {
			const st = lstatSync(path.join(dir, "HEAD"));
			if (st.isFile() || st.isSymbolicLink()) return true;
		} catch {}
		for (const d of ["objects", "refs"]) {
			try {
				statSync(path.join(dir, d));
				return true;
			} catch {}
		}
		return false;
	};
	const here = dotGit(root);
	if (here !== "none") return here === "trusted";
	for (let dir = root; ; ) {
		if (bareIndicators(dir)) return false;
		const parent = path.dirname(dir);
		if (parent === dir) return true;
		const up = dotGit(parent);
		if (up !== "none") return up === "trusted";
		dir = parent;
	}
}

const cdTarget = (cmd: Command) => (cmd.argv.length === 2 && cmd.env.length === 0 && cmd.redirects.length === 0 ? cmd.argv[1]! : undefined);

// One pipe segment, as Claude Code checks a command without pipes. `cdBefore` holds the
// directories earlier segments may have moved to.
function segmentReadOnly(source: string, commands: Command[], joins: Join[], cwd: string, root: string, cdBefore: string[]): Refusal | null {
	// `cd <working directory>` changes nothing and is dropped.
	const plainCwd = !/[\s\\$`'"*?[\]{}<>|&;()]/.test(cwd);
	const kept = commands.filter((c) => !(plainCwd && c.text === `cd ${cwd}` && cdTarget(c) !== undefined && !c.words.some((w) => w.glob)));
	const cds = kept.filter((c) => isCd(unwrap(c.argv)));
	if (cds.length > 1) return "several cd";
	if (cds.length === 1 && kept.some(isGit)) {
		const target = cdTarget(cds[0]!);
		if (target === undefined || cds[0]!.argv[0] !== "cd" || !cdKeepsRepo(target, cwd)) return "cd then git";
	}
	// A leading `cd DIR &&` with a checkable DIR moves where later relative paths resolve.
	const first = kept[0]!;
	let leading: string | undefined;
	if (
		kept.length > 1 &&
		kept.length === commands.length &&
		first.argv[0] === "cd" &&
		joins[0] === "&&" &&
		!source.includes("||") &&
		!source.includes(";") &&
		!source.includes("\n") &&
		!source.replaceAll("&&", "").includes("&")
	) {
		const target = cdTarget(first);
		if (
			target !== undefined &&
			!target.startsWith("-") &&
			(path.isAbsolute(target) || target.startsWith("./") || target.startsWith("../") || target === "." || target === "..") &&
			(path.isAbsolute(target) || !target.split("/").includes("..")) &&
			!/[*?[\]]/.test(target) &&
			readable(root, cwd, target)
		)
			leading = realish(path.resolve(cwd, target));
	}
	// Claude Code resolves paths after any other cd against the working directory; checking them
	// against the cd target as well keeps a relative path from slipping out through it.
	const moved = [...cdBefore];
	for (const cmd of kept) {
		const bases = leading !== undefined && cmd !== first ? [leading] : [cwd, ...moved];
		const refusal = commandReadOnly(cmd) ?? pathsReadable(cmd, root, bases, leading === undefined && (cds.length > 0 || cdBefore.length > 0));
		if (refusal) return refusal;
		const target = isCd(cmd.argv) ? cdTarget(cmd) : undefined;
		if (target !== undefined) moved.push(realish(path.resolve(cwd, expandHome(target))));
	}
	if (leading !== undefined) cdBefore.push(leading);
	else cdBefore.push(...moved.slice(cdBefore.length));
	return null;
}

// The whole command, or why it still goes to the classifier.
export function readOnlyRefusal(source: string, cwd: string): Refusal | null {
	const script = parse(source);
	if (!script) return "unparsed";
	const root = realish(path.resolve(cwd));
	const segments: { commands: Command[]; joins: Join[] }[] = [{ commands: [script.commands[0]!], joins: [] }];
	script.joins.forEach((j, i) => {
		const next = script.commands[i + 1]!;
		if (j === "|") segments.push({ commands: [next], joins: [] });
		else {
			segments.at(-1)!.joins.push(j);
			segments.at(-1)!.commands.push(next);
		}
	});
	if (script.commands.some(isGit) && !gitDirTrusted(cwd)) return "git repository not trusted";
	if (segments.length > 1) {
		if (segments.filter((s) => isCd(unwrap(s.commands[0]!.argv))).length > 1) return "several cd";
		const cds = script.commands.filter((c) => isCd(unwrap(c.argv)));
		if (cds.length > 0 && script.commands.some(isGit)) {
			if (cds.length > 1) return "several cd";
			const target = cdTarget(cds[0]!);
			if (target === undefined || cds[0]!.argv[0] !== "cd" || !cdKeepsRepo(target, cwd)) return "cd then git";
		}
	}
	const cdBefore: string[] = [];
	for (const s of segments) {
		const refusal = segmentReadOnly(source, s.commands, s.joins, cwd, root, cdBefore);
		if (refusal) return refusal;
	}
	return null;
}
