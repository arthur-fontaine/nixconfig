// Claude Code 2.1.317's read-only command tables, ported as data from its bundle
// (src/utils/shell/readOnlyCommandValidation.ts and src/tools/BashTool/readOnlyValidation.ts).
// Entry order matters: the first key whose words start the command wins, as in Claude Code.
// Claude Code also rejects arguments holding its parser's substitution placeholders; the
// parser here refuses substitutions outright, so those checks are left out.

export type FlagArg = "none" | "number" | "string" | "char" | "{}" | "EOF";

export interface CommandConfig {
	safeFlags: Record<string, FlagArg>;
	regex?: RegExp;
	respectsDoubleDash?: boolean;
	// Gets the command text and the arguments after the matched key.
	isDangerous?: (text: string, args: string[]) => boolean;
}

export const before = (s: string, sep: string) => {
	const i = s.indexOf(sep);
	return i === -1 ? s : s.slice(0, i);
};

export const isFlag = (s: string) => s.startsWith("-") && s.length > 1 && /^-[a-zA-Z0-9_-]/.test(s);

const anyTilde = (args: string[]) => args.some((a) => a.includes("~"));

// `~` that the shell may expand inside an argument (`--x=~/a`, `a:~`), or brace-tilde forms.
export const tildeLike = (args: string[]) => args.some((a) => /(?:^|[=:])~/.test(a) || (a.includes("~") && a.includes("{")));

// `~user`: another user's home.
export const userTilde = (arg: string) => /^~(?!\/|$)/.test(arg);

const SIGNATURE_FORMAT = /%[-+ ]?G|%\(\*?signature/;
const PRETTY_NAMES = new Set(["oneline", "short", "medium", "full", "fuller", "email", "raw"]);

// A --format/--pretty name that is not a built-in can be a pretty.<name> alias from git config.
const configPretty = (v: string) => v !== "" && !v.includes("%") && !v.startsWith("format:") && !v.startsWith("tformat:") && !PRETTY_NAMES.has(v);

// Signature placeholders run gpg; format values also reach config aliases.
function gitFormatIsDangerous(_text: string, args: string[]): boolean {
	const bad = (v: string) => tildeLike([v]) || SIGNATURE_FORMAT.test(v) || v.includes("signature");
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (SIGNATURE_FORMAT.test(a)) return true;
		for (const flag of ["--format", "--pretty", "--sort", "--group"]) {
			const v = a === flag && i + 1 < args.length ? args[i + 1] : a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : undefined;
			if (v === undefined) continue;
			if (bad(v)) return true;
			if ((flag === "--format" || flag === "--pretty") && configPretty(v)) return true;
		}
	}
	return false;
}

function reflogIsDangerous(_text: string, args: string[]): boolean {
	const sub = args[0];
	if (sub && !sub.startsWith("-") && sub !== "show" && sub !== "list") return true;
	return args.some((a) => ["expire", "delete", "exists", "drop", "write"].includes(a));
}

function lsRemoteIsDangerous(_text: string, args: string[]): boolean {
	if (gitFormatIsDangerous(_text, args)) return true;
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!dashdash && a === "--") {
			dashdash = true;
			continue;
		}
		if (!dashdash && (!a || a.startsWith("-"))) {
			if (a === "--sort") i++;
			continue;
		}
		return true;
	}
	return false;
}

function remoteShowIsDangerous(_text: string, args: string[]): boolean {
	const dd = args.indexOf("--");
	const head = dd === -1 ? args : args.slice(0, dd);
	const names = head.filter((a) => a !== "-n").concat(dd === -1 ? [] : args.slice(dd + 1));
	if (names.length !== 1 || !head.includes("-n")) return true;
	return !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(names[0]!);
}

const remoteIsDangerous = (_text: string, args: string[]) => args.some((a) => a !== "-v" && a !== "--verbose");

// A positional argument creates a tag unless listing was asked for.
function tagIsDangerous(text: string, args: string[]): boolean {
	if (gitFormatIsDangerous(text, args)) return true;
	const valued = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "-n"]);
	let listing = false;
	let dashdash = false;
	for (let i = 0; i < args.length; ) {
		const a = args[i]!;
		if (!a) {
			i++;
			continue;
		}
		if (a === "--" && !dashdash) {
			dashdash = true;
			i++;
			continue;
		}
		if (!dashdash && a.startsWith("-")) {
			if (a === "--list" || a === "-l") listing = true;
			else if (a[1] !== "-" && a.length > 2 && !a.includes("=") && a.slice(1).includes("l")) listing = true;
			i += a.includes("=") ? 1 : valued.has(a) ? 2 : 1;
		} else {
			if (!listing) return true;
			i++;
		}
	}
	return false;
}

// A positional argument creates a branch unless listing was asked for or it follows --merged.
function branchIsDangerous(text: string, args: string[]): boolean {
	if (gitFormatIsDangerous(text, args)) return true;
	const valued = new Set(["--contains", "--no-contains", "--points-at", "--sort"]);
	const optionalValue = new Set(["--merged", "--no-merged"]);
	let last = "";
	let listing = false;
	let dashdash = false;
	for (let i = 0; i < args.length; ) {
		const a = args[i]!;
		if (!a) {
			i++;
			continue;
		}
		if (a === "--" && !dashdash) {
			dashdash = true;
			last = "";
			i++;
			continue;
		}
		if (!dashdash && a.startsWith("-")) {
			if (a === "--list" || a === "-l") listing = true;
			else if (a[1] !== "-" && a.length > 2 && !a.includes("=") && a.slice(1).includes("l")) listing = true;
			if (a.includes("=")) {
				last = before(a, "=");
				i++;
			} else if (valued.has(a)) {
				last = a;
				i += 2;
			} else {
				last = a;
				i++;
			}
		} else {
			if (!listing && !optionalValue.has(last)) return true;
			i++;
		}
	}
	return false;
}

// Flags that point docker at another daemon or config.
const DOCKER_HOST_FLAGS = ["-H", "-c", "-r", "--host", "--context", "--config", "--tlscacert", "--tlscert", "--tlskey", "--url", "--connection", "--identity", "--remote", "--module", "--out"];
const DOCKER_HOST_LETTERS = new Set(DOCKER_HOST_FLAGS.filter((f) => f.length === 2).map((f) => f[1]));

