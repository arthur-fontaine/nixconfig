// A run of thinking blocks drawn as one row, as compact-tools draws a tool call:
// "⦁ Thinking…" while it runs, then "⦁ Thinking (3.2k tokens · 12s)". Claude's thinking
// reaches Pi signed but empty (only its signature), which Pi otherwise draws as nothing.

export interface Block {
	type: string;
	thinking?: string;
	/** How long the block took, set by this extension when the message ends. */
	durationMs?: number;
	[key: string]: unknown;
}

export interface Message {
	role: string;
	content: Block[];
	usage?: { reasoning?: number };
	[key: string]: unknown;
}

export interface Row {
	running: boolean;
	tokens?: number;
	ms?: number;
}

// Pi passes thinking text through Markdown transformers; the row travels as this line.
const OPEN = "⟦pi-thinking-row ";
const CLOSE = "⟧";

export function tokens(n: number): string {
	if (n < 1000) return `${n} token${n === 1 ? "" : "s"}`;
	return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k tokens`;
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${Math.max(s, 1)}s`;
	const m = Math.floor(s / 60);
	return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

export function rowText(row: Row): string {
	if (row.running) return "⦁ Thinking…";
	const parts = [row.tokens ? tokens(row.tokens) : null, row.ms ? duration(row.ms) : null].filter(Boolean);
	return parts.length ? `⦁ Thinking (${parts.join(" · ")})` : "⦁ Thinking";
}

/**
 * The message as Pi should draw it: each run of thinking blocks becomes one block whose
 * text starts with the row's marker line, then any thinking text there was.
 */
export function displayMessage<M extends Message>(message: M, streaming: boolean): M {
	if (!message?.content?.some((b) => b.type === "thinking")) return message;
	const runs = message.content.reduce((n, b, i, all) => n + (b.type === "thinking" && all[i - 1]?.type !== "thinking" ? 1 : 0), 0);
	const content: Block[] = [];
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i]!;
		if (block.type !== "thinking") {
			content.push(block);
			continue;
		}
		const run: Block[] = [];
		while (message.content[i]?.type === "thinking") run.push(message.content[i++]!);
		i--;
		// Pi draws its last message again (a click, a resize): already a row.
		if (run[0]!.thinking?.startsWith(OPEN)) {
			content.push(...run);
			continue;
		}
		// Running until something follows it, or until the message ends.
		const last = i === message.content.length - 1;
		const ms = run.reduce((sum, b) => sum + (b.durationMs ?? 0), 0);
		const row: Row = {
			running: streaming && last && !ms,
			// The message's reasoning tokens are one figure: they label a lone run.
			tokens: runs === 1 ? message.usage?.reasoning || undefined : undefined,
			ms: ms || undefined,
		};
		const text = run.map((b) => (b.thinking ?? "").trim()).filter(Boolean).join("\n\n");
		content.push({ ...run[0]!, thinking: `${OPEN}${JSON.stringify(row)}${CLOSE}${text ? `\n\n${text}` : ""}` });
	}
	return { ...message, content };
}

/** Pi's thinking Markdown with the marker line turned into the row. */
export function renderMarkdown(markdown: string): string {
	const start = markdown.indexOf(OPEN);
	if (start < 0) return markdown;
	const end = markdown.indexOf(CLOSE, start);
	if (end < 0) return markdown;
	let row: Row;
	try {
		row = JSON.parse(markdown.slice(start + OPEN.length, end));
	} catch {
		return markdown;
	}
	return markdown.slice(0, start) + rowText(row) + markdown.slice(end + CLOSE.length);
}
