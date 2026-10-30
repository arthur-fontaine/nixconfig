// /rewind and /restore against a stand-in Pi, on real files and a real git repository.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanup, git, Harness, scratch, Session, snapshot } from "./harness.ts";

const paths: string[] = [];
after(() => cleanup(paths));

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

async function setup() {
	const root = await scratch("rewind-repo-");
	const agentDir = await scratch("rewind-agent-");
	paths.push(root, agentDir);
	git(root, "init", "-q");
	await writeFile(join(root, "a.txt"), "one\n");
	await writeFile(join(root, "keep.txt"), "untouched\n");
	const session = new Session(join(agentDir, "session.jsonl"));
	await writeFile(session.file, "");
	const pi = new Harness(session, root, agentDir);
	await pi.emit("session_start", { reason: "startup" });
	return { root, agentDir, session, pi };
}

// An edit call the way Pi runs it: tool_call, the change, tool_result, the transcript.
async function edit(pi: Harness, id: string, file: string, content: string) {
	pi.reply([{ type: "toolCall", id, name: "edit", arguments: { path: file } }]);
	await pi.emit("tool_call", { toolName: "edit", toolCallId: id, input: { path: file } });
	await writeFile(join(pi.cwd, file), content);
	await pi.emit("tool_result", { toolName: "edit", toolCallId: id, input: { path: file }, isError: false });
	pi.result(id);
}

// A bash call with the changes bash-changes records for it.
async function bash(pi: Harness, id: string, change: () => Promise<void>, files: { path: string; status: string }[]) {
	pi.reply([{ type: "toolCall", id, name: "bash", arguments: { command: "…" } }]);
	const before = snapshot(pi.cwd);
	await change();
	const after = snapshot(pi.cwd);
	pi.result(id, { fileChanges: { root: pi.cwd, before, after, files, patch: "" } });
}

async function twoPrompts() {
	const context = await setup();
	const { pi, root } = context;
	pi.prompt("make a");
	await edit(pi, "t1", "a.txt", "two\n");
	pi.reply([{ type: "text", text: "done" }]);
	pi.prompt("add b");
	await bash(pi, "t2", () => writeFile(join(root, "b.txt"), "b1\nb2\n"), [{ path: "b.txt", status: "A" }]);
	await edit(pi, "t3", "a.txt", "three\n");
	pi.reply([{ type: "text", text: "done" }]);
	return context;
}

test("the picker lists the prompts with their changes, then (current), selected", async () => {
	const { pi } = await twoPrompts();
	await pi.open("rewind");
	const screen = pi.text();
	assert.match(screen, /Rewind\n\nRestore the code and\/or conversation to the point before…/);
	assert.match(screen, /  make a\n  a\.txt \+1 -1\n\n  add b\n  2 files changed \+3 -1\n\n❯ \(current\)/);
	assert.match(screen, /Enter to continue · Esc to cancel$/);
	await pi.press(ESC);
	await pi.pending;
});

test("rewinding code and conversation, then restoring the last prompt, round-trips", async () => {
	const { pi, root, session } = await twoPrompts();
	const leaf = session.leaf;
	await pi.open("rewind");
	await pi.press(UP, UP, ENTER);
	let screen = pi.text();
	assert.match(screen, /Confirm you want to restore to the point before you sent this message:\n\n│ make a\n│ \(20s ago\)/);
	assert.match(screen, /This message and everything after it will be removed\.\nThe code will be restored \+1 -3 in a\.txt and b\.txt\./);
	assert.match(screen, /❯ 1\. Restore code and conversation\n  2\. Restore conversation\n  3\. Restore code\n  4\. Summarize from here\n↓ 5\. Summarize up to here/);
	assert.match(screen, /⚠ Restored files go back whole, losing later changes by anyone\. Bash changes outside the git repository are not undone\./);
	await pi.press(DOWN, DOWN);
	assert.match(pi.text(), /The conversation will be unchanged\.\nThe code will be restored/);
	await pi.press(UP, UP, ENTER);
	await pi.pending;

	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\n");
	assert.equal(existsSync(join(root, "b.txt")), false);
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "untouched\n");
	assert.equal(session.leaf, null);
	assert.equal(pi.editorText, "make a");

	await pi.open("restore");
	screen = pi.text();
	assert.match(screen, /Restore\n\nRestore the code and\/or conversation to the point after…\n\n❯ \(current\)\n\n\n  make a\n  a\.txt \+1 -1\n\n  add b\n  2 files changed \+3 -1/);
	await pi.press(DOWN, DOWN, ENTER);
	screen = pi.text();
	assert.match(screen, /Confirm you want to restore to the point after this message:\n\n│ add b/);
	assert.match(screen, /This message and everything before it that was rewound will come back\.\nThe code will be restored \+3 -1 in a\.txt and b\.txt\./);
	assert.match(screen, /❯ 1\. Restore code and conversation\n  2\. Restore conversation\n  3\. Restore code\n  4\. Never mind/);
	await pi.press(ENTER);
	await pi.pending;

	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "three\n");
	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "b1\nb2\n");
	assert.equal(session.leaf, leaf);
	assert.equal(pi.editorText, "");
	// Nothing left to restore.
	await pi.open("restore");
	assert.match(pi.text(), /Nothing to restore yet\./);
	await pi.press(ESC);
	await pi.pending;
});

