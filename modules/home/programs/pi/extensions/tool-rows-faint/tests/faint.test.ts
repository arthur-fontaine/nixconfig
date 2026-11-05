import assert from "node:assert/strict";
import { test } from "node:test";
import { faint } from "../faint.ts";

test("a line is faint, and stays faint past a bold's end and a reset", () => {
	assert.equal(faint("ls"), "\x1b[2mls\x1b[22m");
	assert.equal(faint("\x1b[1mBash\x1b[22m(ls)"), "\x1b[2m\x1b[1mBash\x1b[22m\x1b[2m(ls)\x1b[22m");
	assert.equal(faint("a\x1b[0mb\x1b[mc"), "\x1b[2ma\x1b[0m\x1b[2mb\x1b[m\x1b[2mc\x1b[22m");
	assert.equal(faint("\x1b[38;2;1;2;3mx"), "\x1b[2m\x1b[38;2;1;2;3mx\x1b[22m");
});

test("empty lines and inline images are left alone", () => {
	assert.equal(faint(""), "");
	assert.equal(faint("\x1b_Gf=100;data\x1b\\"), "\x1b_Gf=100;data\x1b\\");
});
