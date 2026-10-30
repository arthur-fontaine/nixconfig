import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedIn, isTimer, NOTE, placeNote, plain, withVerdict } from "../note.ts";

const MUTED = "\x1b[38;5;244m";
const muted = (s: string) => `${MUTED}${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const out = (s: string) => `\x1b[38;5;250m${s}\x1b[39m`;
// pi-tui's Text pads each line to the width with spaces.
const padded = (s: string, width: number) => s + " ".repeat(width - plain(s).length);
const timer = (line: string) => isTimer(line, MUTED);
const place = (lines: string[], width: number) => placeNote(lines, width, dim(NOTE), NOTE.length, timer).map((l) => plain(l).trimEnd());

test("the verdict merges into the result's details and is read back", () => {
	assert.deepEqual(withVerdict(undefined), { autoMode: { allowed: true } });
	assert.deepEqual(withVerdict({ truncation: 1, fileChanges: { a: 1 } }), { truncation: 1, fileChanges: { a: 1 }, autoMode: { allowed: true } });
	for (const owned of ["text", 3, null, [1]]) assert.equal(withVerdict(owned), undefined);
	assert.ok(allowedIn(withVerdict({ x: 1 })));
	for (const none of [undefined, null, "autoMode", {}, { autoMode: true }, { autoMode: { allowed: "yes" } }]) assert.ok(!allowedIn(none));
});

test("only Pi's final timer line, in the muted color, counts as the timer", () => {
	for (const t of ["Took 0.1s", "Took 12.0s", "Took 1m 30s", "Took 2h 3m 4s"]) assert.ok(timer(padded(muted(t), 40)), t);
	assert.ok(!timer(muted("Elapsed 0.1s")));
	assert.ok(!timer(out("Took 0.1s")), "command output that happens to read like the timer");
	assert.ok(!timer(muted("Took 0.1s ago")));
});

test("the note goes beside Took, two spaces from it", () => {
	const lines = [padded("$ ls", 60), padded("", 60), padded(out("a.txt"), 60), padded("", 60), padded(muted("Took 0.1s"), 60)];
	const placed = placeNote(lines, 60, dim(NOTE), NOTE.length, timer);
	assert.equal(placed.length, lines.length);
	assert.equal(plain(placed[4]), padded(`Took 0.1s  ${NOTE}`, 60));
	assert.ok(placed[4].includes(dim(NOTE)));
	assert.deepEqual(placed.slice(0, 4), lines.slice(0, 4));
});

test("lines another extension drew under the timer stay below it", () => {
	const lines = [padded(muted("Took 1.2s"), 50), padded("", 50), padded("✓ finished in the background", 50)];
	assert.deepEqual(place(lines, 50), [`Took 1.2s  ${NOTE}`, "", "✓ finished in the background"]);
});

test("a row too narrow for both puts the note on the line below Took", () => {
	assert.deepEqual(place([padded(muted("Took 0.1s"), 25)], 25), ["Took 0.1s", NOTE]);
});

test("without a timer the note is the result's last line, after a blank one", () => {
	assert.deepEqual(place([padded(out("Successfully wrote 3 bytes"), 40)], 40), ["Successfully wrote 3 bytes", "", NOTE]);
	assert.deepEqual(place([], 40), ["", NOTE]);
	assert.deepEqual(place([], 8), ["", "Allowed"]);
});
