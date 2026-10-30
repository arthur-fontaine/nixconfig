import assert from "node:assert/strict";
import { test } from "node:test";
import { commandName, paintCommand } from "../command.ts";

const paint = (text: string) => `<${text}>`;

test("commandName reads the command at the very start", () => {
	assert.equal(commandName("/rename my-task"), "rename");
	assert.equal(commandName("/skill:eli5"), "skill:eli5");
	assert.equal(commandName("/"), undefined);
	assert.equal(commandName(" /rename"), undefined);
	assert.equal(commandName("/usr/bin/env"), "usr");
	assert.equal(commandName("see /rename"), undefined);
});

test("paintCommand colors the name after the editor's padding", () => {
	assert.equal(paintCommand(" /rename my-task ", "rename", paint), " </rename> my-task ");
	assert.equal(paintCommand("/rename\x1b_pi:c\x07 ", "rename", paint), "</rename>\x1b_pi:c\x07 ");
	assert.equal(paintCommand("/rename", "rename", paint), "</rename>");
});

test("paintCommand leaves rows that don't start with the whole name", () => {
	assert.equal(paintCommand("/renamed", "rename", paint), undefined);
	assert.equal(paintCommand("x /rename", "rename", paint), undefined);
	assert.equal(paintCommand("/re\x1b_pi:c\x07name", "rename", paint), undefined);
});