test("restoring the first of two rewound prompts stops after its turn", async () => {
	const { pi, root, session } = await twoPrompts();
	await pi.open("rewind");
	await pi.press(UP, UP, ENTER, ENTER);
	await pi.pending;
	await pi.open("restore");
	await pi.press(DOWN, ENTER, ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "two\n");
	assert.equal(existsSync(join(root, "b.txt")), false);
	const reply = session.getBranch().at(-1)!;
	assert.equal(reply.message?.role, "assistant");
	assert.deepEqual(reply.message?.content, [{ type: "text", text: "done" }]);
	// The second prompt is still restorable.
	await pi.open("restore");
	assert.match(pi.text(), /❯ \(current\)\n\n\n  add b/);
	await pi.press(ESC);
	await pi.pending;
});

test("restore after new prompts switches branch and offers the abandoned one back", async () => {
	const { pi, root, session } = await twoPrompts();
	await pi.open("rewind");
	await pi.press(UP, ENTER, ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "two\n");
	pi.editorText = "";
	pi.prompt("other idea");
	await edit(pi, "t4", "c.txt", "c\n");
	pi.reply([{ type: "text", text: "done" }]);
	const otherLeaf = session.leaf;

	await pi.open("restore");
	await pi.press(DOWN, ENTER);
	assert.match(pi.text(), /The code will be restored \+3 -2 in a\.txt and 2 other files\./);
	await pi.press(ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "three\n");
	assert.equal(existsSync(join(root, "c.txt")), false);

	await pi.open("restore");
	assert.match(pi.text(), /  other idea\n  c\.txt \+1/);
	await pi.press(DOWN, ENTER, ENTER);
	await pi.pending;
	assert.equal(session.leaf, otherLeaf);
	assert.equal(await readFile(join(root, "c.txt"), "utf8"), "c\n");
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "two\n");
});

test("restore warns about files edited since the rewind", async () => {
	const { pi, root } = await twoPrompts();
	await pi.open("rewind");
	await pi.press(UP, ENTER, ENTER);
	await pi.pending;
	await writeFile(join(root, "a.txt"), "mine\n");
	await pi.open("restore");
	await pi.press(DOWN, ENTER);
	assert.match(pi.text(), /⚠ Edited since the rewind: a\.txt\. Restoring overwrites these edits\./);
	await pi.press(ESC, ESC);
	await pi.pending;
});

test("restore code only, and Never mind goes back to the picker", async () => {
	const { pi, root, session } = await twoPrompts();
	const leaf = session.leaf;
	await pi.open("rewind");
	await pi.press(UP, ENTER);
	await pi.press("6");
	assert.match(pi.text(), /❯ add b\n/);
	await pi.press(ENTER, "3");
	await pi.pending;
	assert.equal(session.leaf, leaf);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "two\n");
	assert.equal(existsSync(join(root, "b.txt")), false);

	// The prompt is still in the conversation: Restore gives its code back.
	await pi.open("restore");
	await pi.press(DOWN, ENTER);
	const screen = pi.text();
	assert.match(screen, /Confirm you want to restore the code to the point after this message:/);
	assert.match(screen, /❯ 1\. Restore code\n  2\. Never mind/);
	await pi.press(ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "three\n");
	assert.equal(await readFile(join(root, "b.txt"), "utf8"), "b1\nb2\n");
});

