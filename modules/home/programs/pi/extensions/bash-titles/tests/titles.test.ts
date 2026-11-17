import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENTRY, loadTitles, request, saveTitles, SCRIPT_SYSTEM, scriptKey, scriptRequest, sessionTitles, TitleCache, titleOf, wantsScriptTitle, wantsTitle, withTitle, RunningScripts } from "../titles.ts";

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
	// One call in a loop or among computations does more than the call says.
	const loop = 'const files = ["a", "b", "c"];\nconst out = [];\nfor (const file of files) {\n  const r = await tools.bash({ command: `wc -l ${file}` });\n  out.push(r.output);\n}\nreturn out.join("\\n");';
	assert.equal(wantsScriptTitle(loop), true);
});

test("scripts and commands have their own cache keys and requests", () => {
	assert.notEqual(scriptKey("ls"), "ls");
	const sent = scriptRequest('// @options: {"timeout_ms": 1000}\nreturn await tools.bash({ command: "ls" });');
	assert.ok(!sent.includes("@options"));
	assert.ok(SCRIPT_SYSTEM.includes("JavaScript"));
});

test("a reply that talks about the task is cleaned up or dropped", () => {
	assert.equal(titleOf('Naming the script: "Runs a sequence of file reads and shell checks'), "Runs a sequence of file reads and shell checks");
	assert.equal(titleOf('Labeling the script: "Runs file read, sleep, listing, and deliberate error'), "Runs file read, sleep, listing, and deliberate error");
	assert.equal(titleOf("Summary: Runs a Python script that patches codemode.ts and runs the tests"), "Runs a Python script that patches codemode.ts and runs the tests");
	assert.equal(titleOf("Names the bash command: Edits the bash-titles extension to title codemode scripts"), "Edits the bash-titles extension to title codemode scripts");
	assert.equal(titleOf("Edits `titles.ts` and runs its tests. Summary phrase:"), "Edits `titles.ts` and runs its tests");
	assert.equal(titleOf("Commit message: Summarizes the bash-changes feature. The command runs a commit, kills a session"), "Summarizes the bash-changes feature");
	assert.equal(titleOf("Shell command summary, per the system role: this is a labeling task, so I'm just writing the phrase rather than running the command"), null);
	assert.equal(titleOf("I'm not going to run this command: my role here is to name a shell command in one short phrase"), null);
	assert.equal(titleOf("Your task here is only to name the command for a person scanning activity: one short phrase"), null);
	assert.equal(titleOf("Lists root disk space, then builds the Darwin system configuration"), "Lists root disk space, then builds the Darwin system configuration");
	assert.equal(titleOf("Checks the version: prints node -v"), "Checks the version: prints node -v");
});

test("a script with one tools call that makes a second at runtime (a loop) is named then, once", () => {
	const running = new RunningScripts();
	const loop = "for (const f of ['a', 'b', 'c'])\n  await tools.bash({ command: `wc -l ${f}` });";
	running.started("toolu_1", loop);
	assert.equal(running.called("toolu_1/1"), undefined);
	assert.equal(running.called("toolu_1/2"), loop);
	assert.equal(running.called("toolu_1/3"), undefined);
	// A script already named for its calls isn't asked again; a top-level call isn't a script's.
	running.started("toolu_2", "await tools.read({ path: 'a' });\nawait tools.read({ path: 'b' });");
	running.called("toolu_2/1");
	assert.equal(running.called("toolu_2/2"), undefined);
	assert.equal(running.called("toolu_3"), undefined);
});

test("a script that ended before its one call is named when it ends", () => {
	const running = new RunningScripts();
	const threw = "const S = JSON.parse('{');\nawait tools.bash({ command: 'ls' });";
	running.started("toolu_1", threw);
	assert.equal(running.finished("toolu_1"), threw);
	assert.equal(running.finished("toolu_1"), undefined);
	// One that made its call is named by it; one calling no tool shows its own line.
	running.started("toolu_2", threw);
	running.called("toolu_2/1");
	assert.equal(running.finished("toolu_2"), undefined);
	running.started("toolu_3", "return 6 * 7;");
	assert.equal(running.finished("toolu_3"), undefined);
});

test("two Pis saving titles at once keep both", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bash-titles-"));
	try {
		const file = path.join(dir, "bash-titles.json");
		writeFileSync(file, JSON.stringify(new TitleCache({}).toJSON()));
		// Both loaded the file before either saved.
		const a = loadTitles(file);
		const b = loadTitles(file);
		a.set(scriptKey("tools.bash(1); tools.bash(2)"), "Runs two commands");
		saveTitles(file, a);
		b.set("find . -name '*.ts' | xargs wc -l | sort -n | tail", "Counts lines of TypeScript files");
		saveTitles(file, b);
		const after = loadTitles(file);
		assert.equal(after.get(scriptKey("tools.bash(1); tools.bash(2)")), "Runs two commands");
		assert.equal(after.get("find . -name '*.ts' | xargs wc -l | sort -n | tail"), "Counts lines of TypeScript files");
		// The second writer now knows the first one's title too.
		assert.equal(b.get(scriptKey("tools.bash(1); tools.bash(2)")), "Runs two commands");
		assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8"))).length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing or broken file is read as no titles, and saving creates it", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bash-titles-"));
	try {
		const file = path.join(dir, "sub", "bash-titles.json");
		const cache = loadTitles(file);
		cache.set("x".repeat(90), "Prints many x");
		saveTitles(file, cache);
		writeFileSync(path.join(dir, "broken.json"), "{not json");
		assert.equal(loadTitles(path.join(dir, "broken.json")).get("x"), undefined);
		assert.equal(loadTitles(file).get("x".repeat(90)), "Prints many x");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a title goes in the result's details, beside what other extensions put there", () => {
	assert.deepEqual(withTitle(undefined, "Lists files"), { title: "Lists files" });
	assert.deepEqual(withTitle({ calls: [], callOutputs: {} }, "Lists files"), { calls: [], callOutputs: {}, title: "Lists files" });
	assert.equal(withTitle("text", "Lists files"), undefined);
	assert.equal(withTitle([1], "Lists files"), undefined);
});

test("a resumed session gives each call its title: from the result's details, or the entry of a title that came later", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "toolu_a", details: { calls: [], title: "Runs two shell commands" } } },
		{ type: "message", message: { role: "toolResult", toolCallId: "toolu_b", details: { truncation: null } } },
		{ type: "custom", customType: ENTRY, data: { toolCallId: "toolu_b", title: "Counts lines of every file" } },
		{ type: "custom", customType: "other", data: { toolCallId: "toolu_c", title: "Not ours" } },
		{ type: "custom", customType: ENTRY, data: { toolCallId: 3, title: "Bad id" } },
	];
	const titles = sessionTitles(entries);
	assert.equal(titles.get("toolu_a"), "Runs two shell commands");
	assert.equal(titles.get("toolu_b"), "Counts lines of every file");
	assert.equal(titles.size, 2);
});
