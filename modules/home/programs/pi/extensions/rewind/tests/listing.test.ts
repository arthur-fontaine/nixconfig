import assert from "node:assert/strict";
import { test } from "node:test";
import { DoublePress, drawsAfterCursor, hookEditor } from "../escape.ts";
import { filesPhrase, firstLine, prompts, quoted, restoreOptions, rewindOptions, rowSummary, timeAgo } from "../listing.ts";
import type { Entry } from "../plan.ts";
import { summaryPrompt, summaryText } from "../text.ts";

const user = (id: string, text: string, timestamp = 0): Entry => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp } });
const assistant = (id: string): Entry => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });

test("prompts lists the user messages oldest first, each with its turn", () => {
	const path = [user("u1", "salut"), assistant("a1"), { type: "custom", id: "c1" }, user("u2", "next", 5), assistant("a2")];
	assert.deepEqual(
		prompts(path).map(({ id, index, end, text }) => ({ id, index, end, text })),
		[
			{ id: "u1", index: 0, end: 2, text: "salut" },
			{ id: "u2", index: 3, end: 4, text: "next" },
		],
	);
	assert.deepEqual(
		prompts(path, 1).map((prompt) => prompt.id),
		["u2"],
	);
});

test("rows show the first line, with … when more follow", () => {
	assert.equal(firstLine("one line"), "one line");
	assert.equal(firstLine("first\nsecond"), "first…");
	assert.equal(firstLine("   "), "((empty message))");
});

test("the quote keeps 500 characters, then 4 lines", () => {
	assert.deepEqual(quoted("a\nb\nc\nd\ne"), ["a", "b", "c", "d"]);
	assert.equal(quoted("x".repeat(600))[0]!.length, 500);
});

test("timeAgo is Claude Code's narrow format", () => {
	const now = 1_000_000_000_000;
	assert.equal(timeAgo(now - 500, now), "0s ago");
	assert.equal(timeAgo(now - 20_000, now), "20s ago");
	assert.equal(timeAgo(now - 59_999, now), "59s ago");
	assert.equal(timeAgo(now - 3 * 3_600_000, now), "3h ago");
	assert.equal(timeAgo(now - 8 * 86_400_000, now), "1w ago");
	assert.equal(timeAgo(now - 40 * 86_400_000, now), "1mo ago");
	assert.equal(timeAgo(now - 400 * 86_400_000, now), "1y ago");
	assert.equal(timeAgo(now + 5_000, now), "in 5s");
});

test("row summaries: none, one file, several, unknown", () => {
	assert.deepEqual(rowSummary({ files: [], added: 0, removed: 0 }), { label: "No code changes", added: 0, removed: 0 });
	assert.deepEqual(rowSummary({ files: ["/r/Sources/TopHit.swift"], added: 0, removed: 81 }), { label: "TopHit.swift", added: 0, removed: 81 });
	assert.deepEqual(rowSummary({ files: ["/a", "/b", "/c"], added: 2, removed: 1 }), { label: "3 files changed", added: 2, removed: 1 });
	assert.equal(rowSummary(undefined), "noRestore");
});

test("filesPhrase names one, two, or the first and a count", () => {
	assert.equal(filesPhrase(["/x/TopHit.swift"]), "TopHit.swift");
	assert.equal(filesPhrase(["/x/a.ts", "/y/b.ts"]), "a.ts and b.ts");
	assert.equal(filesPhrase(["/a.ts", "/b.ts", "/c.ts"]), "a.ts and 2 other files");
});

test("Rewind's options follow Claude Code's conditions", () => {
	assert.deepEqual(rewindOptions(false, true), ["conversation", "summarize", "summarize_up_to", "nevermind"]);
	assert.deepEqual(rewindOptions(true, true), ["both", "conversation", "code", "summarize", "summarize_up_to", "nevermind"]);
	assert.deepEqual(rewindOptions(true, false), ["both", "conversation", "code", "nevermind"]);
});

test("Restore's options mirror them, without summaries", () => {
	assert.deepEqual(restoreOptions(true, false), ["both", "conversation", "code", "nevermind"]);
	assert.deepEqual(restoreOptions(false, false), ["conversation", "nevermind"]);
	assert.deepEqual(restoreOptions(true, true), ["code", "nevermind"]);
});

test("the summary prompt adds the user's context and the reminder", () => {
	const prompt = summaryPrompt("up_to", " keep the API notes ");
	assert.ok(prompt.startsWith("CRITICAL: Respond with TEXT ONLY."));
	assert.ok(prompt.includes("This summary will be placed at the start of a continuing session"));
	assert.ok(prompt.includes("\n\nAdditional Instructions:\nUser context: keep the API notes\n\nREMINDER:"));
	assert.ok(summaryPrompt("from").includes("the RECENT portion of the conversation"));
	assert.ok(!summaryPrompt("from", "  ").includes("Additional Instructions"));
});

test("summaryText keeps the summary block and drops the analysis", () => {
	assert.equal(summaryText("<analysis>think</analysis>\n<summary>\n1. Intent\n\n\n2. More\n</summary>"), "1. Intent\n\n2. More");
	assert.equal(summaryText("no tags"), "no tags");
});

test("a double press counts within 800 ms, and only counted presses", () => {
	let now = 0;
	const press = new DoublePress(800, () => now);
	assert.equal(press.press(true), false);
	now = 700;
	assert.equal(press.press(true), true);
	now = 800;
	assert.equal(press.press(true), false);
	now = 1700;
	assert.equal(press.press(true), false);
	now = 1800;
	assert.equal(press.press(false), false);
	now = 1900;
	assert.equal(press.press(true), false);
});

test("a ghost suggestion after the cursor is detected", () => {
	const marker = "\x1b_pi:c\x07";
	assert.equal(drawsAfterCursor(["───", `${marker}\x1b[7m \x1b[0m     `, "───"]), false);
	assert.equal(drawsAfterCursor(["───", `${marker}\x1b[2m\x1b[7mf\x1b[0mix the tests\x1b[0m`, "───"]), true);
	assert.equal(drawsAfterCursor(undefined), false);
});

test("the editor hook opens on the second Escape and keeps Pi's handler for the rest", () => {
	let now = 0;
	let opened = 0;
	let pi = 0;
	let text = "";
	let ready = true;
	const editor = { render: () => ["───", "\x1b_pi:c\x07 ", "───"], getText: () => text } as { render(width: number): string[]; getText(): string; onEscape?: () => void };
	hookEditor(editor, { ready: () => ready, open: () => opened++ }, new DoublePress(800, () => now));
	// Pi assigns its handler only when the editor has none.
	assert.equal(editor.onEscape, undefined);
	editor.onEscape = () => pi++;
	editor.render(80);
	editor.onEscape!();
	now = 300;
	editor.onEscape!();
	assert.deepEqual({ opened, pi }, { opened: 1, pi: 1 });
	text = "draft";
	now = 400;
	editor.onEscape!();
	now = 500;
	editor.onEscape!();
	assert.deepEqual({ opened, pi }, { opened: 1, pi: 3 });
	text = "";
	ready = false;
	now = 600;
	editor.onEscape!();
	now = 700;
	editor.onEscape!();
	assert.deepEqual({ opened, pi }, { opened: 1, pi: 5 });
});