export function dockerHostFlag(args: string[]): boolean {
	return args.some((a) => {
		if (DOCKER_HOST_FLAGS.some((f) => a === f || a.startsWith(`${f}=`) || (f.length === 2 && a.length > 2 && a.startsWith(f)))) return true;
		const letters = a.match(/^-([A-Za-z]+)/)?.[1];
		return letters !== undefined && letters.length >= 2 && [...letters].some((l) => DOCKER_HOST_LETTERS.has(l));
	});
}

const dockerIsDangerous = (_text: string, args: string[]) => dockerHostFlag(args) || tildeLike(args);

const sedIsDangerous = (_text: string, args: string[]) => !sedReadOnly(["sed", ...args]);

function manIsDangerous(_text: string, args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--" || a === "-" || !a.startsWith("-")) break;
		let section: string | undefined;
		if (a === "-S" || a === "-s") section = args[++i] ?? "";
		else if (a.startsWith("-S=") || a.startsWith("-s=")) section = a.slice(2);
		if (section !== undefined && !/^[A-Za-z0-9:,]+$/.test(section)) return true;
	}
	const searching = new Set(["-k", "-f", "--apropos", "--whatis"]);
	let search = false;
	for (const a of args) {
		if (a === "--") break;
		if (!a.startsWith("-") || a === "-") continue;
		if (a.startsWith("--")) {
			if (searching.has(a)) search = true;
		} else if (/[kf]/.test(a.slice(1))) search = true;
	}
	let searched = false;
	let operands = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!operands && a === "--") {
			operands = true;
			continue;
		}
		if (!(operands || !a.startsWith("-") || a === "-")) {
			if (searching.has(a)) searched = true;
			else if (a === "-S" || a === "-s") i++;
			continue;
		}
		operands = true;
		if (search && a.startsWith("-")) return true;
		if (!searched && (a.includes("/") || a.includes("\\") || a.includes("~"))) return true;
	}
	return false;
}

const helpIsDangerous = (_text: string, args: string[]) => anyTilde(args) || args.some((a) => a.includes("/") || a.includes("\\"));

// `e`/`E` print the environment; BSD ps takes them without a dash.
function psIsDangerous(_text: string, args: string[]): boolean {
	const bsdEnv = args.some((a) => !isFlag(a) && /[eE]/.test(a));
	const env = args.some((a) => /^-[a-zA-Z]*e/.test(a));
	const plain = args.every((a) => a === "--forest" || /^-[AacdeFfjlwHLTm]+$/.test(a));
	const formats = args.flatMap((a) => (a === "--forest" ? [a] : (a.match(/[HLTm]/g) ?? [])));
	return bsdEnv || (env && !(plain && formats.length <= 1));
}

// Only `+FORMAT` positionals: anything else sets the clock.
function dateIsDangerous(_text: string, args: string[]): boolean {
	const valued = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
	for (let i = 0; i < args.length; ) {
		const a = args[i]!;
		if (a.startsWith("--") && a.includes("=")) i++;
		else if (a.startsWith("-")) i += valued.has(a) ? 2 : 1;
		else {
			if (!a.startsWith("+")) return true;
			i++;
		}
	}
	return false;
}

// Host names in -i resolve through DNS.
function lsofIsDangerous(_text: string, args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("+m")) return true;
		if (/^-[a-zA-Z]*i\S*@/.test(a) && /[a-zA-Z]/.test(before(a.slice(a.indexOf("@") + 1), ":"))) return true;
		if (/^-[a-zA-Z]*i$/.test(a)) {
			const next = args[i + 1] ?? "";
			if (next.includes("~")) return true;
			if (next.includes("@") && /[a-zA-Z]/.test(before(next.slice(next.indexOf("@") + 1), ":"))) return true;
		}
	}
	return false;
}

const TPUT_WRITES = new Set(["init", "reset", "rs1", "rs2", "rs3", "is1", "is2", "is3", "iprog", "if", "rf", "clear", "flash", "mc0", "mc4", "mc5", "mc5i", "mc5p", "pfkey", "pfloc", "pfx", "pfxl", "smcup", "rmcup"]);

function tputIsDangerous(_text: string, args: string[]): boolean {
	let dashdash = false;
	for (let i = 0; i < args.length; ) {
		const a = args[i]!;
		if (a === "--") {
			dashdash = true;
			i++;
		} else if (!dashdash && a.startsWith("-")) {
			if (a === "-S" || (!a.startsWith("--") && a.length > 2 && a.includes("S"))) return true;
			i += a === "-T" ? 2 : 1;
		} else {
			if (TPUT_WRITES.has(a)) return true;
			i++;
		}
	}
	return false;
}

// Filter words are fine; names that need resolving (hosts, services) are not.
function ssIsDangerous(_text: string, args: string[]): boolean {
	const keyword = /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
	const takesName = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/;
	const valued = /^(-f|--family|-A|--query|--socket)$/;
	const filter: string[] = [];
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!dashdash && a === "--") {
			dashdash = true;
			continue;
		}
		if (!dashdash && a.startsWith("-")) {
			if (valued.test(a)) i++;
			continue;
		}
		filter.push(a);
	}
	if (anyTilde(filter)) return true;
	let skip = false;
	for (const w of filter.join(" ").split(/[\s()=!<>&|,]+/).filter(Boolean)) {
		if (skip) {
			skip = false;
			continue;
		}
		if (keyword.test(w)) {
			skip = takesName.test(w);
			continue;
		}
		if (/[g-zG-Z]/.test(w) || (/[a-fA-F]/.test(w) && (w.includes(".") || !w.includes(":")))) return true;
	}
	return false;
}

export const NUMERIC_COMPARISONS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
export const INTEGER = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;

// Arithmetic operands are evaluated by the shell, `-v`/`-R` look up variables.
function testIsDangerous(_text: string, args: string[]): boolean {
	if (args.some((a) => a === "-v" || a === "-R" || a === "-a" || a === "-o" || a.includes("["))) return true;
	for (let i = 0; i < args.length; i++) {
		if (NUMERIC_COMPARISONS.has(args[i]!)) for (const side of [args[i - 1], args[i + 1]]) if (side !== undefined && !INTEGER.test(side)) return true;
		if (args[i] === "-t") {
			const fd = args[i + 1];
			if (fd !== undefined && !INTEGER.test(fd)) return true;
		}
	}
	return false;
}

