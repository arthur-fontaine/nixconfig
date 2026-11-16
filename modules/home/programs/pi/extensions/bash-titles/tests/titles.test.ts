import assert from "node:assert/strict";
import { test } from "node:test";
import { request, SCRIPT_SYSTEM, scriptKey, scriptRequest, TitleCache, titleOf, wantsScriptTitle, wantsTitle } from "../titles.ts";

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
	const long = "Commits the Apple bootstrap script fix, retrying app checks while the app store keeps the download pending";
	assert.equal(titleOf(long), long);
	assert.equal(titleOf("one two three four five six seven eight nine ten eleven twelve thirteen"), "One two three four five six seven eight nine ten eleven twelve thirteen");
	// A runaway answer is still capped, far above what a title needs.
	const runaway = titleOf("word ".repeat(100))!;
	assert.ok(runaway.length <= 150 && runaway.length > 120 && !runaway.endsWith("…") && !runaway.endsWith(" "));
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

test("a title cut by the old word limit is asked for again", () => {
	const cache = new TitleCache({});
	cache.set("make all", "Commits the Apple bootstrap script fix, retrying app checks while the app…");
	assert.equal(cache.get("make all"), undefined);
	assert.equal(cache.stale("make all"), true);
	cache.set("make all", "Commits the Apple bootstrap script fix");
	assert.equal(cache.get("make all"), "Commits the Apple bootstrap script fix");
	assert.equal(cache.stale("make all"), false);
	assert.equal(cache.stale("unknown"), false);
});

test("a codemode script gets a title when it makes several calls or does more than one", () => {
	const one = 'return await tools.bash({ command: "wc -l a.txt b.txt" });';
	assert.equal(wantsScriptTitle(one), false);
	// One call is named by the call's own line under the row, however long its arguments.
	assert.equal(wantsScriptTitle(`// @options: {"timeout_ms": 1000}\nawait tools.write({ path: "x", content: \`${"line\n".repeat(30)}\` });`), false);
	assert.equal(wantsScriptTitle('const a = await tools.read({ path: "a" });\nawait tools.edit({ path: "a", edits: [] });'), true);
	assert.equal(wantsScriptTitle("const xs = [1, 2, 3];\nconst ys = xs.map((x) => x * 2);\nconst s = ys.reduce((a, b) => a + b);\nreturn s;"), true);
	assert.equal(wantsScriptTitle("return 1 + 1;"), false);
});

test("scripts and commands have their own cache keys and requests", () => {
	assert.notEqual(scriptKey("ls"), "ls");
	const sent = scriptRequest('// @options: {"timeout_ms": 1000}\nreturn await tools.bash({ command: "ls" });');
	assert.ok(!sent.includes("@options"));
	assert.ok(SCRIPT_SYSTEM.includes("JavaScript"));
});
