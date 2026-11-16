import assert from "node:assert/strict";
import { test } from "node:test";
import { callLines, forInner, NestedCalls, underRail } from "../codemode.ts";
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
