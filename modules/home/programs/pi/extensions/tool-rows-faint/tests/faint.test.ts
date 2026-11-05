import assert from "node:assert/strict";
import { test } from "node:test";
import { fadeOf, faint } from "../faint.ts";

const fade = { text: { r: 200, g: 200, b: 200 }, background: { r: 0, g: 0, b: 0 }, amount: 0.5 };

test("colors are mixed toward the background, not dropped", () => {
	assert.equal(faint("ls", fade), "\x1b[38;2;100;100;100mls\x1b[39m");
	assert.equal(faint("\x1b[38;2;200;100;0mgit\x1b[39m x", fade), "\x1b[38;2;100;100;100m\x1b[38;2;100;50;0mgit\x1b[39;38;2;100;100;100m x\x1b[39m");
	assert.equal(faint("\x1b[1mB\x1b[0mc", fade), "\x1b[38;2;100;100;100m\x1b[1mB\x1b[0;38;2;100;100;100mc\x1b[39m");
	// Backgrounds (diff tints) are kept.
	assert.equal(faint("\x1b[48;2;10;20;30mx", fade), "\x1b[38;2;100;100;100m\x1b[48;2;10;20;30mx\x1b[39m");
});

test("empty lines and inline images are left alone", () => {
	assert.equal(faint("", fade), "");
	assert.equal(faint("\x1b_Gf=100;data\x1b\\", fade), "\x1b_Gf=100;data\x1b\\");
});

test("the fade is read from a true-color theme", () => {
	const theme = { appearance: "dark", getFgAnsi: () => "\x1b[38;2;222;224;225m" };
	assert.deepEqual(fadeOf(theme, 0.3)?.text, { r: 222, g: 224, b: 225 });
	assert.equal(fadeOf({ getFgAnsi: () => "\x1b[38;5;7m" }, 0.3), undefined);
});
