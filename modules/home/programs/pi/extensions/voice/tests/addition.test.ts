import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFiles, joinAddition, type Situation, whatToDoWithAddition } from "../addition.ts";

const base: Situation = { phase: "before_speech", voiceEntryId: "u1", voiceText: "Réponds par oui.", filesChanged: false, running: true };

test("speech before Pi speaks, no file changed: total rewind with the addition appended", () => {
	assert.deepEqual(whatToDoWithAddition("Non, plutôt non.", base), {
		action: "rewind",
		entryId: "u1",
		text: "Réponds par oui. Non, plutôt non.",
	});
	// Pi's run may already be over (a short answer not yet spoken): still a rewind.
	assert.equal(whatToDoWithAddition("et en anglais", { ...base, running: false }).action, "rewind");
});

test("speech before Pi speaks, after a tool changed files: a steer, never a rewind", () => {
	assert.deepEqual(whatToDoWithAddition("et ajoute un test", { ...base, filesChanged: true }), { action: "steer", text: "et ajoute un test" });
	// The run is over by then: the words go as the next message.
	assert.deepEqual(whatToDoWithAddition("et ajoute un test", { ...base, filesChanged: true, running: false }), {
		action: "message",
		text: "et ajoute un test",
	});
});

test("speech while Pi speaks: a steer into the running turn, never a rewind", () => {
	assert.deepEqual(whatToDoWithAddition("arrête-toi à cinq", { ...base, phase: "while_speaking" }), { action: "steer", text: "arrête-toi à cinq" });
	// Pi's run ended and only its voice goes on: the next message.
	assert.equal(whatToDoWithAddition("arrête-toi à cinq", { ...base, phase: "while_speaking", running: false }).action, "message");
});

test("speech once the answer was spoken to the end: a new message", () => {
	assert.deepEqual(whatToDoWithAddition("Merci.", { ...base, phase: "after_answer", running: false }), { action: "message", text: "Merci." });
	// Even if Pi is busy with something else (a typed prompt), it isn't an addition to the voice message.
	assert.equal(whatToDoWithAddition("Merci.", { ...base, phase: "after_answer", running: true }).action, "message");
});

test("no voice message to rewind (it was typed): a steer or a message", () => {
	assert.equal(whatToDoWithAddition("plus court", { ...base, voiceEntryId: undefined, voiceText: undefined }).action, "steer");
	assert.equal(
		whatToDoWithAddition("plus court", { ...base, voiceEntryId: undefined, voiceText: undefined, running: false }).action,
		"message",
	);
});

test("the addition joins the old text as one utterance", () => {
	assert.equal(joinAddition("Fais un commit.", "  et pousse  "), "Fais un commit. et pousse");
	assert.equal(joinAddition("", "et pousse"), "et pousse");
	assert.equal(joinAddition("Fais un commit.", ""), "Fais un commit.");
});

test("which tool results changed files", () => {
	assert.equal(changedFiles("edit", {}, false), true);
	assert.equal(changedFiles("write", undefined, false), true);
	assert.equal(changedFiles("edit", {}, true), false, "a failed edit changed nothing");
	assert.equal(changedFiles("read", {}, false), false);
	assert.equal(changedFiles("bash", { fileChanges: { files: [{ path: "a" }], patch: "" } }, false), true);
	assert.equal(changedFiles("bash", { fileChanges: { files: [], patch: "" } }, false), false);
	assert.equal(changedFiles("bash", {}, false), false, "bash with nothing recorded by bash-changes");
});
