// Text rules shared with the training pipeline (cc-mod-auto-compact's training/pipeline/text.py):
// the same clip, token estimate, prompt filter and message grouping, so serving reads a session
// the way training did. tests/parity.test.ts checks them against fixtures the Python generated.

export const MARKER = "\n[… truncated …]\n";
export const BYTES_PER_TOKEN = 3;
export const MAX_AGENT_BYTES = 16_000;
export const MAX_TOOL_INPUT_BYTES = 300;

const SKIP_PREFIXES = [
	"<local-command-", "<command-name>", "<command-message>", "<bash-input>", "<bash-stdout>",
	"<bash-stderr>", "<task-notification>", "[Request interrupted", "Caveat:", "<system-reminder>",
	"This session is being continued", "[REDACTED_CONFIG_DUMP", "<ci_monitor_event>", "<ci-monitor-event>",
	"[task_started]", "[task_notification]", "[task_progress]", "[init]", "[result]",
];

export interface ToolUse {
	tool?: string;
	input?: unknown;
	isError?: boolean;
	line?: string;
}

// A transcript row as Claude Code's $.session.messages() gives it; transcript.ts builds them from Pi's messages.
export interface Row {
	role: "user" | "assistant";
	text: string;
	toolUses?: ToolUse[];
	toolResults?: unknown[];
}

export interface TreeMessage {
	kind: "user" | "agent";
	text: string;
	row: number;
}

const encoder = new TextEncoder();

export function utf8Len(text: string) {
	return encoder.encode(text).length;
}

// Never below one token per word, digit, whitespace run or other character: code runs near 2 bytes a token.
const PIECES = /[A-Za-z]+|[0-9]|\s+|[^A-Za-z0-9\s]/gu;

export function estimateTokens(text: string) {
	return Math.max(Math.ceil(utf8Len(text) / BYTES_PER_TOKEN), (text.match(PIECES) ?? []).length);
}

function head(chars: string[], limit: number) {
	let size = 0;
	let n = 0;
	for (const c of chars) {
		const len = utf8Len(c);
		if (size + len > limit) break;
		size += len;
		n++;
	}
	return chars.slice(0, n);
}

// Cut in the middle to fit both budgets, keeping the start and the end, never inside a code point.
export function clip(text: string | null | undefined, maxBytes: number, maxTokens?: number | null) {
	const value = text ?? "";
	const limit = maxTokens === undefined || maxTokens === null ? maxBytes : Math.min(maxBytes, maxTokens * BYTES_PER_TOKEN);
	if (utf8Len(value) <= limit) return value;
	const half = Math.max(0, Math.floor((limit - utf8Len(MARKER)) / 2));
	const chars = Array.from(value);
	const start = head(chars, half).join("");
	const end = head([...chars].reverse(), half).reverse().join("");
	return start + MARKER + end;
}

// A quarter of the budget for the start and the rest for the end, where an agent's reply
// concludes or asks (clip_end in text.py).
export function clipEnd(text: string | null | undefined, maxBytes: number) {
	const value = text ?? "";
	if (utf8Len(value) <= maxBytes) return value;
	const room = Math.max(0, maxBytes - utf8Len(MARKER));
	const chars = Array.from(value);
	const quarter = Math.floor(room / 4);
	return head(chars, quarter).join("") + MARKER + head([...chars].reverse(), room - quarter).reverse().join("");
}

export function cleanPrompt(text: string | null | undefined) {
	let value = (text ?? "").trim();
	const query = /<user_query>\s*(.*?)\s*<\/user_query>/s.exec(value);
	if (query) value = query[1]!;
	value = value
		.replace(/<timestamp>.*?<\/timestamp>/gs, "")
		.replace(/<system-reminder>.*?<\/system-reminder>/gs, "")
		.replace(/<image_files>.*?<\/image_files>/gs, "")
		.replace(/<ide_(opened_file|selection|diagnostics)>.*?<\/ide_\1>/gs, "")
		.replace(/^(\[Image[^\]]*\]\s*)+/, "")
		.trim();
	if (!value || SKIP_PREFIXES.some((p) => value.startsWith(p))) return null;
	return value;
}

export function commandOf(text: string | null | undefined) {
	const m = /<command-name>\/(clear|compact)<\/command-name>/.exec(text ?? "");
	return m ? m[1]! : null;
}

// JSON as Python's json.dumps writes it, so byte counts and budgets agree.
export function pyJson(value: unknown, { compact = false, sortKeys = false } = {}): string {
	const itemSep = compact ? "," : ", ";
	const keySep = compact ? ":" : ": ";
	const walk = (v: unknown): string => {
		if (v === null || v === undefined) return "null";
		if (Array.isArray(v)) return "[" + v.map(walk).join(itemSep) + "]";
		if (typeof v === "object") {
			const keys = Object.keys(v);
			if (sortKeys) keys.sort();
			return "{" + keys.map((k) => JSON.stringify(k) + keySep + walk((v as Record<string, unknown>)[k])).join(itemSep) + "}";
		}
		if (typeof v === "boolean") return v ? "true" : "false";
		return JSON.stringify(v);
	};
	return walk(value);
}

export function toolLine(use: ToolUse) {
	if (use.line) return use.line;
	const args = pyJson(use.input ?? {}, { compact: true, sortKeys: true });
	const line = "tool: " + (use.tool || "?") + " " + clip(args, MAX_TOOL_INPUT_BYTES);
	return line + (use.isError ? " (error)" : "");
}

// Tree messages from transcript rows: each human prompt, and everything the agent did between
// two prompts as one `agent` message. Tool results are dropped.
export function messages(rows: Row[]) {
	const out: TreeMessage[] = [];
	rows.forEach((r, i) => {
		if (r.role === "user") {
			if (r.toolResults?.length) return;
			const prompt = cleanPrompt(r.text);
			if (prompt !== null) out.push({ kind: "user", text: prompt, row: i });
			return;
		}
		const parts: string[] = [];
		if ((r.text ?? "").trim()) parts.push("agent: " + r.text.trim());
		for (const u of r.toolUses ?? []) parts.push(toolLine(u));
		if (!parts.length) return;
		const last = out[out.length - 1];
		if (last && last.kind === "agent") last.text += "\n" + parts.join("\n");
		else out.push({ kind: "agent", text: parts.join("\n"), row: i });
	});
	return out;
}

export function render(message: TreeMessage) {
	return clip(message.kind === "user" ? "user: " + message.text : message.text, MAX_AGENT_BYTES);
}
