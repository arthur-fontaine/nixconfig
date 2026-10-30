import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store, storedOf, withAnswered, withKnown, withSeen } from "../store.ts";
import { atTurnStart, choicesOf, revived, rowOf, type View } from "../view.ts";

const offer: View = { kind: "offer", line: "The flag is off.", shownAt: 1 };
const explained: View = { kind: "explained", line: "The flag is off.", text: "**T**\nx", iteration: 1, shownAt: 1 };

test("an offer survives one prompt and is ignored on the second", () => {
	const first = atTurnStart(offer, 1);
	assert.deepEqual(first, { view: { ...offer, promptsSurvived: 1, isOffArmed: false }, ignored: false });
	assert.deepEqual(atTurnStart(first.view, 1), { view: undefined, ignored: true });
	assert.deepEqual(atTurnStart(offer, 2), { view: undefined, ignored: true });
});

test("a turn without a prompt from the person changes nothing but the asked row", () => {
	assert.deepEqual(atTurnStart(offer, 0), { view: offer, ignored: false });
	assert.deepEqual(atTurnStart({ kind: "asked", line: "x", shownAt: 1 }, 0), { view: undefined, ignored: false });
});

test("an explanation is never cleared by prompts", () => {
	assert.deepEqual(atTurnStart(explained, 5), { view: { ...explained, promptsSurvived: 5 }, ignored: false });
});

test("a revived session drops what died with the old process", () => {
	assert.deepEqual(revived({ view: { kind: "explaining", line: "x", iteration: 1 }, tag: "Heads up" }), { view: undefined, tag: "Heads up" });
	assert.deepEqual(revived({ view: { kind: "asked", line: "x", shownAt: 1 } }), { view: undefined });
	assert.deepEqual(revived({ view: offer }), { view: offer });
	assert.deepEqual(revived(undefined), {});
});

test("persisted rows are validated", () => {
	assert.deepEqual(rowOf({ view: offer, tag: "Heads up" }), { view: offer, tag: "Heads up" });
	assert.equal(rowOf({ view: { kind: "nope" } }), undefined);
	assert.equal(rowOf(null), undefined);
});

test("each view offers Claude Code's choices", () => {
	const labels = (view: View | undefined, isAboutOpen = false) => choicesOf(view, { isAboutOpen }).map((c) => `${c.hotkey}:${c.label}`);
	assert.deepEqual(labels(offer), ["1:Learn more", "2:Knew this already", "3:What is this", "4:Disable", "0:Dismiss"]);
	assert.deepEqual(labels({ ...offer, isOffArmed: true }, true), ["1:Learn more", "2:Knew this already", "3:Return to topic", "4:Press again to disable", "0:Dismiss"]);
	assert.deepEqual(labels({ kind: "asked", line: "x", shownAt: 1 }), [
		"1:That was helpful",
		"2:Not relevant",
		"3:Couldn’t understand",
		"4:Turn off suggestions",
		"0:Dismiss",
	]);
	assert.deepEqual(labels({ kind: "asked", line: "x", shownAt: 1, iteration: 1 }), ["1:That was helpful", "2:Didn’t understand", "0:Dismiss"]);
	assert.deepEqual(labels(explained).slice(0, 2), ["1:Understood", "2:Chat in main session"]);
	assert.deepEqual(labels({ kind: "failed", reason: "explain" }), ["0:OK"]);
	assert.deepEqual(labels({ kind: "explaining", line: "x", iteration: 1 }), []);
	assert.deepEqual(labels({ kind: "off", line: "x", shownAt: 1 }), []);
});

test("stored state is sanitised and capped", () => {
	assert.deepEqual(storedOf({ seen: ["a", 1, "b"], known: "x", typedPastInARow: -1, looksToSkip: 2.5, enabled: false }), {
		seen: ["a", "b"],
		known: [],
		typedPastInARow: 0,
		looksToSkip: 0,
		enabled: false,
	});
	const s = storedOf(undefined);
	assert.equal(s.enabled, true);
	const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).reduce(withSeen, s);
	assert.equal(many.seen.length, 50);
	assert.equal(many.seen[0], "line 10");
});

test("known lines are deduped case-insensitively; answers reset the backoff", () => {
	const s = withKnown(withKnown(storedOf(undefined), "The flag is off."), "the FLAG is off.");
	assert.deepEqual(s.known, ["The flag is off."]);
	assert.deepEqual(withAnswered({ ...s, typedPastInARow: 4, looksToSkip: 2 }), { ...s, typedPastInARow: 0, looksToSkip: 0 });
});

test("the store reads defaults, survives bad JSON and writes atomically", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ysk-"));
	try {
		const file = path.join(dir, "nested", "state.json");
		const store = new Store(file);
		assert.deepEqual(store.read(), storedOf(undefined));
		store.update((s) => withSeen(s, "a."));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).seen, ["a."]);
		writeFileSync(file, "{not json");
		assert.deepEqual(store.read(), storedOf(undefined));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
