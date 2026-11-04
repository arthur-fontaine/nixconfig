import assert from "node:assert/strict";
import { test } from "node:test";
import { displayMessage, duration, renderMarkdown, rowText, tokens } from "../row.ts";

const sig = { thinkingSignature: "x".repeat(10) };

test("figures read short", () => {
	assert.equal(tokens(1), "1 token");
	assert.equal(tokens(170), "170 tokens");
	assert.equal(tokens(3240), "3.2k tokens");
	assert.equal(tokens(16000), "16k tokens");
	assert.equal(duration(400), "1s");
	assert.equal(duration(12_300), "12s");
	assert.equal(duration(125_000), "2m 5s");
	assert.equal(rowText({ running: true }), "⦁ Thinking…");
	assert.equal(rowText({ running: false, tokens: 3240, ms: 12_000 }), "⦁ Thinking (3.2k tokens · 12s)");
	assert.equal(rowText({ running: false }), "⦁ Thinking");
});

test("an empty signed thinking block becomes a row with the response's tokens and its time", () => {
	const message = {
		role: "assistant",
		usage: { reasoning: 170 },
		content: [{ type: "thinking", thinking: "", ...sig, durationMs: 6000 }, { type: "text", text: "Done." }],
	};
	const shown = displayMessage(message, false);
	assert.equal(shown.content.length, 2);
	assert.equal(renderMarkdown(shown.content[0]!.thinking!), "⦁ Thinking (170 tokens · 6s)");
	assert.equal(shown.content[0]!.thinkingSignature, sig.thinkingSignature);
	// The session's message is untouched.
	assert.equal(message.content[0]!.thinking, "");
	// Drawn again from Pi's last message: the same row, not a row of a row.
	assert.deepEqual(displayMessage(shown, false), shown);
});

test("a run still streaming says so; one followed by text has ended", () => {
	const streaming = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking: "" }] }, true);
	assert.equal(renderMarkdown(streaming.content[0]!.thinking!), "⦁ Thinking…");
	const after = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hi" }] }, true);
	assert.equal(renderMarkdown(after.content[0]!.thinking!), "⦁ Thinking");
});

test("thinking text stays under the row, and several runs share no token count", () => {
	const shown = displayMessage({
		role: "assistant",
		usage: { reasoning: 900 },
		content: [
			{ type: "thinking", thinking: "First idea." },
			{ type: "thinking", thinking: "Second." },
			{ type: "toolCall", id: "1" },
			{ type: "thinking", thinking: "", durationMs: 2000 },
		],
	}, false);
	assert.equal(shown.content.length, 3);
	assert.equal(renderMarkdown(shown.content[0]!.thinking!), "⦁ Thinking\n\nFirst idea.\n\nSecond.");
	assert.equal(renderMarkdown(shown.content[2]!.thinking!), "⦁ Thinking (2s)");
});

test("other Markdown is left alone", () => {
	assert.equal(renderMarkdown("plain *thinking*"), "plain *thinking*");
});
