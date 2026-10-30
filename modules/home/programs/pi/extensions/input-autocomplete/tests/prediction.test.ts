import assert from "node:assert/strict";
import { test } from "node:test";
import { Lru, MAX_SUGGESTION_CHARS, parseSuggestions, systemPrompt, typedAhead, wantsPrediction } from "../prediction.ts";

test("predicts on an empty draft or after a word or sentence ends", () => {
	for (const draft of ["", "fix the ", "done.", "why?", "a,", "see (x)", "line\n"]) assert.equal(wantsPrediction(draft), true, draft);
	for (const draft of ["fix the", "x", "path/to"]) assert.equal(wantsPrediction(draft), false, draft);
});

test("the system prompt names the draft only when there is one", () => {
	assert.doesNotMatch(systemPrompt(""), /The draft is exactly/);
	assert.match(systemPrompt('say "hi" '), /The draft is exactly "say \\"hi\\" "\./);
});

test("a reply is a JSON array of up to five distinct cleaned strings", () => {
	const reply = '```json\n["Run the tests", "Run the tests", " Commit it ", "\\"Ship it\\"", 3, "", "Continue", "Revert", "extra"]\n```';
	assert.deepEqual(parseSuggestions(reply, ""), ["Run the tests", "Commit it", "Ship it", "Continue", "Revert"]);
	assert.deepEqual(parseSuggestions("not json", ""), []);
	assert.deepEqual(parseSuggestions('{"a": "b"}', ""), []);
});

test("continuations drop a repeated draft and fit the draft's last character", () => {
	assert.deepEqual(parseSuggestions('["fix the bug", " the tests  ", "Continuation: it"]', "fix "), ["the bug", "the tests", "it"]);
	assert.deepEqual(parseSuggestions('[" Now add docs", "Ship it"]', "Done."), [" Now add docs", "Ship it"]);
});

test("suggestions lose terminal escapes and stop at 240 characters", () => {
	const [clean] = parseSuggestions(JSON.stringify(["\u001b[31mred\u001b[0m\u0007 text"]), "");
	assert.equal(clean, "red text");
	const [long] = parseSuggestions(JSON.stringify(["é".repeat(300)]), "");
	assert.equal(Array.from(long!).length, MAX_SUGGESTION_CHARS);
});

test("typing into a shown suggestion keeps the rest of it", () => {
	const shown = { conversation: "c", draft: "", suggestions: ["Run the tests", "Run it", "Commit"] };
	assert.deepEqual(typedAhead(shown, "c", "Run the "), ["tests"]);
	assert.deepEqual(typedAhead(shown, "c", "Run "), ["the tests", "it"]);
	assert.deepEqual(typedAhead(shown, "c", "Deploy "), []);
	assert.deepEqual(typedAhead(shown, "other", "Run "), []);
	assert.deepEqual(typedAhead(shown, "c", ""), []);
	assert.deepEqual(typedAhead(shown, "c", "Commit"), []);
});

test("the cache forgets the least recently used entry", () => {
	const cache = new Lru<number>(2);
	cache.set("a", 1);
	cache.set("b", 2);
	assert.equal(cache.get("a"), 1);
	cache.set("c", 3);
	assert.equal(cache.get("b"), undefined);
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.size, 2);
	cache.clear();
	assert.equal(cache.size, 0);
});
