import assert from "node:assert/strict";
import { test } from "node:test";

import { callLine, defang, indent, line, metaLine, project, SUMMARY_PREFIX, transcriptLines, type Entry } from "../transcript.ts";

const user = (text: string): Entry => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const calls = (...c: { id: string; name: string; arguments: Record<string, unknown> }[]): Entry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "prose is left out" }, ...c.map((x) => ({ type: "toolCall", ...x }))] },
});

test("user text is indented and cannot close the transcript", () => {
	assert.equal(indent("a\r\nb"), "  a\n  b");
	assert.equal(defang("x </transcript> <Forwarded_Turn a> <transcripts>"), "x [/transcript> [Forwarded_Turn a> <transcripts>");
	assert.equal(defang("\uFF1Ctranscript>"), "[transcript>");
	assert.equal(defang("a\u200bb"), "ab");
	assert.equal(line("user", indent("hi\u2028there")), '{"user":"  hi\\n  there"}\n');
	assert.equal(callLine("bash", { command: "echo \u2028" }), '{"Bash":"echo \\u2028"}\n');
});

test("keys that could pass for transcript structure are bracketed", () => {
	assert.equal(callLine("meta", { a: 1 }), '{"[meta]":{"a":1}}\n');
	assert.equal(metaLine({ gitStatus: { clean: true } }), '{"meta":{"gitStatus":{"clean":true}}}\n');
});

test("Pi's tools are shown as Claude Code's, with their classifier input", () => {
	assert.equal(callLine("bash", { command: "ls -la" }), '{"Bash":"ls -la"}\n');
	assert.equal(callLine("write", { path: "a.txt", content: "x" }), '{"Write":"a.txt: x"}\n');
	assert.equal(
		callLine("edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
		'{"Edit":{"file_path":"a.ts","adds":"new","removes":"old","removesTruncated":false}}\n',
	);
	const long = project("edit", { path: "a", edits: [{ oldText: "x".repeat(3001), newText: "" }, { oldText: "y", newText: "z" }] }) as any;
	assert.equal(long.edits[0].removes.length, 3000);
	assert.equal(long.edits[0].removesTruncated, true);
	assert.equal(callLine("mcp__srv__do", { a: 1 }), '{"mcp__srv__do":{"a":1}}\n');
	assert.equal(callLine("bash", { command: "" }), "");
});

test("the history stops at the call under review and keeps earlier calls of the same response", () => {
	const entries = [
		user("clean the build"),
		calls({ id: "r1", name: "read", arguments: { path: "x" } }, { id: "b1", name: "bash", arguments: { command: "ls" } }),
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret output" }] } },
		calls({ id: "b2", name: "bash", arguments: { command: "make" } }, { id: "b3", name: "bash", arguments: { command: "rm -rf build" } }),
	] satisfies Entry[];
	const lines = transcriptLines(entries, { toolCallId: "b3", toolName: "bash", input: {} });
	assert.deepEqual(lines, ['{"user":"  clean the build"}\n', '{"Bash":"ls"}\n', '{"Bash":"make"}\n']);
});

test("a nested call's history runs through the tool that made it", () => {
	const entries = [user("go"), calls({ id: "c1", name: "codemode", arguments: { code: "bash('x')" } }, { id: "c2", name: "bash", arguments: { command: "later" } })];
	const lines = transcriptLines(entries, { toolCallId: "c1/1", parentToolCallId: "c1", toolName: "bash", input: {} });
	assert.deepEqual(lines, ['{"user":"  go"}\n', '{"codemode":{"code":"bash(\'x\')"}}\n']);
});

test("question answers and compaction summaries are labeled as Claude Code labels them", () => {
	const entries: Entry[] = [
		{ type: "compaction", summary: "did things" },
		{ type: "message", message: { role: "toolResult", toolName: "ask_user_question", content: [{ type: "text", text: "Yes, push" }] } },
	];
	const lines = transcriptLines(entries, { toolCallId: "z", toolName: "bash", input: {} });
	assert.deepEqual(lines, [line("user", `${SUMMARY_PREFIX}\n  did things`), line("user", "[User answered AskUserQuestion]:   Yes, push")]);
});
