// The lines posted in the chat when the extension acts: short, plain words, no symbols or percentages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actedNote, DECLINED, failedNote } from "../notes.ts";

const SLOP = /[▲▼→·=%]/;

test("each action says what was done and why", () => {
	const lines = {
		"Context compacted: this prompt starts a related task": actedNote({ action: "compact_view", category: "related" }, false),
		"Context compacted: this prompt returns to an earlier task": actedNote({ action: "compact_branch", category: "return" }, false),
		"Context cleared: this prompt starts an unrelated task": actedNote({ action: "clear", category: "independent" }, false),
		"Context compacted, as you chose: this prompt starts a related task": actedNote({ action: "compact_view", category: "related" }, true),
		"Context cleared, as you chose: this prompt starts an unrelated task": actedNote({ action: "clear", category: "independent" }, true),
		"Context kept: you chose to send the prompt as is": DECLINED,
		"Could not compact the context, so it was kept: Compaction cancelled": failedNote({ action: "compact_view" }, "Compaction cancelled"),
	};
	for (const [expected, actual] of Object.entries(lines)) {
		assert.equal(actual, expected);
		assert.doesNotMatch(actual, SLOP);
	}
});
