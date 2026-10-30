// The lines posted in the chat: short, plain words, the actual level, no symbols or percentages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeNote, describeDecision, problemNote } from "../notes.ts";

const SLOP = /[▲▼→·=%]/;

test("a change names the level and the kind of work", () => {
	const lines = {
		"Thinking for this prompt: low, for a quick request": changeNote({ category: "trivial", choice: "low" }, "low"),
		"Thinking for this prompt: medium, for a small change": changeNote({ category: "light", choice: "medium" }, "medium"),
		"Thinking for this prompt: high, for multi-step work": changeNote({ category: "multi_step", choice: "high" }, "high"),
		"Thinking for this prompt: xhigh, for a hard task": changeNote({ category: "hard", choice: "xhigh" }, "xhigh"),
	};
	for (const [expected, actual] of Object.entries(lines)) {
		assert.equal(actual, expected);
		assert.doesNotMatch(actual, SLOP);
	}
	// A Jev answer has no category: the level it picked stands for the kind of work.
	assert.equal(changeNote({ choice: "high" }, "high"), "Thinking for this prompt: high, for multi-step work");
});

test("a level moved by the configured range or the model says so", () => {
	assert.equal(changeNote({ category: "exhaustive", choice: "max" }, "xhigh"), "Thinking for this prompt: xhigh, the highest allowed, for an exhaustive task");
	assert.equal(changeNote({ category: "trivial", choice: "low" }, "medium"), "Thinking for this prompt: medium, the lowest allowed, for a quick request");
});

test("a level that stands needs no line", () => {
	for (const reason of ["default", "low confidence", "model takes no effort"]) assert.equal(problemNote(reason, "high"), null);
});

test("problems say the level that stays, Nisev loading as one kind", () => {
	const starting = problemNote("Nisev starting", "high")!;
	const downloading = problemNote("Nisev downloading", "high")!;
	assert.deepEqual(starting, { kind: "Nisev loading", text: "Nisev starting: thinking stays at high until it is ready", type: "info" });
	assert.equal(downloading.kind, starting.kind);
	assert.equal(downloading.text, "Nisev downloading its model: thinking stays at high until it is ready");
	assert.equal(problemNote("Nisev unavailable", "medium")!.text, "Nisev did not answer, so thinking stays at medium. See /auto-effort.");
	assert.equal(problemNote("endpoint unavailable", "medium")!.text, "The effort classifier did not answer, so thinking stays at medium. See /auto-effort.");
	assert.equal(problemNote("no effort answer", "medium")!.text, "The effort classifier gave no usable answer, so thinking stays at medium.");
	for (const reason of ["Nisev stopped", "Nisev unavailable", "endpoint unavailable", "unknown choice huge"]) {
		const found = problemNote(reason, "medium")!;
		assert.equal(found.type, "warning");
		assert.doesNotMatch(found.text, SLOP);
	}
});

test("the status names the level instead of default", () => {
	assert.equal(describeDecision({ effort: null, choice: "default", confidence: 0.56, category: "light", reason: "default" }, "high"),
		"kept high, the model's default fits a small change (56% sure)");
	assert.equal(describeDecision({ effort: null, choice: "low", confidence: 0.3, reason: "low confidence" }, "high"), "kept high; it leaned to low but was only 30% sure");
	assert.equal(describeDecision({ effort: "xhigh", choice: "max", confidence: 0.99, category: "exhaustive", reason: "jev" }, "medium"),
		"set to xhigh, picked max, for an exhaustive task (99% sure)");
});
