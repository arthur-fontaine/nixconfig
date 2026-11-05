import assert from "node:assert/strict";
import { test } from "node:test";
import { afterBang, hideBang, inBashMode } from "../bash.ts";

test("inBashMode: a draft starting with !", () => {
	assert.equal(inBashMode("!ls"), true);
	assert.equal(inBashMode("!"), true);
	assert.equal(inBashMode("ls !x"), false);
	assert.equal(inBashMode(""), false);
});

test("hideBang: the leading ! goes, the row keeps its width", () => {
	assert.equal(hideBang(" !ls -la   "), " ls -la    ");
	assert.equal(hideBang("!git status"), "git status ");
	// `!!` (excluded from context) keeps its second !.
	assert.equal(hideBang(" !!make"), " !make ");
	// The cursor's marker right after the ! stays where the text starts.
	assert.equal(hideBang(" !\x1b_pi:c\x07x"), " \x1b_pi:c\x07x ");
	assert.equal(hideBang(" ls"), undefined);
});

test("afterBang: the cursor is never before the !", () => {
	assert.equal(afterBang("!ls", { line: 0, col: 0 }), 1);
	assert.equal(afterBang("!ls", { line: 0, col: 2 }), 2);
	assert.equal(afterBang("!ls", { line: 1, col: 0 }), 0);
	assert.equal(afterBang("ls", { line: 0, col: 0 }), 0);
});
