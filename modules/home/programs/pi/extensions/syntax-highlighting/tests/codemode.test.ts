import assert from "node:assert/strict";
import { test } from "node:test";
import { callLines, forInner, NestedCalls, previewOf, scriptLines, scriptTitle, underRail } from "../codemode.ts";
import { fakePaint, markup, stripAnsi } from "./paint.ts";

const paint = fakePaint();
const noTitle = () => undefined;

test("a script's calls are named as their own rows would be, from the events' full arguments", () => {
	const calls = new NestedCalls();
	const long = `python3 - <<'EOF'\n${"print(1)\n".repeat(2000)}EOF`;
	calls.start("toolu_1", "toolu_1/1", "read", { path: "a.txt" });
	calls.start("toolu_1", "toolu_1/2", "edit", { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
	calls.start("toolu_1", "toolu_1/3", "write", { path: "b.txt", content: "x\n".repeat(5000) });
	calls.start("toolu_1", "toolu_1/4", "bash", { command: long });
	calls.start("toolu_1", "toolu_1/5", "web_search", { query: "pi codemode" });
	for (const n of [1, 2, 3, 5]) calls.end("toolu_1", `toolu_1/${n}`, false);
	calls.end("toolu_1", "toolu_1/4", true, "Command exited with code 1\nmore");
	// A long command keeps its whole text, so bash-titles' title for it is found.
	const titles = (command: string) => (command === long ? "Prints one many times" : undefined);
	const lines = callLines(paint, calls.of("toolu_1"), titles, "/repo", true).map(stripAnsi);
	assert.deepEqual(lines, [
		"Read(a.txt)",
		"Update(a.txt)",
		"Write(b.txt)",
		"✗ Bash(Prints one many times)",
		"  Command exited with code 1 …",
		"web_search(pi codemode)",
	]);
	assert.equal(markup(callLines(paint, calls.of("toolu_1"), titles, "/repo", true)[0]!), "[title:Read][output:(a.txt)]");
});

test("an untitled command shows its first line, without the cd into the working directory", () => {
	const calls = new NestedCalls();
	calls.start("toolu_1", "toolu_1/1", "bash", { command: "cd /repo && make test\nmake lint" });
	assert.deepEqual(callLines(paint, calls.of("toolu_1"), noTitle, "/repo", false).map(stripAnsi), ["Bash(make test …) …"]);
});

test("collapsed, a long list keeps its first calls and counts the others", () => {
	const calls = new NestedCalls();
	for (let n = 1; n <= 9; n++) calls.start("toolu_1", `toolu_1/${n}`, "read", { path: `${n}.txt` });
	const lines = callLines(paint, calls.of("toolu_1"), noTitle, "/", false).map(stripAnsi);
	assert.equal(lines.length, 5);
	assert.equal(lines[4], "… +5 more calls (ctrl+o to expand)");
	assert.equal(callLines(paint, calls.of("toolu_1"), noTitle, "/", true).length, 9);
});

test("a resumed session gets the calls from the saved result, unless they were seen live", () => {
	const calls = new NestedCalls();
	const message = {
		role: "toolResult",
		toolCallId: "toolu_2",
		nestedCalls: { calls: [{ id: "toolu_2/1", name: "write", arguments: { path: "c.txt" }, status: "ok" }, { id: "toolu_2/2", name: "bash", status: "unfinished" }] },
	};
	assert.equal(calls.restore(message), true);
	assert.deepEqual(callLines(paint, calls.of("toolu_2"), noTitle, "/", false).map(stripAnsi), ["Write(c.txt)", "⊘ Bash"]);
	calls.start("toolu_3", "toolu_3/1", "read", { path: "live.txt" });
	assert.equal(calls.restore({ ...message, toolCallId: "toolu_3" }), false);
	assert.equal(calls.of("toolu_3")[0]!.target, "live.txt");
	// Calls made by a nested tool belong to the script's row.
	calls.start("toolu_3/1", "toolu_3/1/1", "read", { path: "deeper.txt" });
	assert.equal(calls.of("toolu_3").length, 2);
});

test("the calls go first under the result's rail, its output after them in the same column", () => {
	const rail = `   ${paint.fg("muted", "⎿")}  `;
	const drawn = ["", `${rail}${paint.fg("toolOutput", "5 lines")}`, `      ${paint.fg("muted", "Done in 0.1s")}`];
	const out = underRail(drawn, ["Read(a.txt)", "Bash(ls)"], "      ").map(stripAnsi);
	assert.deepEqual(out, ["", "   ⎿  Read(a.txt)", "      Bash(ls)", "      5 lines", "      Done in 0.1s"]);
	assert.deepEqual(underRail(["output"], ["Read(a.txt)"], "  ").map(stripAnsi), ["  Read(a.txt)", "output"]);
});

test("the renderers after this one get the output without Pi's header and calls, as the same objects each time", () => {
	const result = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: "5 total" },
		],
		details: { calls: [{ id: "toolu_1/1", name: "read", args: "{}", status: "ok" }], fullOutputPath: "/tmp/x" },
	};
	const inner = forInner(result);
	assert.deepEqual(inner.content, [{ type: "text", text: "5 total" }]);
	assert.deepEqual(inner.details, { calls: [], fullOutputPath: "/tmp/x" });
	const again = forInner({ ...result });
	assert.equal(again.content, inner.content);
	assert.equal(again.details, inner.details);
	// A failed script before it ran has no header to drop.
	assert.equal(forInner({ content: [{ type: "text", text: "Invalid options" }] }).content.length, 1);
});

