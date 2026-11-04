// Thinking drawn as a row, like a tool call: "⦁ Thinking…", then "⦁ Thinking (3.2k tokens ·
// 12s)". The tokens are the response's reasoning tokens; the time is measured while the
// thinking streams and kept on its block in the session (durationMs), so a resumed session
// shows it too. Any thinking text still shows under the row.
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayMessage, renderMarkdown, type Message } from "./row.ts";

// Global, so a reloaded extension doesn't wrap Pi's component a second time.
const HOOK = Symbol.for("pi-extension-thinking-rows");
type Proto = { updateContent: (message: Message, streaming?: boolean) => void; [HOOK]?: true };

function hookComponent() {
	const proto = (AssistantMessageComponent as unknown as { prototype?: Proto } | undefined)?.prototype;
	// Checked rather than trusted: a Pi release may rename it.
	if (!proto || typeof proto.updateContent !== "function" || proto[HOOK]) return;
	const original = proto.updateContent;
	proto.updateContent = function (message, streaming) {
		return original.call(this, displayMessage(message, Boolean(streaming)), streaming);
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
