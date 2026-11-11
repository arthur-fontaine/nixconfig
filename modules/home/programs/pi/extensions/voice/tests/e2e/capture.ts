// Test-only: records what reaches the main model, for the end-to-end harness.
// Every request of the agent loop goes to $VOICE_CAPTURE/requests.jsonl as the full transcript
// Pi sends (context_with_system: the leading system message with the prompt and tool
// declarations, then every message), and every streamed text delta of the assistant to
// deltas.jsonl, so the harness can prove the voice extension adds nothing to the model's
// context and changes nothing in the written answer. Loaded after the voice extension, so it
// sees the end of the handler chain. (context_with_system rather than before_provider_request:
// the claude-code provider doesn't expose the provider-payload stage.)
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dir = process.env.VOICE_CAPTURE;
	if (!dir) return;
	const write = (file: string, record: unknown) => appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
	pi.on("context_with_system", (event) => {
		write("requests.jsonl", { at: Date.now(), payload: { messages: event.messages } });
	});
	pi.on("message_update", (event) => {
		const e = event.assistantMessageEvent as { type: string; delta?: string; contentIndex?: number };
		if (e.type === "text_delta") write("deltas.jsonl", { at: Date.now(), index: e.contentIndex, delta: e.delta });
	});
	pi.on("message_end", (event) => {
		write("messages.jsonl", { at: Date.now(), message: event.message });
	});
}
