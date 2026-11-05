import assert from "node:assert/strict";
import { test } from "node:test";
import { mounted } from "../popup.ts";

test("mounted: the editor inside Pi's editor container", () => {
	const editor = {};
	const container = { children: [editor] };
	assert.equal(mounted(editor, [{ children: [] }, container]), true);
	assert.equal(mounted(container, [container]), true);
});

test("mounted: not once a selector replaced it in the container", () => {
	const editor = {};
	const container = { children: [{ picker: true }] };
	assert.equal(mounted(editor, [{ children: [] }, container]), false);
	assert.equal(mounted(editor, []), false);
});
