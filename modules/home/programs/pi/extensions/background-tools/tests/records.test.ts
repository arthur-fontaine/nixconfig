// Run: node --test 'modules/home/programs/pi/extensions/background-tools/tests/*.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	completionNotice,
	type DetachedRecord,
	type Entry,
	formatDuration,
	interruptedRecord,
	lastLines,
	pendingEdits,
	placeholder,
	placeholdersOn,
	placeholderStart,
	projectRecords,
	RECORD_TYPE,
	readRecord,
	recordsOn,
	stateLine,
	textOf,
	unknownCall,
} from "../records.ts";

const T = Date.UTC(2026, 9, 30, 9, 0, 0);

const record = (toolCallId: string, ending: DetachedRecord["ending"] = "completed", text = "done"): DetachedRecord => ({
	toolCallId,
	toolName: "bash",
	startedAt: T,
	endedAt: T + 3_200,
	ending,
	content: [{ type: "text", text }],
	details: { truncation: undefined },
});

const recordEntry = (id: string, data: unknown): Entry => ({ id, type: "custom", customType: RECORD_TYPE, data });
const resultEntry = (id: string, toolCallId: string, details: unknown): Entry => ({
	id,
	type: "message",
	message: { role: "toolResult", toolCallId, details },
});
const placeholderMessage = (toolCallId: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "bash",
	...placeholder(toolCallId, T),
	isError: false,
	timestamp: T,
});

test("a placeholder is recognized by its details alone", () => {
	const { details, content } = placeholder("call_1", T);
	assert.equal(placeholderStart(details), T);
	assert.match(textOf(content as never), /call_1/);
	assert.equal(placeholderStart({ truncation: undefined }), undefined);
	assert.equal(placeholderStart(undefined), undefined);
	assert.equal(placeholderStart({ background: { startedAt: "soon" } }), undefined);
});

test("records are read back only when well formed", () => {
	assert.deepEqual(readRecord(recordEntry("e1", record("call_1"))), record("call_1"));
	assert.equal(readRecord({ id: "e2", type: "custom", customType: "other", data: record("call_1") }), undefined);
	assert.equal(readRecord(recordEntry("e3", { ...record("call_1"), ending: "maybe" })), undefined);
	assert.equal(readRecord(recordEntry("e4", { ...record("call_1"), content: [{ type: "text" }] })), undefined);
	assert.equal(readRecord(recordEntry("e5", { ...record("call_1"), toolCallId: "" })), undefined);
});

test("the latest record of a call on the branch wins", () => {
	const records = recordsOn([recordEntry("a", record("call_1", "interrupted")), recordEntry("b", record("call_1", "completed")), recordEntry("c", record("call_2"))]);
	assert.equal(records.size, 2);
	assert.equal(records.get("call_1")?.ending, "completed");
});

test("placeholders are found with the entry that holds them", () => {
	const found = placeholdersOn([resultEntry("r1", "call_1", placeholder("call_1", T).details), resultEntry("r2", "call_2", { truncation: undefined })]);
	assert.deepEqual([...found], [["call_1", { entryId: "r1", startedAt: T }]]);
});

test("final results replace placeholders in a request, with their error flag", () => {
	const messages = [{ role: "user", content: "hi" }, placeholderMessage("call_1"), placeholderMessage("call_2")];
	const projected = projectRecords(messages, new Map([["call_1", record("call_1", "failed", "exit 1")]]));
	assert.ok(projected);
	assert.equal(projected[0], messages[0]);
	assert.deepEqual((projected[1] as any).content, [{ type: "text", text: "exit 1" }]);
	assert.equal((projected[1] as any).isError, true);
	assert.equal(projected[2], messages[2], "a call still running keeps its placeholder");
	assert.equal(projectRecords(messages, new Map()), undefined);
});

test("another extension's later edit of the result is left alone", () => {
	const edited = { ...placeholderMessage("call_1"), content: [{ type: "text" as const, text: "[output dropped]" }] };
	assert.equal(projectRecords([edited], new Map([["call_1", record("call_1")]])), undefined);
	// Once this extension's own edit landed, only the error flag is still to set.
	const ours = { ...placeholderMessage("call_1"), content: record("call_1", "failed").content };
	const projected = projectRecords([ours], new Map([["call_1", record("call_1", "failed")]]));
	assert.equal((projected?.[0] as any).isError, true);
});

test("context edits are proposed once per placeholder, not over another edit", () => {
	const branch: Entry[] = [
		resultEntry("r1", "call_1", placeholder("call_1", T).details),
		resultEntry("r2", "call_2", placeholder("call_2", T).details),
		resultEntry("r3", "call_3", placeholder("call_3", T).details),
		{ id: "x", type: "context_edit", targetId: "r2" },
	];
	const records = new Map([
		["call_1", record("call_1", "completed", "one")],
		["call_2", record("call_2")],
		["call_9", record("call_9")],
	]);
	assert.deepEqual(pendingEdits(branch, records), [{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "one" }] } }]);
});

test("an interrupted record is an error that explains itself", () => {
	const interrupted = interruptedRecord("call_1", "bash", T, T);
	assert.equal(interrupted.ending, "interrupted");
	assert.match(textOf(interrupted.content), /not resumed/);
	assert.deepEqual(readRecord(recordEntry("e", interrupted)), interrupted);
});

test("durations read at a glance", () => {
	assert.equal(formatDuration(420), "420ms");
	assert.equal(formatDuration(3_240), "3.2s");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(formatDuration(3 * 3_600_000 + 7 * 60_000), "3h 7m");
});

test("the last lines of an output, trailing blank lines aside", () => {
	assert.equal(lastLines("a\nb\nc\n\n", 2), "b\nc");
	assert.equal(lastLines("a\nb", undefined), "a\nb");
	assert.equal(lastLines("a\nb", 10), "a\nb");
});

test("states, unknown ids and the completion notice", () => {
	assert.equal(stateLine("call_1", { running: true, elapsedMs: 1_500 }), "call_1 is still running (1.5s so far).");
	assert.equal(stateLine("call_1", { running: false, ending: "stopped", elapsedMs: 900 }), "call_1 was stopped after 900ms.");
	assert.equal(unknownCall("nope", []), "No background call nope. Running in the background: none.");
	assert.equal(unknownCall("nope", ["call_1", "call_2"]), "No background call nope. Running in the background: call_1, call_2.");
	const notice = completionNotice(record("call_1", "failed"));
	assert.match(notice, /id="call_1" status="failed" elapsed="3.2s"/);
});
