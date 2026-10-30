// The conversation sent with each request and the prompt history, both read
// from session data. Type-only Pi imports, so the tests run without Pi.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_CONVERSATION_CHARS, MAX_MESSAGE_CHARS, type Turn } from "./prediction.ts";

// Loose on purpose: other extensions add their own message roles.
interface MessageLike {
	role: string;
	content?: unknown;
	summary?: unknown;
}

const TERMINAL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/gu;

function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block?.type === "toolCall" && typeof block.name === "string") parts.push(`[called ${block.name}]`);
	}
	return parts.join("\n");
}

function messageText(message: MessageLike): string {
	// Commands the person ran with `!` are their own, not something they said.
	if (message.role === "bashExecution") return "";
	if (typeof message.summary === "string") return message.summary;
	return blocksText(message.content);
}

// Newest first until the budget runs out; each message keeps its end, where
// the part that matters for the next turn usually is.
export function conversation(messages: readonly MessageLike[]): Turn[] {
	const turns: Turn[] = [];
	let left = MAX_CONVERSATION_CHARS;
	for (let i = messages.length - 1; i >= 0 && left > 0; i--) {
		const message = messages[i]!;
		const text = messageText(message).replace(TERMINAL, "");
		if (!text) continue;
		const kept = text.slice(-Math.min(MAX_MESSAGE_CHARS, left));
		turns.push({ role: message.role, text: kept });
		left -= kept.length;
	}
	return turns.reverse();
}

// The text Pi itself puts in the editor history for a user message.
export function promptText(entry: SessionEntry): string {
	if (entry.type !== "message" || entry.message.role !== "user") return "";
	const content = entry.message.content;
	if (typeof content === "string") return content.trim();
	return content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
}

export function prompts(entries: readonly SessionEntry[]): string[] {
	return entries.map(promptText).filter(Boolean);
}
