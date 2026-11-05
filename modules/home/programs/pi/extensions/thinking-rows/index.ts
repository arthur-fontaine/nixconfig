// Thinking drawn as a row, like a tool call: "⦁ Thinking…", then "⦁ Thinking (3.2k tokens ·
// 12s)". The tokens are the response's reasoning tokens; the time is measured while the
// thinking streams and kept on its block in the session (durationMs), so a resumed session
// shows it too. A click opens the row on the thinking (summarized by the API), as a tool row
// opens on its details, and closes it again. The newest run stays open until another one
// comes, unless a click said otherwise.
import { AssistantMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { faint } from "./faint.ts";
import { displayMessage, isDisplayed, renderMarkdown, rowDetail, rowText, type Message, type Row } from "./row.ts";

// Pi draws thinking italic and compact-tools bolds its first line: both ended for the row.
const PLAIN = "\x1b[22;23m";

// Pi's own method, kept globally from the first load: a reload (/reload, a rebuild picked up
// without restarting) wraps it again with its own code, rather than keeping the first load's.
const ORIGINAL = Symbol.for("pi-extension-thinking-rows.original");
const OVERRIDES = Symbol.for("pi-extension-thinking-rows.opened");
const SOURCE = Symbol.for("pi-extension-thinking-rows.source");
const LATEST = Symbol.for("pi-extension-thinking-rows.latest");
type Update = (message: Message, streaming?: boolean) => void;
type Proto = { updateContent: Update; [ORIGINAL]?: Update };
type Self = {
	thinkingVisibilityOverrides?: Map<number, boolean>;
	/** Runs the user opened (true) or closed (false) by a click, over the default. */
	[OVERRIDES]?: Map<number, boolean>;
	[SOURCE]?: Message;
	updateContent: Update;
};
// The message with the newest thinking: its last run is open until another one comes. Messages
// are ordered as Pi first draws them, which is the transcript's order, resumed sessions included.
const shared = globalThis as unknown as { [LATEST]?: { self: Self; at: number } };
const order = new WeakMap<object, number>();
let drawn = 0;

const runsOf = (message: Message) =>
	message.content.reduce((n, b, i, all) => n + (b.type === "thinking" && all[i - 1]?.type !== "thinking" ? 1 : 0), 0);

function hookComponent() {
	const proto = (AssistantMessageComponent as unknown as { prototype?: Proto } | undefined)?.prototype;
	// Checked rather than trusted: a Pi release may rename it.
	if (!proto || typeof proto.updateContent !== "function") return;
	const original = (proto[ORIGINAL] ??= proto.updateContent);
	proto.updateContent = function (message, streaming) {
		const self = this as unknown as Self;
		// Pi draws again from the last message it was given, which is this extension's copy
		// (without the text of a closed run): the message it came from is kept for that.
		if (isDisplayed(message) && self[SOURCE]) message = self[SOURCE];
		else self[SOURCE] = message;
		const runs = message?.content ? runsOf(message) : 0;
		if (runs > 0) {
			if (!order.has(self)) order.set(self, ++drawn);
			const at = order.get(self)!;
			const latest = shared[LATEST];
			if (!latest || latest.self === self || at > latest.at) {
				shared[LATEST] = { self, at };
				// The one before closes its run, drawn again from its own message.
				if (latest && latest.self !== self && latest.self[SOURCE]) latest.self.updateContent(latest.self[SOURCE]);
			}
		}
		const isLatest = shared[LATEST]?.self === self;
		const shownByDefault = (run: number) => isLatest && run === runs - 1;
		// A click on a thinking run makes Pi flip it (thinkingVisibilityOverrides) and draw the
		// message again: taken here as opening or closing the run against what it showed, and
		// Pi's own state put back, so it keeps drawing the row this extension gives it.
		const overrides = (self[OVERRIDES] ??= new Map());
		const open = (run: number) => overrides.get(run) ?? shownByDefault(run);
		const flips = self.thinkingVisibilityOverrides;
		if (flips instanceof Map) {
			for (const [run, hidden] of flips) if (hidden) overrides.set(run, !open(run));
			flips.clear();
		}
		return original.call(this, displayMessage(message, Boolean(streaming), open), streaming);
	};
}

export default function (pi: ExtensionAPI) {
	hookComponent();

	// Painted as compact-tools paints a tool row, faint as tool-rows-faint makes those, and
	// not in Pi's italic thinking style, so a thinking row reads as one more step.
	let theme: Theme | undefined;
	const style = (row: Row) => {
		if (!theme) return rowText(row);
		const t = theme;
		const dot = row.running ? t.fg("muted", "⦁") : t.fg("success", "⦁");
		return PLAIN + faint(`${dot} ${t.fg("toolTitle", t.bold("Thinking"))}${t.fg("toolOutput", rowDetail(row))}`);
	};
	pi.registerMarkdownTransformer((markdown, { messageType }) =>
		messageType === "assistant-thinking" ? renderMarkdown(markdown, style) : markdown,
	);
	pi.on("session_start", async (_event, ctx) => {
		theme = ctx.ui.theme;
	});

	// contentIndex → when its thinking started, then how long it took, for the message streaming now.
	let started = new Map<number, number>();
	let took = new Map<number, number>();

	pi.on("message_start", async (event) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		started = new Map();
		took = new Map();
	});

	pi.on("message_update", async (event) => {
		const e = event.assistantMessageEvent as { type?: string; contentIndex?: number } | undefined;
		if (e?.contentIndex === undefined) return;
		if (e.type === "thinking_start") started.set(e.contentIndex, Date.now());
		if (e.type === "thinking_end" && started.has(e.contentIndex)) {
			const ms = Date.now() - started.get(e.contentIndex)!;
			took.set(e.contentIndex, ms);
			// On the streaming message too, so its row stops saying "Thinking…".
			const block = (event.message as unknown as Message).content?.[e.contentIndex];
			if (block?.type === "thinking") block.durationMs = ms;
		}
	});

	pi.on("message_end", async (event) => {
		const message = event.message as unknown as Message;
		if (message.role !== "assistant" || !took.size) return;
		const content = message.content.map((block, i) =>
			block.type === "thinking" && took.has(i) ? { ...block, durationMs: took.get(i) } : block,
		);
		took = new Map();
		return { message: { ...message, content } as unknown as typeof event.message };
	});
}
