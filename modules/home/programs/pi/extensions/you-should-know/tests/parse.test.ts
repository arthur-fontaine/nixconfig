import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isAlreadyOffered,
	isCheckStep,
	isDeclined,
	lineKey,
	looksToSkipAfter,
	parseExplanation,
	parseProposedLine,
	proseMarkdown,
	respondDraft,
	tagOf,
	truncateAtWordBoundary,
	unquoted,
} from "../parse.ts";
import { explainPrompt, proposePrompt } from "../prompts.ts";

test("learn: none declines, in its variants", () => {
	assert.deepEqual(parseProposedLine("learn: none"), { kind: "none" });
	assert.deepEqual(parseProposedLine("learn: None."), { kind: "none" });
	assert.deepEqual(parseProposedLine('- learn: "none"'), { kind: "none" });
	assert.deepEqual(parseProposedLine("learn: none (nothing clears the bar)"), { kind: "none" });
	assert.ok(isDeclined(""));
	assert.ok(!isDeclined("nonetheless this matters"));
});

test("a full proposal gives the line, the tag and the explanation", () => {
	const reply = [
		"learn: We put multi-turn /ask behind a feature flag that's off by default, so users won't see it yet.  ",
		"tag: Heads up  ",
		"explain:",
		"**Multi-turn /ask is switched off**",
		"",
		"A **feature flag** is a switch.",
	].join("\n");
	const p = parseProposedLine(reply);
	assert.equal(p.kind, "line");
	if (p.kind !== "line") return;
	assert.equal(p.line, "We put multi-turn /ask behind a feature flag that's off by default, so users won't see it yet.");
	assert.equal(p.tag, "Heads up");
	assert.equal(p.explanation, "**Multi-turn /ask is switched off**\n\nA **feature flag** is a switch.");
});

test("the tag defaults to You should know and can sit inline on the learn line", () => {
	const plain = parseProposedLine("learn: Encrypting at rest costs CPU");
	assert.deepEqual(plain, { kind: "line", line: "Encrypting at rest costs CPU.", tag: "You should know", explanation: undefined });
	const inline = parseProposedLine("learn: The cache can go stale. tag: Heads up");
	assert.equal(inline.kind === "line" && inline.line, "The cache can go stale.");
	assert.equal(inline.kind === "line" && inline.tag, "Heads up");
});

test("a learn line wraps onto the next lines until a blank or a label", () => {
	const p = parseProposedLine("learn: The export keeps transcripts\nin memory only.\ntag: You should know");
	assert.equal(p.kind === "line" && p.line, "The export keeps transcripts in memory only.");
});

test("quotes around the line go, a period is added", () => {
	assert.equal(unquoted("“The flag is off”."), "The flag is off");
	const p = parseProposedLine('learn: "The flag is off"');
	assert.equal(p.kind === "line" && p.line, "The flag is off.");
});

test("lines over 240 characters and replies without learn: are unparsable", () => {
	assert.deepEqual(parseProposedLine(`learn: ${"word ".repeat(60)}`), { kind: "unparsable" });
	assert.deepEqual(parseProposedLine("I think nothing is worth flagging."), { kind: "unparsable" });
});

test("tagOf only recognises Heads up", () => {
	assert.equal(tagOf("heads-up!"), "Heads up");
	assert.equal(tagOf("FYI"), "You should know");
});

test("the dedupe key ignores case and a final period", () => {
	assert.equal(lineKey("The Flag is off."), "the flag is off");
	assert.ok(isAlreadyOffered("the flag is off", ["The flag is off."], []));
	assert.ok(!isAlreadyOffered("the flag is on", ["The flag is off."], ["x"]));
});

test("backoff: free for two ignored offers, then 1, 2, 4, 8, 16 and no more", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map(looksToSkipAfter), [0, 0, 0, 1, 2, 4, 8, 16, 16, 16]);
});

test("checks fall on steps 6, 12, 18…", () => {
	assert.deepEqual([0, 1, 5, 6, 7, 12, 18].map(isCheckStep), [false, false, false, true, false, true, true]);
});

test("explanations split into cards with a title, prose, a sketch and a caption", () => {
	const cards = parseExplanation(["**One-off /ask costs more**", "Lead line.", "```", "a -> b", "```", "After the sketch.", "# Second", "More."].join("\n"));
	assert.deepEqual(cards, [
		{ title: "One-off /ask costs more", lead: "Lead line.", sketch: ["a -> b"], caption: "After the sketch." },
		{ title: "Second", lead: "More.", sketch: [], caption: "" },
	]);
	assert.equal(parseExplanation(Array.from({ length: 6 }, (_, i) => `**T${i}**\nx`).join("\n")).length, 4);
	assert.deepEqual(parseExplanation("   \n"), []);
});

test("truncation stops at a word when it can", () => {
	assert.equal(truncateAtWordBoundary("short", 10), "short");
	assert.equal(truncateAtWordBoundary("one two three four", 12), "one two…");
});

test("prose renders almost literally: only bold and code stay markup", () => {
	assert.equal(proseMarkdown("Use # and _x_ with **care** and `code`", "Title"), "**Title**  \nUse \\# and \\_x\\_ with **care** and `code`\n\n");
	assert.equal(proseMarkdown("- one\n- two", ""), "- one\n- two\n\n");
	assert.equal(proseMarkdown("", ""), "");
});

test("the chat draft quotes the note and folds @ mentions", () => {
	const draft = respondDraft("Ask @bob about it.", [{ title: "T", lead: "L", sketch: [], caption: "" }], "Heads up");
	assert.equal(draft, "Here is a note offered by a side agent:\n\n> Heads up \xB7 Ask ＠bob about it.\n>\n> **T**\n> L");
});

test("prompts carry the limits the spec quotes", () => {
	assert.match(explainPrompt("X."), /At most 100 words; fewer when the thing needs no introduction\./);
	assert.match(explainPrompt("X.", { direction: "less_detail", previous: "old" }), /they asked for it with less detail:\n"""\nold\n"""/);
	assert.match(proposePrompt(["a."], []), /You should skip them:\n- a\.\n/);
	assert.match(proposePrompt([], []), /avoid offering them:\n\(nothing yet\)/);
});
