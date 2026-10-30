import assert from "node:assert/strict";
import { test } from "node:test";
import { conversation, prompts } from "../context.ts";
import { ReplayFilter } from "../history.ts";
import { MAX_CONVERSATION_CHARS, MAX_MESSAGE_CHARS } from "../prediction.ts";

test("the conversation keeps message text, tool names and summaries", () => {
	const turns = conversation([
		{ role: "compactionSummary", summary: "earlier work" },
		{ role: "user", content: "fix \u001b[1mit\u001b[0m" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "on it" }, { type: "toolCall", name: "bash" }] },
		{ role: "bashExecution", content: "ls" },
		{ role: "toolResult", content: [{ type: "image" }] },
	]);
	assert.deepEqual(turns, [
		{ role: "compactionSummary", text: "earlier work" },
		{ role: "user", text: "fix it" },
		{ role: "assistant", text: "on it\n[called bash]" },
	]);
});

test("each message keeps its last 2,000 characters and the whole stays under 10,000", () => {
	const long = "a".repeat(MAX_MESSAGE_CHARS - 1) + "z".repeat(10);
	const [turn] = conversation([{ role: "user", content: long }]);
	assert.equal(turn!.text.length, MAX_MESSAGE_CHARS);
	assert.ok(turn!.text.endsWith("z".repeat(10)));

	const many = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: String(i).repeat(MAX_MESSAGE_CHARS) }));
	const kept = conversation(many);
	assert.equal(kept.reduce((n, t) => n + t.text.length, 0), MAX_CONVERSATION_CHARS);
	assert.equal(kept.length, 5);
	assert.equal(kept.at(-1)!.text[0], "7");
});

test("history holds the branch's user prompts as Pi words them", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: " first " } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "image" }] } },
		{ type: "compaction", summary: "x" },
	] as never;
	assert.deepEqual(prompts(entries), ["first", "ab"]);
});

test("Pi's replay of in-context prompts is skipped once, in order", () => {
	const filter = new ReplayFilter(["b", "c"]);
	assert.equal(filter.skip("b"), true);
	assert.equal(filter.skip(" c "), true);
	assert.equal(filter.skip("c"), false);
});

test("anything other than the expected replay disarms the filter", () => {
	const filter = new ReplayFilter(["b", "c"]);
	assert.equal(filter.skip("new prompt"), false);
	assert.equal(filter.skip("b"), false);
	const typed = new ReplayFilter(["b"]);
	typed.disarm();
	assert.equal(typed.skip("b"), false);
});
