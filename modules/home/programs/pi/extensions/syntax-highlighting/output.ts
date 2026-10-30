// Colors for what commands print: a JSON document, a unified diff, or log-ish
// text where only the telling parts (severities, exit codes, HTTP statuses,
// addresses) stand out from the usual output color.
import { highlightEmbedded, type Paint, type Token } from "./highlight.ts";

export type OutputKind = "json" | "diff" | "log";

const MAX_JSON = 256 * 1024;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function outputKind(lines: readonly string[]): OutputKind {
	const text = lines.join("\n").trim();
	if (text.length <= MAX_JSON && /^[[{]/.test(text) && /[\]}]$/.test(text)) {
		try {
			JSON.parse(text);
			return "json";
		} catch {}
	}
	if (lines.some((line) => HUNK.test(line)) && lines.some((line) => line.startsWith("--- ") || line.startsWith("diff "))) return "diff";
	return "log";
}

/** `lines` styled for display, one string per line with the same visible text. */
export function styleOutput(paint: Paint, lines: readonly string[]): string[] {
	const kind = outputKind(lines);
	if (kind === "json") {
		const styled = highlightEmbedded(paint, lines.join("\n"), "json", "toolOutput", "toolOutput").split("\n");
		if (styled.length === lines.length) return styled;
	}
	if (kind === "diff") return styleDiff(paint, lines);
	return lines.map((line) => styleLogLine(paint, line));
}

const FILE_HEADER = /^(?:diff |--- |\+\+\+ )/;
const META = /^(?:index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|\\ No newline)/;

function diffPath(line: string): string | undefined {
	const path = line.slice(4).split("\t")[0]!.trim();
	if (path === "/dev/null") return undefined;
	return path.replace(/^[ab]\//, "");
}

// Hunk lines are counted from their header, so a `--- a/next` after a hunk
// reads as the next file's header, not as a removed line.
function styleDiff(paint: Paint, lines: readonly string[]): string[] {
	let language: string | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	return lines.map((line) => {
		if (oldLeft > 0 || newLeft > 0) {
			const sign = line[0];
			if (sign === "+") {
				newLeft--;
				return paint.fg("toolDiffAdded", line);
			}
			if (sign === "-") {
				oldLeft--;
				return paint.fg("toolDiffRemoved", line);
			}
			if (sign === "\\") return paint.fg("muted", line);
			if (sign === " " || line === "") {
				oldLeft--;
				newLeft--;
				const code = line.slice(1);
				const body = language && code ? highlightEmbedded(paint, code, language, "toolDiffContext", "toolDiffContext") : paint.fg("toolDiffContext", code);
				return line ? paint.fg("toolDiffContext", " ") + body : "";
			}
			oldLeft = newLeft = 0;
		}
		const hunk = HUNK.exec(line);
		if (hunk) {
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			const context = hunk[5]!;
			return paint.fg("accent", line.slice(0, line.length - context.length)) + (context ? paint.fg("muted", context) : "");
		}
		if (line.startsWith("+++ ") || line.startsWith("--- ")) {
			const path = diffPath(line);
			if (path) language = paint.languageForPath(path);
		}
		if (FILE_HEADER.test(line)) return paint.bold(paint.fg("toolTitle", line));
		if (META.test(line)) return paint.fg("muted", line);
		return styleLogLine(paint, line);
	});
}

type Color = Extract<Token, "dim" | "accent" | "success" | "warning" | "error">;

interface Rule {
	pattern: RegExp;
	color: Color | ((token: string) => Color);
}

function severity(word: string): Color {
	const name = word.replace(/[\[\]:]/g, "").replace(/\(.*$/, "").toUpperCase();
	if (name.startsWith("WARN")) return "warning";
	if (["PASS", "PASSED", "SUCCESS", "OK"].includes(name)) return "success";
	return "error";
}

const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?`;
// What may come before a level at the start of a line: a time, `[tags]`.
const LINE_START = String.raw`^\s*(?:${TIMESTAMP}\s+)?(?:\[[^\]]{1,80}\]\s*)*`;
const LEVELS = "ERROR|FATAL|CRITICAL|PANIC|FAIL|FAILED|WARN|WARNING|PASS|PASSED|SUCCESS";
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;

// Each pattern's first group is what gets colored.
const RULES: Rule[] = [
	{ pattern: new RegExp(`(${TIMESTAMP})`, "dg"), color: "dim" },
	{ pattern: new RegExp(`${LINE_START}((?:${LEVELS})\\b:?)`, "dg"), color: severity },
	// `error:`, `fatal:` (git), `error[E0382]:` (rustc), `warning:`.
	{ pattern: new RegExp(`${LINE_START}((?:error|fatal|critical|panic|warn|warning)(?:\\[[^\\]]+\\])?:)`, "dgi"), color: severity },
	{ pattern: new RegExp(`\\[((?:${LEVELS}))\\]`, "dg"), color: severity },
	{ pattern: /^(?:Build|Tests?|Deployment|Pipeline)\s+(FAILED|PASSED|SUCCESS)\b/dg, color: severity },
	{ pattern: /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)(?=\s+(?:\/|https?:\/\/))/dg, color: "accent" },
	{ pattern: /\bHTTP\/\d(?:\.\d)?\s+([1-5]\d\d)\b/dg, color: (code) => (code[0] === "2" || code[0] === "1" ? "success" : code[0] === "3" ? "warning" : "error") },
	// Pi ends a failed command's output with `Command exited with code N`.
	{ pattern: /\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?:?\s+([1-9]\d*)\b/dgi, color: "error" },
	{ pattern: new RegExp(`(?<![\\w.])(${OCTET}(?:\\.${OCTET}){3}(?::\\d{1,5})?)(?![\\w.])`, "dg"), color: "accent" },
];

export function styleLogLine(paint: Paint, line: string): string {
	const spans: { start: number; end: number; color: Color }[] = [];
	for (const rule of RULES) {
		for (const match of line.matchAll(rule.pattern)) {
			const [start, end] = match.indices![1]!;
			const color = typeof rule.color === "string" ? rule.color : rule.color(match[1]!);
			spans.push({ start, end, color });
		}
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	let out = "";
	let at = 0;
	for (const span of spans) {
		if (span.start < at) continue;
		if (span.start > at) out += paint.fg("toolOutput", line.slice(at, span.start));
		out += paint.fg(span.color, line.slice(span.start, span.end));
		at = span.end;
	}
	if (at < line.length) out += paint.fg("toolOutput", line.slice(at));
	return out;
}
