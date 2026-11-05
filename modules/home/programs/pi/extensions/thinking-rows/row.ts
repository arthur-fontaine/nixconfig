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
	/** The thinking of an opened run, in base64. */
	text?: string;
}

// Pi passes thinking text through Markdown transformers; the row travels as this line.
// compact-tools' transformer, before this one, keeps only a thinking's first line (restyled,
// without * _ ~ `), so an opened run's thinking travels inside it, in base64.
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

/** The row's figures, "(3.2k tokens · 12s)", or "…" while it runs. */
export function rowDetail(row: Row): string {
	if (row.running) return "…";
	const parts = [row.tokens ? tokens(row.tokens) : null, row.ms ? duration(row.ms) : null].filter(Boolean);
	return parts.length ? ` (${parts.join(" · ")})` : "";
}

export function rowText(row: Row): string {
	return `⦁ Thinking${rowDetail(row)}`;
}

/**
 * The message as Pi should draw it: each run of thinking blocks becomes one block whose
 * text is the row's marker line, followed by the thinking text when that run is open
 * (`open(n)`, n counting the runs from 0), as a tool row opens on a click.
 */
export function displayMessage<M extends Message>(message: M, streaming: boolean, open: (run: number) => boolean = () => false): M {
	if (!message?.content?.some((b) => b.type === "thinking")) return message;
	const runs = message.content.reduce((n, b, i, all) => n + (b.type === "thinking" && all[i - 1]?.type !== "thinking" ? 1 : 0), 0);
	const content: Block[] = [];
	let n = 0;
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
		if (open(n++) && text) row.text = Buffer.from(text, "utf8").toString("base64");
		content.push({ ...run[0]!, thinking: `${OPEN}${JSON.stringify(row)}${CLOSE}` });
	}
	return { ...message, content };
}

/** How the row is painted: as a tool row is, when the theme is known. */
export type Style = (row: Row) => string;

/** Pi's thinking Markdown with the marker line turned into the row. */
export function renderMarkdown(markdown: string, style: Style = rowText): string {
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
	const drawn = markdown.slice(0, start) + style(row) + markdown.slice(end + CLOSE.length);
	// After the row and whatever style wraps it: drawn as Pi draws thinking.
	return row.text ? `${drawn}\n\n${Buffer.from(row.text, "base64").toString("utf8")}` : drawn;
}

/** Whether a message is already this extension's copy of one (its runs are rows). */
export function isDisplayed(message: Message): boolean {
	return Boolean(message?.content?.some((b) => b.type === "thinking" && b.thinking?.startsWith(OPEN)));
}
