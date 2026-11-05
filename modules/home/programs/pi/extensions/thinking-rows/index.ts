// Thinking drawn as a row, like a tool call: "⦁ Thinking…", then "⦁ Thinking (3.2k tokens ·
// 12s)". The tokens are the response's reasoning tokens; the time is measured while the
// thinking streams and kept on its block in the session (durationMs), so a resumed session
// shows it too. A click opens the row on the thinking (summarized by the API), as a tool row
// opens on its details, and closes it again.
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayMessage, isDisplayed, renderMarkdown, type Message } from "./row.ts";

// Global, so a reloaded extension doesn't wrap Pi's component a second time.
const HOOK = Symbol.for("pi-extension-thinking-rows");
const OPENED = Symbol.for("pi-extension-thinking-rows.opened");
const SOURCE = Symbol.for("pi-extension-thinking-rows.source");
type Proto = { updateContent: (message: Message, streaming?: boolean) => void; [HOOK]?: true };

function hookComponent() {
	const proto = (AssistantMessageComponent as unknown as { prototype?: Proto } | undefined)?.prototype;
	// Checked rather than trusted: a Pi release may rename it.
	if (!proto || typeof proto.updateContent !== "function" || proto[HOOK]) return;
	const original = proto.updateContent;
	proto.updateContent = function (message, streaming) {
		// A click on a thinking run makes Pi flip it to hidden (thinkingVisibilityOverrides) and
		// draw the message again: taken here as opening or closing the run, and Pi's own state
		// put back, so it keeps drawing the row this extension gives it.
		const self = this as unknown as { thinkingVisibilityOverrides?: Map<number, boolean>; [OPENED]?: Set<number>; [SOURCE]?: Message };
		// Pi draws again from the last message it was given, which is this extension's copy
		// (without the text of a closed run): the message it came from is kept for that.
		if (isDisplayed(message) && self[SOURCE]) message = self[SOURCE];
		else self[SOURCE] = message;
		const opened = (self[OPENED] ??= new Set());
		const flips = self.thinkingVisibilityOverrides;
		if (flips instanceof Map) {
			for (const [run, hidden] of flips) if (hidden) opened.has(run) ? opened.delete(run) : opened.add(run);
			flips.clear();
		}
		return original.call(this, displayMessage(message, Boolean(streaming), (run) => opened.has(run)), streaming);
	};
	proto[HOOK] = true;
}

export default function (pi: ExtensionAPI) {
	hookComponent();

	pi.registerMarkdownTransformer((markdown, { messageType }) =>
		messageType === "assistant-thinking" ? renderMarkdown(markdown) : markdown,
	);

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
