import assert from "node:assert/strict";
import { test } from "node:test";

import { CATEGORIES, NEVER_ACT, POLICY } from "../policy.ts";
import { COMPACT_V2 } from "../prompt.ts";
import { SUMMARIZER, summaryRequest, systemPromptV2 } from "../summarizer.ts";
import { agentReply, clipState, clipStateV2, request, requestV2 } from "../task.ts";
import { clip, clipEnd, cleanPrompt, estimateTokens, messages, render } from "../text.ts";
import * as tree from "../tree.ts";
import { FIXTURES } from "./fixtures/parity.js";

// Each value below was computed by the Python pipeline (cc-mod-auto-compact's
// training/scripts/make_fixtures.py): the extension must clip, group, summarize and ask exactly as
// training did. The fixture is copied verbatim from the mod's tests/fixtures/parity.js.

const F = FIXTURES as any;

test("clip keeps both ends within the byte and token budgets, as Python does", () => {
	for (const c of F.clip) assert.equal(clip(c.text, c.maxBytes, c.maxTokens), c.out);
});

test("the token estimate matches", () => {
	for (const c of F.tokens) assert.equal(estimateTokens(c.text), c.tokens);
});

test("the prompt filter keeps what the user typed and drops the rest", () => {
	for (const c of F.prompts) assert.equal(cleanPrompt(c.text), c.out);
});

test("transcript rows group into the same messages and render the same", () => {
	const msgs = messages(F.rows);
	assert.deepEqual(msgs, F.messages);
	assert.deepEqual(msgs.map(render), F.rendered);
});

test("views and the nodes they need are the same", () => {
	for (const v of F.views) assert.deepEqual(tree.view(v.t).map(tree.name), v.lines);
	for (const v of F.contextViews) {
		assert.deepEqual(tree.view(v.t, tree.CONTEXT.leaves, tree.CONTEXT.coarse).map(tree.name), v.lines);
	}
	for (const n of F.needed) assert.deepEqual(tree.needed([tree.view(n.t)]).map(tree.name), n.order);
});

test("summary requests are built like the Python summarizer builds them", () => {
	const msgs = messages(F.rows);
	const context: [tree.Node, string][] = [[[0, 0], "user: Add a --verbose flag"], [[0, 1], "task: verbose flag [in-progress] reads src/cli.py"]];
	const leaf = tree.leafPrompt(2, render(msgs[0]!), context);
	assert.equal(leaf, F.summaryPrompts.leaf);
	assert.equal(tree.mergePrompt([1, 2], [1, 3], "task: a [done]", "task: b [started]", context), F.summaryPrompts.merge);
	assert.equal(tree.retryPrompt(leaf, "é".repeat(300) + "z".repeat(30)), F.summaryPrompts.retry);
	assert.deepEqual(SUMMARIZER, F.summarizer);
	assert.deepEqual(summaryRequest(leaf, F.compactPrompt), F.summaryRequest);
});

test("states are clipped to the same budgets and the request is the same", () => {
	for (const s of F.states) assert.deepEqual(clipState(s.conversation, s.message), s.state);
	const conversation = F.states[0].conversation;
	assert.deepEqual(request(clipState(conversation, "now the README"), "spisev-alpha"), F.request);
});

test("the policy table is policy.py", () => {
	assert.deepEqual(POLICY, F.policy);
	assert.deepEqual([...NEVER_ACT].sort(), F.neverAct);
	assert.deepEqual(CATEGORIES, F.categories);
});

test("v2: the batched memory views and the nodes they need are the same", () => {
	for (const v of F.v2.memoryViews) assert.deepEqual(tree.memoryView(v.t).map(tree.name), v.lines);
	for (const n of F.v2.neededMemory) assert.deepEqual(tree.neededMemory([tree.memoryView(n.t)]).map(tree.name), n.order);
});

test("v2: the agent's last reply is filtered and clipped the same, and the state is the same", () => {
	for (const c of F.v2.clipEnd) assert.equal(clipEnd(c.text, c.maxBytes), c.out);
	for (const r of F.v2.replies) assert.equal(agentReply(r.message), r.out);
	for (const s of F.v2.states) assert.deepEqual(clipStateV2(s.memory, s.last, s.message), s.state);
	const conversation = F.states[0].conversation;
	assert.deepEqual(requestV2(clipStateV2(conversation, "Done.", "now the README"), "spisev-alpha"), F.v2.request);
});

test("v2: the summary prompt and its retry are the same", () => {
	assert.equal(COMPACT_V2, F.v2.promptTemplate);
	assert.equal(systemPromptV2(F.v2.promptTemplate, 160), F.v2.prompt160);
	assert.equal(tree.retryPrompt(F.v2.leaf, "é".repeat(100) + "z".repeat(30), 160), F.v2.retry);
	for (const c of F.v2.cleanLines) assert.equal(tree.cleanLineV2(c.text), c.out);
});