// sed is read-only when it only prints lines (`-n` with `Np`/`N,Mp`) or substitutes on stdin.
export function sedReadOnly(argv: string[]): boolean {
	const scripts = sedScripts(argv);
	if (!scripts) return false;
	const files = sedHasFiles(argv);
	const prints = sedPrintsOnly(argv, scripts);
	const substitutes = sedSubstitutesStdin(argv, scripts, files);
	if (!prints && !substitutes) return false;
	if (substitutes && scripts.some((s) => s.includes(";"))) return false;
	return !scripts.some(sedScriptDangerous);
}

function sedScripts(argv: string[]): string[] | null {
	const args = argv.slice(1);
	if (args.some((a) => /^-e[wWe]/.test(a) || /^-w[eE]/.test(a)) || args.length === 0) return null;
	const scripts: string[] = [];
	let fromE = false;
	let positional = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if ((a === "-e" || a === "--expression") && i + 1 < args.length) {
			fromE = true;
			scripts.push(args[++i]!);
		} else if (a.startsWith("--expression=")) {
			fromE = true;
			scripts.push(a.slice(13));
		} else if (a.startsWith("-e=")) {
			fromE = true;
			scripts.push(a.slice(3));
		} else if (a.startsWith("-")) continue;
		else if (!fromE && !positional) {
			scripts.push(a);
			positional = true;
		} else break;
	}
	return scripts;
}

function sedHasFiles(argv: string[]): boolean {
	const args = argv.slice(1);
	let positional = 0;
	let fromE = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if ((a === "-e" || a === "--expression") && i + 1 < args.length) {
			fromE = true;
			i++;
			continue;
		}
		if (a.startsWith("--expression=") || a.startsWith("-e=")) {
			fromE = true;
			continue;
		}
		if (a.startsWith("-")) continue;
		positional++;
		if (fromE || positional > 1) return true;
	}
	return false;
}

const onlyFlags = (flags: string[], allowed: string[]) =>
	flags.every((f) => (f.startsWith("-") && !f.startsWith("--") && f.length > 2 ? [...f.slice(1)].every((c) => allowed.includes(`-${c}`)) : allowed.includes(f)));

function sedPrintsOnly(argv: string[], scripts: string[]): boolean {
	const flags = argv.slice(1).filter((a) => a.startsWith("-") && a !== "--");
	if (!onlyFlags(flags, ["-n", "--quiet", "--silent", "-E", "--regexp-extended", "-r", "-z", "--zero-terminated", "--posix"])) return false;
	if (!flags.some((f) => f === "-n" || f === "--quiet" || f === "--silent" || (!f.startsWith("--") && f.includes("n")))) return false;
	return scripts.length > 0 && scripts.every((s) => s.split(";").every((c) => /^(?:\d+|\d+,\d+)?p$/.test(c.trim())));
}

function sedSubstitutesStdin(argv: string[], scripts: string[], files: boolean): boolean {
	if (files) return false;
	const flags = argv.slice(1).filter((a) => a.startsWith("-") && a !== "--");
	if (!onlyFlags(flags, ["-E", "--regexp-extended", "-r", "--posix"])) return false;
	if (scripts.length !== 1) return false;
	const body = scripts[0]!.trim().match(/^s\/(.*?)$/)?.[1];
	if (body === undefined) return false;
	let slashes = 0;
	let last = -1;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\\") {
			i++;
			continue;
		}
		if (body[i] === "/") {
			slashes++;
			last = i;
		}
	}
	return slashes === 2 && /^[gpimIM]*[1-9]?[gpimIM]*$/.test(body.slice(last + 1));
}

