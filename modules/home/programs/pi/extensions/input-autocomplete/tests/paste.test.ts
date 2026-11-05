import assert from "node:assert/strict";
import { test } from "node:test";
import { joinPaste, marker, type Pastes } from "../paste.ts";

const long = (lines: number, prefix = "a") => Array.from({ length: lines }, (_, i) => `${prefix}${i}`).join("\n");
const pastes = (...contents: string[]): Pastes => ({ contents: new Map(contents.map((content, i) => [i + 1, content])), counter: contents.length });

test("marker: Pi's labels", () => {
	assert.equal(marker(1, long(12)), "[paste #1 +12 lines]");
	assert.equal(marker(2, "x".repeat(1200)), "[paste #2 1200 chars]");
});

test("joinPaste: a second long paste extends the first marker instead of adding one", () => {
	const first = long(12);
	const second = long(15, "b");
	const m1 = marker(1, first);
	const before = { text: `see ${m1} end`, cursor: `see ${m1}`.length };
	const after = { text: `see ${m1}${marker(2, second)} end`, cursor: `see ${m1}${marker(2, second)}`.length };
	const joined = joinPaste(before, after, pastes(first), pastes(first, second));
	const label = marker(1, first + second);
	assert.equal(label, "[paste #1 +26 lines]");
	assert.deepEqual(joined, {
		draft: { text: `see ${label} end`, cursor: `see ${label}`.length },
		pastes: { contents: new Map([[1, first + second]]), counter: 1 },
	});
});

test("joinPaste: a short paste right after a marker goes into it as is", () => {
	const first = long(12);
	const m1 = marker(1, first);
	const before = { text: m1, cursor: m1.length };
	const after = { text: `${m1}more\ntext`, cursor: `${m1}more\ntext`.length };
	const joined = joinPaste(before, after, pastes(first), pastes(first));
	assert.equal(joined?.pastes.contents.get(1), `${first}more\ntext`);
	assert.equal(joined?.draft.text, marker(1, `${first}more\ntext`));
	assert.equal(joined?.pastes.counter, 1);
});

test("joinPaste: the later of two markers is the one extended", () => {
	const first = long(12);
	const second = long(11, "b");
	const third = long(13, "c");
	const text = `${marker(1, first)} and ${marker(2, second)}`;
	const after = `${text}${marker(3, third)}`;
	const joined = joinPaste({ text, cursor: text.length }, { text: after, cursor: after.length }, pastes(first, second), pastes(first, second, third));
	assert.equal(joined?.draft.text, `${marker(1, first)} and ${marker(2, second + third)}`);
	assert.deepEqual([...(joined?.pastes.contents.keys() ?? [])], [1, 2]);
});

test("joinPaste: Pi's paste stands when something was typed after the marker", () => {
	const first = long(12);
	const text = `${marker(1, first)} `;
	const after = `${text}${marker(2, long(12))}`;
	assert.equal(joinPaste({ text, cursor: text.length }, { text: after, cursor: after.length }, pastes(first), pastes(first, long(12))), undefined);
});

test("joinPaste: Pi's paste stands with no marker at all", () => {
	assert.equal(joinPaste({ text: "hi", cursor: 2 }, { text: "hi there", cursor: 8 }, pastes(), pastes()), undefined);
});

test("joinPaste: text that only looks like a marker isn't one", () => {
	const text = "[paste #4 +20 lines]";
	assert.equal(joinPaste({ text, cursor: text.length }, { text: `${text}x`, cursor: text.length + 1 }, pastes(), pastes()), undefined);
});