test("an opened row's script is drawn in JavaScript colors, tabs as Pi draws them", () => {
	const paint = fakePaint();
	const lines = scriptLines(paint, "const a = 1;\n\treturn a;\n");
	assert.deepEqual(paint.calls, ["javascript:const a = 1;\n   return a;"]);
	assert.equal(markup(lines[0]!), "[keyword:const] a = 1;");
	assert.deepEqual(scriptLines(fakePaint({ javascript: false }), "x\ny").map(stripAnsi), ["x", "y"]);
});

test("saved results count toward the bound on scripts kept", () => {
	const calls = new NestedCalls();
	for (let n = 0; n < 600; n++) calls.restore({ role: "toolResult", toolCallId: `t${n}`, nestedCalls: { calls: [{ id: `t${n}/1`, name: "read", status: "ok" }] } });
	assert.equal(calls.of("t0").length, 0);
	assert.equal(calls.of("t599").length, 1);
});

test("a failed script leads with its error, which compact-tools makes the row's headline", () => {
	// As Pi saves it: the output and the error in one text.
	const inner = forInner({
		content: [
			{ type: "text", text: "Script failed\nWall time 3.1 seconds\nOutput:\n" },
			{ type: "text", text: "partial\n<console_output>\nno file\n</console_output>\nScript error:\nError: boom on purpose\n    at <anonymous> (codemode.js:4:11)" },
		],
	});
	assert.deepEqual(inner.content, [
		{ type: "text", text: "Error: boom on purpose\n    at <anonymous> (codemode.js:4:11)" },
		{ type: "text", text: "partial\n<console_output>\nno file\n</console_output>" },
	]);
	// Without output, the error alone.
	const alone = forInner({ content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "Script error:\nSyntaxError: x" }] });
	assert.deepEqual(alone.content, [{ type: "text", text: "SyntaxError: x" }]);
});