// Commands that write files (w, W), run commands (e) or are hard to read statically.
function sedScriptDangerous(script: string): boolean {
	const n = script.trim();
	if (!n) return false;
	if (/[^\x01-\x7F]/.test(n) || n.includes("{") || n.includes("}") || n.includes("\n") || n.includes("\r")) return true;
	const hash = n.indexOf("#");
	if (hash !== -1 && !(hash > 0 && n[hash - 1] === "s")) return true;
	if (/^!/.test(n) || /[/\d$]!/.test(n)) return true;
	if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(n) || /^,/.test(n) || /,\s*[+-]/.test(n)) return true;
	if (/s\\/.test(n) || /\\[|#%@]/.test(n) || /\\\/.*[wW]/.test(n) || /\/[^/]*\s+[wWeE]/.test(n)) return true;
	if (/^s\//.test(n) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(n)) return true;
	if (/^s./.test(n) && /[wWeE]$/.test(n) && !/^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(n)) return true;
	if (
		/^[wW]\s*\S+/.test(n) ||
		/^\d+\s*[wW]\s*\S+/.test(n) ||
		/^\$\s*[wW]\s*\S+/.test(n) ||
		/^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(n) ||
		/^\d+,\d+\s*[wW]\s*\S+/.test(n) ||
		/^\d+,\$\s*[wW]\s*\S+/.test(n) ||
		/^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(n)
	)
		return true;
	if (
		/^e/.test(n) ||
		/^\d+\s*e/.test(n) ||
		/^\$\s*e/.test(n) ||
		/^\/[^/]*\/[IMim]*\s*e/.test(n) ||
		/^\d+,\d+\s*e/.test(n) ||
		/^\d+,\$\s*e/.test(n) ||
		/^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(n)
	)
		return true;
	const sub = n.match(/s([^\\\n]).*?\1.*?\1(.*?)$/);
	if (sub && /[wWeE]/.test(sub[2] ?? "")) return true;
	return /y([^\\\n])/.test(n) && /[wWeE]/.test(n);
}

// Commands read-only with any arguments.
export const READONLY_COMMANDS = [
	"docker ps",
	"docker images",
	..."cal uptime cat head tail wc stat strings hexdump od nl id uname free df du locale groups nproc basename dirname realpath cut paste tr column tac rev fold expand unexpand fmt comm cmp numfmt readlink diff true false sleep which type expr seq tsort pr".split(
		" ",
	),
];

export const BARE_ONLY = new Set(["pwd", "whoami", "alias"]);

export const EXACT_COMMANDS = [
	["claude", "-h"],
	["claude", "--help"],
	["node", "-v"],
	["node", "--version"],
	["python", "--version"],
	["python3", "--version"],
	["ip", "addr"],
];

// find actions that write, delete or run something.
export const FIND_ACTIONS = new Set(["-delete", "-rm", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fls", "-fprintf", "-files0-from"]);
// find predicates that take an argument.
export const FIND_VALUED = new Set(
	"-name -iname -path -ipath -lname -ilname -regex -iregex -wholename -iwholename -samefile -newer -anewer -cnewer -mnewer -perm -user -group -uid -gid -size -type -xtype -fstype -inum -links -used -context -amin -cmin -mmin -atime -ctime -mtime -mindepth -maxdepth -printf -regextype -D -f -flags -Bnewer -Btime -Bmin -files0-from -xattrname".split(
		" ",
	),
);
export const FIND_NEWER = /^-newer[aBcm][aBcmt]$/;
export const FIND_TAKES_NEXT = /^-(?:[EHLPXdsx]*D|f|[dsx]*[EHLPX][EHLPXdsx]*f)$/;
export const FIND_BAD_OPTION = /^-[dsx]+f$/;

const plainCommand = (cmd: string) => new RegExp(`^${cmd}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`);

// Claude Code's text patterns, tried after the argument checks.
export const READONLY_PATTERNS: RegExp[] = [
	...READONLY_COMMANDS.map(plainCommand),
	/^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
	/^claude -h$/,
	/^claude --help$/,
	/^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
	/^pwd$/,
	/^whoami$/,
	/^node -v$/,
	/^node --version$/,
	/^python --version$/,
	/^python3 --version$/,
	/^history(?:\s+\d+)?\s*$/,
	/^alias$/,
	/^arch(?:\s+(?:--help|-h))?\s*$/,
	/^ip addr$/,
	/^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
	/^jq(?!.*(?:\s['"]?-[a-zA-Z]*[fL]|--from-file|--rawfile|--slurpfile|--run-tests|--library-path|\benv\b|\$ENV\b|\binclude\b|\bimport\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
	/^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
	/^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
	/^find(?:[ \t]+(?:\\[()]|(?!-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b)[^<>()$`|{}&;\n\r\s]|[ \t])+)?$/,
];

// The only commands allowed to take unquoted globs.
export const GLOB_COMMANDS = new Set(
	"ls cat head tail wc stat grep egrep fgrep diff du df echo strings hexdump od nl cut column tr tac rev cmp basename dirname realpath readlink sha256sum sha1sum md5sum cd".split(" "),
);

// Environment variables a command prefix may set (with a value that is not a path).
export const SAFE_ENV = new Set(
	"GOEXPERIMENT GOOS GOARCH CGO_ENABLED GO111MODULE RUST_BACKTRACE RUST_LOG NODE_ENV PYTHONUNBUFFERED PYTHONDONTWRITEBYTECODE PYTEST_DISABLE_PLUGIN_AUTOLOAD PYTEST_DEBUG ANTHROPIC_API_KEY LANG LANGUAGE LC_ALL LC_CTYPE LC_TIME CHARSET TERM COLORTERM NO_COLOR FORCE_COLOR TZ LS_COLORS LSCOLORS GREP_COLOR GREP_COLORS GCC_COLORS TIME_STYLE BLOCK_SIZE BLOCKSIZE COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI DEBIAN_FRONTEND GIT_TERMINAL_PROMPT".split(
		" ",
	),
);
export const PATH_LIKE = /^[.~]*[/\\]|[/\\][/\\]|:[/\\.]|(?:^|[/\\])\.\.(?:[/\\]|$)/;

// What xargs may run.
export const XARGS_TARGETS = ["echo", "printf", "wc", "grep", "egrep", "fgrep", "head", "tail"];

const REF_SCOPE = { "--all": "none", "--branches": "none", "--tags": "none", "--remotes": "none" } as const;
const DATE_FILTERS = { "--since": "string", "--after": "string", "--until": "string", "--before": "string" } as const;
const LOG_DISPLAY = { "--oneline": "none", "--graph": "none", "--decorate": "none", "--no-decorate": "none", "--date": "string", "--relative-date": "none" } as const;
const COUNT = { "--max-count": "number", "-n": "number" } as const;
const DIFF_STAT = { "--stat": "none", "--numstat": "none", "--shortstat": "none", "--name-only": "none", "--name-status": "none" } as const;
const COLOR = { "--color": "none", "--no-color": "none" } as const;
const PATCH = { "--patch": "none", "-p": "none", "--no-patch": "none", "--no-ext-diff": "none", "-s": "none" } as const;
const AUTHOR_FILTERS = { "--author": "string", "--committer": "string", "--grep": "string" } as const;
const FD_FLAGS = { "-h": "none", "--help": "none", "-V": "none", "--version": "none", "-H": "none", "--hidden": "none", "-I": "none", "--no-ignore": "none", "--no-ignore-vcs": "none", "--no-ignore-parent": "none", "-s": "none", "--case-sensitive": "none", "-i": "none", "--ignore-case": "none", "-g": "none", "--glob": "none", "--regex": "none", "-F": "none", "--fixed-strings": "none", "-a": "none", "--absolute-path": "none", "-L": "none", "--follow": "none", "-p": "none", "--full-path": "none", "-0": "none", "--print0": "none", "-d": "number", "--max-depth": "number", "--min-depth": "number", "--exact-depth": "number", "-t": "string", "--type": "string", "-e": "string", "--extension": "string", "-S": "string", "--size": "string", "--changed-within": "string", "--changed-before": "string", "-o": "string", "--owner": "string", "-E": "string", "--exclude": "string", "--ignore-file": "string", "-c": "string", "--color": "string", "-j": "number", "--threads": "number", "--max-buffer-time": "string", "--max-results": "number", "-1": "none", "-q": "none", "--quiet": "none", "--show-errors": "none", "--strip-cwd-prefix": "none", "--one-file-system": "none", "--prune": "none", "--search-path": "string", "--base-directory": "string", "--path-separator": "string", "--batch-size": "number", "--no-require-git": "none", "--hyperlink": "string", "--and": "string", "--format": "string" } as const;
const GREP_FLAGS = { "-e": "string", "--regexp": "string", "-f": "string", "--file": "string", "-F": "none", "--fixed-strings": "none", "-G": "none", "--basic-regexp": "none", "-E": "none", "--extended-regexp": "none", "-P": "none", "--perl-regexp": "none", "-i": "none", "--ignore-case": "none", "--no-ignore-case": "none", "-v": "none", "--invert-match": "none", "-w": "none", "--word-regexp": "none", "-x": "none", "--line-regexp": "none", "-c": "none", "--count": "none", "--color": "string", "--colour": "string", "-L": "none", "--files-without-match": "none", "-l": "none", "--files-with-matches": "none", "-m": "number", "--max-count": "number", "-o": "none", "--only-matching": "none", "-q": "none", "--quiet": "none", "--silent": "none", "-s": "none", "--no-messages": "none", "-b": "none", "--byte-offset": "none", "-H": "none", "--with-filename": "none", "-h": "none", "--no-filename": "none", "--label": "string", "-n": "none", "--line-number": "none", "-T": "none", "--initial-tab": "none", "-u": "none", "--unix-byte-offsets": "none", "-Z": "none", "--null": "none", "-z": "none", "--null-data": "none", "-A": "number", "--after-context": "number", "-B": "number", "--before-context": "number", "-C": "number", "--context": "number", "--group-separator": "string", "--no-group-separator": "none", "-a": "none", "--text": "none", "--binary-files": "string", "-I": "none", "-D": "string", "--devices": "string", "-d": "string", "--directories": "string", "--exclude": "string", "--exclude-from": "string", "--exclude-dir": "string", "--include": "string", "-r": "none", "--recursive": "none", "-R": "none", "--dereference-recursive": "none", "--line-buffered": "none", "-U": "none", "--binary": "none", "--help": "none", "-V": "none", "--version": "none" } as const;

export const GIT_COMMANDS: Record<string, CommandConfig> = {
	"git diff": { safeFlags: { ...DIFF_STAT, ...COLOR, "--dirstat": "none", "--summary": "none", "--patch-with-stat": "none", "--word-diff": "none", "--word-diff-regex": "string", "--color-words": "none", "--no-renames": "none", "--no-ext-diff": "none", "--check": "none", "--ws-error-highlight": "string", "--full-index": "none", "--binary": "none", "--abbrev": "number", "--break-rewrites": "none", "--find-renames": "none", "--find-copies": "none", "--find-copies-harder": "none", "--irreversible-delete": "none", "--diff-algorithm": "string", "--histogram": "none", "--patience": "none", "--minimal": "none", "--ignore-space-at-eol": "none", "--ignore-space-change": "none", "--ignore-all-space": "none", "--ignore-blank-lines": "none", "--inter-hunk-context": "number", "--function-context": "none", "--exit-code": "none", "--quiet": "none", "--cached": "none", "--staged": "none", "--pickaxe-regex": "none", "--pickaxe-all": "none", "--no-index": "none", "--relative": "string", "--diff-filter": "string", "-p": "none", "-u": "none", "-s": "none", "-M": "none", "-C": "none", "-B": "none", "-D": "none", "-l": "none", "-S": "string", "-G": "string", "-O": "string", "-R": "none" } },
	"git log": { safeFlags: { ...LOG_DISPLAY, ...REF_SCOPE, ...DATE_FILTERS, ...COUNT, ...DIFF_STAT, ...COLOR, ...PATCH, ...AUTHOR_FILTERS, "--abbrev-commit": "none", "--full-history": "none", "--dense": "none", "--sparse": "none", "--simplify-merges": "none", "--ancestry-path": "none", "--source": "none", "--first-parent": "none", "--merges": "none", "--no-merges": "none", "--reverse": "none", "--walk-reflogs": "none", "--skip": "number", "--max-age": "number", "--min-age": "number", "--no-min-parents": "none", "--no-max-parents": "none", "--follow": "none", "--no-walk": "none", "--left-right": "none", "--cherry-mark": "none", "--cherry-pick": "none", "--boundary": "none", "--topo-order": "none", "--date-order": "none", "--author-date-order": "none", "--pretty": "string", "--format": "string", "--diff-filter": "string", "-S": "string", "-G": "string", "--pickaxe-regex": "none", "--pickaxe-all": "none" }, isDangerous: gitFormatIsDangerous },
	"git show": { safeFlags: { ...LOG_DISPLAY, ...DIFF_STAT, ...COLOR, ...PATCH, "--abbrev-commit": "none", "--word-diff": "none", "--word-diff-regex": "string", "--color-words": "none", "--pretty": "string", "--format": "string", "--first-parent": "none", "--raw": "none", "--diff-filter": "string", "-m": "none", "--quiet": "none" }, isDangerous: gitFormatIsDangerous },
	"git shortlog": { safeFlags: { ...REF_SCOPE, ...DATE_FILTERS, "-s": "none", "--summary": "none", "-n": "none", "--numbered": "none", "-e": "none", "--email": "none", "-c": "none", "--committer": "none", "--group": "string", "--format": "string", "--no-merges": "none", "--author": "string" }, isDangerous: gitFormatIsDangerous },
	"git reflog": { safeFlags: { ...LOG_DISPLAY, ...REF_SCOPE, ...DATE_FILTERS, ...COUNT, ...AUTHOR_FILTERS }, isDangerous: reflogIsDangerous },
	"git stash list": { safeFlags: { ...LOG_DISPLAY, ...REF_SCOPE, ...COUNT }, respectsDoubleDash: false },
	"git ls-remote": { safeFlags: { "--branches": "none", "-b": "none", "--tags": "none", "-t": "none", "--heads": "none", "-h": "none", "--refs": "none", "--quiet": "none", "-q": "none", "--exit-code": "none", "--get-url": "none", "--symref": "none", "--sort": "string" }, isDangerous: lsRemoteIsDangerous },
	"git status": { safeFlags: { "--short": "none", "-s": "none", "--branch": "none", "-b": "none", "--porcelain": "none", "--long": "none", "--verbose": "none", "-v": "none", "--untracked-files": "string", "-u": "string", "--ignored": "none", "--ignore-submodules": "string", "--column": "none", "--no-column": "none", "--ahead-behind": "none", "--no-ahead-behind": "none", "--renames": "none", "--no-renames": "none", "--find-renames": "string", "-M": "string" } },
	"git blame": { safeFlags: { ...COLOR, "-L": "string", "--porcelain": "none", "-p": "none", "--line-porcelain": "none", "--incremental": "none", "--root": "none", "--show-stats": "none", "--show-name": "none", "--show-number": "none", "-n": "none", "--show-email": "none", "-e": "none", "-f": "none", "--date": "string", "-w": "none", "--ignore-rev": "string", "--ignore-revs-file": "string", "-M": "none", "-C": "none", "--score-debug": "none", "--abbrev": "number", "-s": "none", "-l": "none", "-t": "none" }, respectsDoubleDash: false },
	"git ls-files": { safeFlags: { "--cached": "none", "-c": "none", "--deleted": "none", "-d": "none", "--modified": "none", "-m": "none", "--others": "none", "-o": "none", "--ignored": "none", "-i": "none", "--stage": "none", "-s": "none", "--killed": "none", "-k": "none", "--unmerged": "none", "-u": "none", "--directory": "none", "--no-empty-directory": "none", "--eol": "none", "--full-name": "none", "--abbrev": "number", "--debug": "none", "-z": "none", "-t": "none", "-v": "none", "-f": "none", "--exclude": "string", "-x": "string", "--exclude-from": "string", "-X": "string", "--exclude-per-directory": "string", "--exclude-standard": "none", "--error-unmatch": "none", "--recurse-submodules": "none" } },
	"git config --get": { safeFlags: { "--local": "none", "--global": "none", "--system": "none", "--worktree": "none", "--default": "string", "--type": "string", "--bool": "none", "--int": "none", "--bool-or-int": "none", "--path": "none", "--expiry-date": "none", "-z": "none", "--null": "none", "--name-only": "none", "--show-origin": "none", "--show-scope": "none" } },
	"git remote show": { safeFlags: { "-n": "none" }, isDangerous: remoteShowIsDangerous },
	"git remote": { safeFlags: { "-v": "none", "--verbose": "none" }, isDangerous: remoteIsDangerous },
	"git merge-base": { safeFlags: { "--is-ancestor": "none", "--fork-point": "none", "--octopus": "none", "--independent": "none", "--all": "none" } },
	"git rev-parse": { safeFlags: { "--verify": "none", "--short": "string", "--abbrev-ref": "none", "--symbolic": "none", "--symbolic-full-name": "none", "--show-toplevel": "none", "--show-cdup": "none", "--show-prefix": "none", "--git-dir": "none", "--git-common-dir": "none", "--absolute-git-dir": "none", "--show-superproject-working-tree": "none", "--is-inside-work-tree": "none", "--is-inside-git-dir": "none", "--is-bare-repository": "none", "--is-shallow-repository": "none", "--is-shallow-update": "none", "--path-prefix": "none" } },
	"git rev-list": { safeFlags: { ...REF_SCOPE, ...DATE_FILTERS, ...COUNT, ...AUTHOR_FILTERS, "--count": "none", "--reverse": "none", "--first-parent": "none", "--ancestry-path": "none", "--merges": "none", "--no-merges": "none", "--min-parents": "number", "--max-parents": "number", "--no-min-parents": "none", "--no-max-parents": "none", "--skip": "number", "--max-age": "number", "--min-age": "number", "--walk-reflogs": "none", "--oneline": "none", "--abbrev-commit": "none", "--pretty": "string", "--format": "string", "--abbrev": "number", "--full-history": "none", "--dense": "none", "--sparse": "none", "--source": "none", "--graph": "none" }, isDangerous: gitFormatIsDangerous },
	"git describe": { safeFlags: { "--tags": "none", "--match": "string", "--exclude": "string", "--long": "none", "--abbrev": "number", "--always": "none", "--contains": "none", "--first-match": "none", "--exact-match": "none", "--candidates": "number", "--dirty": "none", "--broken": "none" } },
	"git cat-file": { safeFlags: { "-t": "none", "-s": "none", "-p": "none", "-e": "none", "--batch-check": "none", "--allow-undetermined-type": "none" } },
	"git for-each-ref": { safeFlags: { "--format": "string", "--sort": "string", "--count": "number", "--contains": "string", "--no-contains": "string", "--merged": "string", "--no-merged": "string", "--points-at": "string" }, isDangerous: gitFormatIsDangerous },
	"git grep": { safeFlags: { "-e": "string", "-E": "none", "--extended-regexp": "none", "-G": "none", "--basic-regexp": "none", "-F": "none", "--fixed-strings": "none", "-P": "none", "--perl-regexp": "none", "-i": "none", "--ignore-case": "none", "-v": "none", "--invert-match": "none", "-w": "none", "--word-regexp": "none", "-n": "none", "--line-number": "none", "-c": "none", "--count": "none", "-l": "none", "--files-with-matches": "none", "-L": "none", "--files-without-match": "none", "-h": "none", "-H": "none", "--heading": "none", "--break": "none", "--full-name": "none", "--color": "none", "--no-color": "none", "-o": "none", "--only-matching": "none", "-A": "number", "--after-context": "number", "-B": "number", "--before-context": "number", "-C": "number", "--context": "number", "--and": "none", "--or": "none", "--not": "none", "--max-depth": "number", "--untracked": "none", "--no-index": "none", "--recurse-submodules": "none", "--cached": "none", "--threads": "number", "-q": "none", "--quiet": "none" } },
	"git stash show": { safeFlags: { ...DIFF_STAT, ...COLOR, ...PATCH, "--word-diff": "none", "--word-diff-regex": "string", "--diff-filter": "string", "--abbrev": "number" } },
	"git worktree list": { safeFlags: { "--porcelain": "none", "-v": "none", "--verbose": "none", "--expire": "string" } },
	"git tag": { safeFlags: { "-l": "none", "--list": "none", "-n": "number", "--contains": "string", "--no-contains": "string", "--merged": "string", "--no-merged": "string", "--sort": "string", "--format": "string", "--points-at": "string", "--column": "none", "--no-column": "none", "-i": "none", "--ignore-case": "none" }, isDangerous: tagIsDangerous },
	"git branch": { safeFlags: { "-l": "none", "--list": "none", "-a": "none", "--all": "none", "-r": "none", "--remotes": "none", "-v": "none", "-vv": "none", "--verbose": "none", "--color": "none", "--no-color": "none", "--column": "none", "--no-column": "none", "--abbrev": "number", "--no-abbrev": "none", "--contains": "string", "--no-contains": "string", "--merged": "none", "--no-merged": "none", "--points-at": "string", "--sort": "string", "--show-current": "none", "-i": "none", "--ignore-case": "none" }, isDangerous: branchIsDangerous },
};

const DOCKER_COMMANDS: Record<string, CommandConfig> = {
	"docker logs": { safeFlags: { "--follow": "none", "-f": "none", "--tail": "string", "-n": "string", "--timestamps": "none", "-t": "none", "--since": "string", "--until": "string", "--details": "none" }, isDangerous: dockerIsDangerous },
	"docker inspect": { safeFlags: { "--format": "string", "-f": "string", "--type": "string", "--size": "none", "-s": "none" }, isDangerous: dockerIsDangerous },
};

const RIPGREP: Record<string, CommandConfig> = {
	"rg": { safeFlags: { "-e": "string", "--regexp": "string", "-f": "string", "-i": "none", "--ignore-case": "none", "-S": "none", "--smart-case": "none", "-F": "none", "--fixed-strings": "none", "-w": "none", "--word-regexp": "none", "-v": "none", "--invert-match": "none", "-c": "none", "--count": "none", "-l": "none", "--files-with-matches": "none", "--files-without-match": "none", "-n": "none", "--line-number": "none", "-o": "none", "--only-matching": "none", "-A": "number", "--after-context": "number", "-B": "number", "--before-context": "number", "-C": "number", "--context": "number", "-H": "none", "-h": "none", "--heading": "none", "--no-heading": "none", "-q": "none", "--quiet": "none", "--column": "none", "-g": "string", "--glob": "string", "-t": "string", "--type": "string", "-T": "string", "--type-not": "string", "--type-list": "none", "--hidden": "none", "--no-ignore": "none", "-u": "none", "-m": "number", "--max-count": "number", "-d": "number", "--max-depth": "number", "-a": "none", "--text": "none", "-L": "none", "--follow": "none", "--color": "string", "--json": "none", "--stats": "none", "--help": "none", "--version": "none", "--debug": "none", "--": "none" } },
};

export const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
	"xargs": { safeFlags: { "-I": "{}", "-n": "number", "-P": "number", "-L": "number", "-s": "number", "-E": "EOF", "-0": "none", "-t": "none", "-r": "none", "-x": "none", "-d": "char" } },
	...GIT_COMMANDS,
	"file": { safeFlags: { "--brief": "none", "-b": "none", "--mime": "none", "-i": "none", "--mime-type": "none", "--mime-encoding": "none", "--apple": "none", "--check-encoding": "none", "-c": "none", "--exclude": "string", "--exclude-quiet": "string", "--print0": "none", "-0": "none", "-F": "string", "--separator": "string", "--help": "none", "--version": "none", "-v": "none", "--no-dereference": "none", "-h": "none", "--dereference": "none", "-L": "none", "--keep-going": "none", "-k": "none", "--list": "none", "-l": "none", "--no-buffer": "none", "-n": "none", "--preserve-date": "none", "-p": "none", "--raw": "none", "-r": "none", "-s": "none", "--special-files": "none" } },
	"sed": { safeFlags: { "--expression": "string", "-e": "string", "--quiet": "none", "--silent": "none", "-n": "none", "--regexp-extended": "none", "-r": "none", "--posix": "none", "-E": "none", "--line-length": "number", "-l": "number", "--zero-terminated": "none", "-z": "none", "--separate": "none", "-s": "none", "--unbuffered": "none", "-u": "none", "--debug": "none", "--help": "none", "--version": "none" }, isDangerous: sedIsDangerous },
	"sort": { safeFlags: { "--ignore-leading-blanks": "none", "-b": "none", "--dictionary-order": "none", "-d": "none", "--ignore-case": "none", "-f": "none", "--general-numeric-sort": "none", "-g": "none", "--human-numeric-sort": "none", "-h": "none", "--ignore-nonprinting": "none", "-i": "none", "--month-sort": "none", "-M": "none", "--numeric-sort": "none", "-n": "none", "--random-sort": "none", "-R": "none", "--reverse": "none", "-r": "none", "--sort": "string", "--stable": "none", "-s": "none", "--unique": "none", "-u": "none", "--version-sort": "none", "-V": "none", "--zero-terminated": "none", "-z": "none", "--key": "string", "-k": "string", "--field-separator": "string", "-t": "string", "--check": "none", "-c": "none", "--check-char-order": "none", "-C": "none", "--merge": "none", "-m": "none", "--buffer-size": "string", "-S": "string", "--parallel": "number", "--batch-size": "number", "--help": "none", "--version": "none" } },
	"man": { safeFlags: { "-a": "none", "--all": "none", "-d": "none", "-f": "none", "--whatis": "none", "-h": "none", "-k": "none", "--apropos": "none", "-w": "none", "-S": "string", "-s": "string" }, isDangerous: manIsDangerous },
	"help": { safeFlags: { "-d": "none" }, isDangerous: helpIsDangerous },
	"netstat": { safeFlags: { "-a": "none", "-L": "none", "-l": "none", "-n": "none", "-f": "string", "-g": "none", "-i": "none", "-I": "string", "-s": "none", "-r": "none", "-m": "none", "-v": "none" } },
	"ps": { safeFlags: { "-e": "none", "-A": "none", "-a": "none", "-d": "none", "-N": "none", "--deselect": "none", "-f": "none", "-F": "none", "-l": "none", "-j": "none", "-y": "none", "-w": "none", "-ww": "none", "--width": "number", "-c": "none", "-H": "none", "--forest": "none", "--headers": "none", "--no-headers": "none", "-n": "string", "--sort": "string", "-L": "none", "-T": "none", "-m": "none", "-C": "string", "-G": "string", "-g": "string", "-p": "string", "--pid": "string", "-q": "string", "--quick-pid": "string", "-s": "string", "--sid": "string", "-t": "string", "--tty": "string", "-U": "string", "-u": "string", "--user": "string", "--help": "none", "--info": "none", "-V": "none", "--version": "none" }, respectsDoubleDash: false, isDangerous: psIsDangerous },
	"base64": { safeFlags: { "-d": "none", "-D": "none", "--decode": "none", "-b": "number", "--break": "number", "-w": "number", "--wrap": "number", "-i": "string", "--input": "string", "--ignore-garbage": "none", "-h": "none", "--help": "none", "--version": "none" }, respectsDoubleDash: false },
	"grep": { safeFlags: GREP_FLAGS },
	"egrep": { safeFlags: GREP_FLAGS },
	"fgrep": { safeFlags: GREP_FLAGS },
	...RIPGREP,
	"sha256sum": { safeFlags: { "-b": "none", "--binary": "none", "-t": "none", "--text": "none", "-c": "none", "--check": "none", "--ignore-missing": "none", "--quiet": "none", "--status": "none", "--strict": "none", "-w": "none", "--warn": "none", "--tag": "none", "-z": "none", "--zero": "none", "--help": "none", "--version": "none" } },
	"sha1sum": { safeFlags: { "-b": "none", "--binary": "none", "-t": "none", "--text": "none", "-c": "none", "--check": "none", "--ignore-missing": "none", "--quiet": "none", "--status": "none", "--strict": "none", "-w": "none", "--warn": "none", "--tag": "none", "-z": "none", "--zero": "none", "--help": "none", "--version": "none" } },
	"md5sum": { safeFlags: { "-b": "none", "--binary": "none", "-t": "none", "--text": "none", "-c": "none", "--check": "none", "--ignore-missing": "none", "--quiet": "none", "--status": "none", "--strict": "none", "-w": "none", "--warn": "none", "--tag": "none", "-z": "none", "--zero": "none", "--help": "none", "--version": "none" } },
	"tree": { safeFlags: { "-a": "none", "-d": "none", "-l": "none", "-f": "none", "-x": "none", "-L": "number", "-P": "string", "-I": "string", "--gitignore": "none", "--gitfile": "string", "--ignore-case": "none", "--matchdirs": "none", "--metafirst": "none", "--prune": "none", "--info": "none", "--infofile": "string", "--noreport": "none", "--charset": "string", "--filelimit": "number", "-q": "none", "-N": "none", "-Q": "none", "-p": "none", "-u": "none", "-g": "none", "-s": "none", "-h": "none", "--si": "none", "--du": "none", "-D": "none", "--timefmt": "string", "-F": "none", "--inodes": "none", "--device": "none", "-v": "none", "-t": "none", "-c": "none", "-U": "none", "-r": "none", "--dirsfirst": "none", "--filesfirst": "none", "--sort": "string", "-i": "none", "-A": "none", "-S": "none", "-n": "none", "-C": "none", "-X": "none", "-J": "none", "-H": "string", "--nolinks": "none", "--hintro": "string", "--houtro": "string", "-T": "string", "--hyperlink": "none", "--scheme": "string", "--authority": "string", "--fromfile": "none", "--fromtabfile": "none", "--fflinks": "none", "--help": "none", "--version": "none" } },
	"date": { safeFlags: { "-d": "string", "--date": "string", "-r": "string", "--reference": "string", "-u": "none", "--utc": "none", "--universal": "none", "-I": "none", "--iso-8601": "string", "-R": "none", "--rfc-email": "none", "--rfc-3339": "string", "--debug": "none", "--help": "none", "--version": "none" }, isDangerous: dateIsDangerous },
	"hostname": { safeFlags: { "-f": "none", "--fqdn": "none", "--long": "none", "-s": "none", "--short": "none", "-i": "none", "--ip-address": "none", "-I": "none", "--all-ip-addresses": "none", "-a": "none", "--alias": "none", "-d": "none", "--domain": "none", "-A": "none", "--all-fqdns": "none", "-v": "none", "--verbose": "none", "-h": "none", "--help": "none", "-V": "none", "--version": "none" }, regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/ },
	"lsof": { safeFlags: { "-?": "none", "-h": "none", "-v": "none", "-a": "none", "-b": "none", "-C": "none", "-l": "none", "-n": "none", "-N": "none", "-O": "none", "-P": "none", "-Q": "none", "-R": "none", "-t": "none", "-U": "none", "-V": "none", "-X": "none", "-H": "none", "-E": "none", "-F": "none", "-g": "none", "-i": "none", "-K": "none", "-L": "none", "-o": "none", "-r": "none", "-s": "none", "-S": "none", "-T": "none", "-x": "none", "-A": "string", "-c": "string", "-d": "string", "-e": "string", "-k": "string", "-p": "string", "-u": "string" }, isDangerous: lsofIsDangerous },
	"pgrep": { safeFlags: { "-d": "string", "--delimiter": "string", "-l": "none", "--list-name": "none", "-a": "none", "--list-full": "none", "-v": "none", "--inverse": "none", "-w": "none", "--lightweight": "none", "-c": "none", "--count": "none", "-f": "none", "--full": "none", "-g": "string", "--pgroup": "string", "-G": "string", "--group": "string", "-i": "none", "--ignore-case": "none", "-n": "none", "--newest": "none", "-o": "none", "--oldest": "none", "-O": "string", "--older": "string", "-P": "string", "--parent": "string", "-s": "string", "--session": "string", "-t": "string", "--terminal": "string", "-u": "string", "--euid": "string", "-U": "string", "--uid": "string", "-x": "none", "--exact": "none", "-F": "string", "--pidfile": "string", "-L": "none", "--logpidfile": "none", "-r": "string", "--runstates": "string", "--ns": "string", "--nslist": "string", "--help": "none", "-V": "none", "--version": "none" } },
	"tput": { safeFlags: { "-T": "string", "-V": "none", "-x": "none" }, isDangerous: tputIsDangerous },
	"ss": { safeFlags: { "-h": "none", "--help": "none", "-V": "none", "--version": "none", "-n": "none", "--numeric": "none", "-a": "none", "--all": "none", "-l": "none", "--listening": "none", "-o": "none", "--options": "none", "-e": "none", "--extended": "none", "-m": "none", "--memory": "none", "-p": "none", "--processes": "none", "-i": "none", "--info": "none", "-s": "none", "--summary": "none", "-4": "none", "--ipv4": "none", "-6": "none", "--ipv6": "none", "-0": "none", "--packet": "none", "-t": "none", "--tcp": "none", "-M": "none", "--mptcp": "none", "-S": "none", "--sctp": "none", "-u": "none", "--udp": "none", "-d": "none", "--dccp": "none", "-w": "none", "--raw": "none", "-x": "none", "--unix": "none", "--tipc": "none", "--vsock": "none", "-f": "string", "--family": "string", "-A": "string", "--query": "string", "--socket": "string", "-Z": "none", "--context": "none", "-z": "none", "--contexts": "none", "-b": "none", "--bpf": "none", "-E": "none", "--events": "none", "-H": "none", "--no-header": "none", "-O": "none", "--oneline": "none", "--tipcinfo": "none", "--tos": "none", "--cgroup": "none", "--inet-sockopt": "none" }, isDangerous: ssIsDangerous },
	"fd": { safeFlags: { ...FD_FLAGS } },
	"fdfind": { safeFlags: { ...FD_FLAGS } },
	...DOCKER_COMMANDS,
	"test": { safeFlags: { "-b": "string", "-c": "string", "-d": "string", "-e": "string", "-f": "string", "-g": "string", "-G": "string", "-h": "string", "-k": "string", "-L": "string", "-N": "string", "-O": "string", "-p": "string", "-r": "string", "-s": "string", "-S": "string", "-t": "string", "-u": "string", "-w": "string", "-x": "string", "-z": "string", "-n": "string", "-eq": "string", "-ne": "string", "-lt": "string", "-le": "string", "-gt": "string", "-ge": "string", "-nt": "string", "-ot": "string", "-ef": "string" }, respectsDoubleDash: false, isDangerous: testIsDangerous },
};