test("a prompt without code changes offers only the conversation", async () => {
	const { pi } = await setup();
	pi.prompt("salut");
	pi.reply([{ type: "text", text: "hi" }]);
	await pi.open("rewind");
	assert.match(pi.text(), /  salut\n  No code changes\n\n❯ \(current\)/);
	await pi.press(UP, ENTER);
	const screen = pi.text();
	assert.match(screen, /This message and everything after it will be removed\.\nThe code will be unchanged\.\n\n❯ 1\. Restore conversation\n  2\. Summarize from here\n  3\. Summarize up to here\n  4\. Never mind/);
	assert.doesNotMatch(screen, /⚠/);
	await pi.press(ESC, ESC);
	await pi.pending;
});

test("a pruned snapshot is reported, and other files still restore", async () => {
	const { pi, root } = await setup();
	pi.prompt("p");
	await edit(pi, "t1", "a.txt", "two\n");
	pi.reply([{ type: "toolCall", id: "t2", name: "bash", arguments: {} }]);
	await writeFile(join(root, "gone.txt"), "x\n");
	pi.result("t2", { fileChanges: { root, before: "0".repeat(40), after: "1".repeat(40), files: [{ path: "gone.txt", status: "M" }], patch: "" } });
	await pi.open("rewind");
	await pi.press(UP, ENTER);
	assert.match(pi.text(), /⚠ Can't restore gone\.txt: the earlier content is gone/);
	await pi.press(ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\n");
	assert.equal(await readFile(join(root, "gone.txt"), "utf8"), "x\n");
});

test("Summarize from here summarizes the prompt and what follows, at its parent", async () => {
	const { pi, session } = await twoPrompts();
	await pi.open("rewind");
	await pi.press(UP, ENTER);
	await pi.press("4");
	await pi.pending;
	assert.ok(pi.modelPrompts[0]!.includes("add b"));
	assert.ok(!pi.modelPrompts[0]!.includes("make a"));
	assert.ok(pi.modelPrompts[0]!.includes("the RECENT portion"));
	const summary = session.getBranch().at(-1)!;
	assert.equal(summary.type, "branch_summary");
	assert.equal(summary.data, "The summary.");
	assert.equal(pi.editorText, "add b");
	assert.ok(pi.notes.some((note) => note.text === "Conversation summarized"));
});

test("Summarize up to here compacts what precedes and keeps the prompt", async () => {
	const { pi, session } = await twoPrompts();
	const second = session.getBranch().find((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("add b"))!;
	await pi.open("rewind");
	await pi.press(UP, ENTER, DOWN, DOWN, DOWN, DOWN);
	await pi.press(..."keep notes".split(""));
	assert.match(pi.text(), /❯ 5\. Summarize up to here: keep notes/);
	await pi.press(ENTER);
	await pi.pending;
	await pi.settle();
	assert.deepEqual(pi.compactions, [{ summary: "The summary.", firstKeptEntryId: second.id, tokensBefore: 100, usage: {} }]);
	assert.ok(pi.modelPrompts[0]!.includes("make a"));
	assert.ok(!pi.modelPrompts[0]!.includes("add b"));
	assert.ok(pi.modelPrompts[0]!.includes("User context: keep notes"));
});

test("a subagent's edits are backed up in its parent's store, under the parent's prompt", async () => {
	const { pi, root, agentDir, session } = await setup();
	pi.prompt("delegate");
	pi.reply([{ type: "toolCall", id: "task1", name: "Agent", arguments: {} }]);
	await pi.emit("tool_execution_start", { toolCallId: "task1", toolName: "Agent" });
	const child = new Harness(new Session("", session.file), root, agentDir, false);
	await child.emit("session_start", { reason: "startup" });
	child.prompt("do it");
	await edit(child, "c1", "a.txt", "from child\n");
	await pi.emit("tool_execution_end", { toolCallId: "task1", toolName: "Agent" });
	pi.result("task1");
	pi.reply([{ type: "text", text: "done" }]);
	// The child keeps no store of its own.
	assert.deepEqual(await readdir(join(agentDir, "rewind")), [session.id]);
	await pi.open("rewind");
	assert.match(pi.text(), /  delegate\n  a\.txt \+1 -1/);
	await pi.press(UP, ENTER, ENTER);
	await pi.pending;
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\n");
});
