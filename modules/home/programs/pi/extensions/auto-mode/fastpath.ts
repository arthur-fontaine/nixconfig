// Calls that never reach the classifier (SPEC.md §1): the safe allowlist, tools that ask the
// user themselves, and what Claude Code's acceptEdits mode or its Bash read-only check
// (readonly.ts) would allow.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readOnlyRefusal } from "./readonly.ts";

export type FastPath = { kind: "allow"; why: "allowlist" | "acceptEdits" | "readOnly" } | { kind: "interactive" };

// Pi's counterparts of Claude Code's safe allowlist (Read, Grep, Glob, ToolSearch, …).
const ALLOWLIST = new Set(["read", "grep", "find", "ls", "tool_search"]);
// Tools that put their own question to the user, as AskUserQuestion does.
const INTERACTIVE = new Set(["ask_user_question"]);

const PROTECTED_DIRS = new Set([".git", ".vscode", ".idea", ".claude", ".pi"]);
const PROTECTED_FILES = new Set(
	".gitconfig .gitmodules .bashrc .bash_profile .zshrc .zprofile .profile .zshenv .zlogin .zlogout .bash_login .bash_aliases .bash_logout .envrc .ripgreprc .mcp.json .claude.json .npmrc .yarnrc .yarnrc.yml .pnp.cjs .pnp.loader.mjs .pnpmfile.cjs bunfig.toml .bunfig.toml .bazelrc .bazelversion .bazeliskrc .pre-commit-config.yaml lefthook.yml .lefthook.yml lefthook.yaml .lefthook.yaml gradle-wrapper.properties maven-wrapper.properties .devcontainer.json pyrightconfig.json".split(
		" ",
	),
);

// Symlinks are followed through the deepest part of the path that exists.
function real(p: string): string {
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

export function resolveIn(cwd: string, target: string): string {
	const expanded = target === "~" ? os.homedir() : target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	return real(path.resolve(cwd, expanded));
}

// A path acceptEdits may write: inside the working directory and not a protected file.
export function editable(cwd: string, target: string): boolean {
	const root = real(path.resolve(cwd));
	const file = resolveIn(cwd, target);
	const rel = path.relative(root, file);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	const parts = rel.split(path.sep);
	if (parts.some((p) => PROTECTED_DIRS.has(p.toLowerCase()))) return false;
	return !PROTECTED_FILES.has(parts.at(-1)!.toLowerCase());
}

type Token = { word: string } | { op: string };

// A small shell lexer: words with quotes and escapes, and control operators. Anything it
// cannot judge statically (expansions, substitutions, subshells, heredocs) returns null.
export function lex(command: string): Token[] | null {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const flush = () => {
		if (inWord) tokens.push({ word });
		word = "";
		inWord = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return null;
			word += command.slice(i + 1, end);
			inWord = true;
			i = end;
		} else if (c === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				const d = command[j]!;
				if (d === "$" || d === "`") return null;
				if (d === "\\" && j + 1 < command.length) word += command[++j];
				else word += d;
			}
			if (j >= command.length) return null;
			inWord = true;
			i = j;
		} else if (c === "\\") {
			if (i + 1 >= command.length) return null;
			if (command[i + 1] !== "\n") word += command[i + 1];
			inWord = true;
			i++;
		} else if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
			return null;
		} else if (c === " " || c === "\t") {
			flush();
		} else if (c === "\n" || c === ";") {
			flush();
			tokens.push({ op: ";" });
		} else if (c === "&" || c === "|") {
			flush();
			if (command[i + 1] === c) {
				tokens.push({ op: c + c });
				i++;
			} else tokens.push({ op: c });
		} else if (c === "<" || c === ">") {
			if (c === "<" && command[i + 1] === "<") return null;
			const fd = inWord && /^\d$/.test(word) ? word : "";
			if (fd) {
				word = "";
				inWord = false;
			} else flush();
			let op = fd + c;
			if (command[i + 1] === ">" && c === ">") op += command[++i];
			if (command[i + 1] === "&") {
				op += "&";
				i++;
			}
			tokens.push({ op });
		} else {
			word += c;
			inWord = true;
		}
	}
	flush();
	return tokens;
}

export interface Simple {
	argv: string[];
	redirects: { op: string; target: string }[];
}

export function split(command: string): Simple[] | null {
	const tokens = lex(command);
	if (!tokens) return null;
	const commands: Simple[] = [];
	let current: Simple = { argv: [], redirects: [] };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if ("word" in t) {
			current.argv.push(t.word);
		} else if (/^[;&|]+$/.test(t.op)) {
			if (current.argv.length) commands.push(current);
			current = { argv: [], redirects: [] };
		} else {
			const next = tokens[i + 1];
			if (!next || !("word" in next)) return null;
			current.redirects.push({ op: t.op, target: next.word });
			i++;
		}
	}
	if (current.argv.length) commands.push(current);
	return commands;
}

// Claude Code's acceptEdits Bash commands, each target inside the working directory.
const FILE_COMMANDS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"]);
// A plain s/// script: no w, e or r commands that could reach other files or run commands.
const PLAIN_SED = /^s([^\\\n\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gIip0-9]*$/;

function fileCommandAllowed(cmd: Simple, cwd: string): boolean {
	const [name, ...args] = cmd.argv;
	if (!name || !FILE_COMMANDS.has(name)) return false;
	if (cmd.redirects.length) return false;
	let operands = args.filter((a) => !a.startsWith("-"));
	// A glob's matches are unknown until it runs; the classifier judges those.
	if (operands.some((a) => /[*?[]/.test(a))) return false;
	if (name === "sed") {
		if (args.some((a) => a.startsWith("-") && !/^-(?:[nEri]+|i\.\w+|-in-place|-regexp-extended|-quiet)$/.test(a))) return false;
		const [script, ...files] = operands;
		if (!script || !PLAIN_SED.test(script)) return false;
		operands = files;
	}
	if (operands.length === 0) return name !== "rm" && name !== "rmdir" && name !== "sed";
	return operands.every((p) => editable(cwd, p));
}

export function bashFastPath(command: string, cwd: string): "acceptEdits" | "readOnly" | undefined {
	if (readOnlyRefusal(command, cwd) === null) return "readOnly";
	const commands = split(command);
	if (!commands || commands.length === 0) return undefined;
	if (commands.every((c) => fileCommandAllowed(c, cwd))) return "acceptEdits";
	return undefined;
}

export function fastPath(tool: string, input: Record<string, unknown>, cwd: string): FastPath | undefined {
	if (ALLOWLIST.has(tool)) return { kind: "allow", why: "allowlist" };
	if (INTERACTIVE.has(tool)) return { kind: "interactive" };
	if ((tool === "edit" || tool === "write") && typeof input.path === "string") {
		return editable(cwd, input.path) ? { kind: "allow", why: "acceptEdits" } : undefined;
	}
	if (tool === "bash" && typeof input.command === "string") {
		const why = bashFastPath(input.command, cwd);
		return why ? { kind: "allow", why } : undefined;
	}
	return undefined;
}