test("a script bash-titles doesn't name is titled by its calls, never by a variable it sets", () => {
	const code = 'const S = "/opt/pi/dist";\nconst r = await tools.bash({ command: `cd ${S}; grep -rn retry .` });\nreturn r.output;';
	const calls = new NestedCalls();
	// Before its first call starts: no first line.
	assert.equal(scriptTitle(code, calls.of("toolu_1"), noTitle, "/repo"), "…");
	calls.start("toolu_1", "toolu_1/1", "bash", { command: "cd /opt/pi/dist; grep -rn retry ." });
	// One call: that call's own title, or its command when it has none.
	const titled = (command: string) => (command.includes("grep") ? "Lists retryable-error matches in Pi's source" : undefined);
	assert.equal(scriptTitle(code, calls.of("toolu_1"), titled, "/repo"), "Lists retryable-error matches in Pi's source");
	assert.equal(scriptTitle(code, calls.of("toolu_1"), noTitle, "/repo"), "cd /opt/pi/dist; grep -rn retry .");
	// A read names its file.
	const read = new NestedCalls();
	read.start("toolu_2", "toolu_2/1", "read", { path: "config.ts" });
	assert.equal(scriptTitle("const p = 'config.ts';\nreturn tools.read({ path: p });", read.of("toolu_2"), noTitle, "/repo"), "Read config.ts");
	// Several: the tools they used, until Haiku's title comes.
	read.start("toolu_2", "toolu_2/2", "edit", { path: "config.ts" });
	read.start("toolu_2", "toolu_2/3", "read", { path: "b.ts" });
	assert.equal(scriptTitle("x", read.of("toolu_2"), noTitle, "/repo"), "Read, Update");
	// Resumed without its arguments (over Pi's 8 KB), a call still names its tool.
	const dropped = new NestedCalls();
	dropped.restore({ role: "toolResult", toolCallId: "toolu_3", nestedCalls: { calls: [{ id: "toolu_3/1", name: "bash", argumentsBytes: 9000, status: "ok" }] } });
	assert.equal(scriptTitle(code, dropped.of("toolu_3"), noTitle, "/repo"), "Bash");
	// A script calling no tool is short and plain: its line is the title.
	assert.equal(scriptTitle("return 6 * 7;", [], noTitle, "/repo"), undefined);
	// While it is being written, nothing of it: its first line would flash by.
	assert.equal(scriptTitle("const S = '/opt';", [], noTitle, "/repo", false), "…");
});

test("a bash call previews its output under it, unless the script's own output shows those lines", () => {
	const calls = new NestedCalls();
	calls.start("toolu_1", "toolu_1/1", "bash", { command: "wc -l a.txt" });
	calls.start("toolu_1", "toolu_1/2", "bash", { command: "npm test" });
	calls.end("toolu_1", "toolu_1/1", false, "12 a.txt");
	calls.end("toolu_1", "toolu_1/2", false, "> test\n" + "x".repeat(900) + "\nok 1\nok 2\n");
	// The script returned only the count: the test run gets its preview, cut and counted.
	const lines = callLines(paint, calls.of("toolu_1"), noTitle, "/repo", false, "12 a.txt").map(stripAnsi);
	assert.deepEqual(lines, ["Bash(wc -l a.txt)", "Bash(npm test)", "  │ > test", `  │ ${"x".repeat(300)}`, "  │ … +2 lines"]);
	// A call printing nothing has no preview; one whose output the script returned neither.
	assert.equal(previewOf("(no output)"), undefined);
	assert.equal(previewOf("\n \n"), undefined);
});

test("the previews are kept in the result's details, restored from them, and hidden from the inner renderers", () => {
	const live = new NestedCalls();
	live.start("toolu_1", "toolu_1/1", "bash", { command: "npm test" });
	live.end("toolu_1", "toolu_1/1", false, "ok 1\nok 2\nok 3");
	const callOutputs = live.outputs("toolu_1");
	assert.deepEqual(callOutputs, { "toolu_1/1": { lines: ["ok 1", "ok 2"], total: 3 } });
	const saved = {
		role: "toolResult",
		toolCallId: "toolu_1",
		nestedCalls: { calls: [{ id: "toolu_1/1", name: "bash", arguments: { command: "npm test" }, status: "ok" }] },
		details: { callOutputs, fileChanges: [] },
	};
	const resumed = new NestedCalls();
	assert.equal(resumed.restore(saved), true);
	assert.deepEqual(callLines(paint, resumed.of("toolu_1"), noTitle, "/repo", false).map(stripAnsi), ["Bash(npm test)", "  │ ok 1", "  │ ok 2", "  │ … +1 line"]);
	const result = { content: [{ type: "text", text: "done" }], details: saved.details };
	const inner = forInner(result);
	assert.deepEqual(inner.details, { fileChanges: [] });
	assert.equal(forInner(result).details, inner.details);
});
