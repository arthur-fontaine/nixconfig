import assert from "node:assert/strict";
import { test } from "node:test";
import { request, TitleCache, titleOf, wantsTitle } from "../titles.ts";

test("short, simple commands are read as they are", () => {
	assert.equal(wantsTitle("ls -la"), false);
	assert.equal(wantsTitle("git status && git diff"), false);
	assert.equal(wantsTitle("cd a && make && make test && make install"), true);
	assert.equal(wantsTitle("python3 -c 'print(1)'\necho done"), true);
	assert.equal(wantsTitle("x".repeat(81)), true);
});

test("an answer becomes a short one-line title", () => {
	assert.equal(titleOf("Lists the largest session files."), "Lists the largest session files");
	assert.equal(titleOf("\"runs the unit tests\""), "Runs the unit tests");
	assert.equal(titleOf("Shows the current time, logged-in user, uptime, and a test echo"), "Shows the current time, logged-in user, uptime, and a test echo");
	assert.equal(titleOf("one two three four five six seven eight nine ten eleven twelve thirteen"), "One two three four five six seven eight nine ten eleven twelve…");
	assert.equal(titleOf("Lists files.\nThen sorts them."), "Lists files");
	assert.equal(titleOf(""), null);
});

test("a long command is sent as its head and tail", () => {
	const sent = request("a".repeat(3000), 1000);
	assert.ok(sent.length < 1100);
	assert.ok(sent.includes("…"));
});

test("the cache keeps the latest titles", () => {
	const cache = new TitleCache({}, 2);
	cache.set("one", "One");
	cache.set("two", "Two");
	cache.set("three", "Three");
	assert.equal(cache.get("one"), undefined);
	assert.equal(cache.get("three"), "Three");
	const again = new TitleCache(cache.toJSON());
	assert.equal(again.get("two"), "Two");
});
