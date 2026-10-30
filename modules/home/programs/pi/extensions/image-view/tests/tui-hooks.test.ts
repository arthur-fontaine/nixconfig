import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { hookTui, type TuiHooks } from "../tui-hooks.ts";

function renderer(mode: "fullscreen" | "regular") {
	const opened: string[] = [];
	const inputs: string[] = [];
	const fake = {
		mode,
		openUrl: (url: string) => opened.push(url),
		handleTerminalInput(data: string) {
			inputs.push(`${this === fake ? "" : "unbound "}${data}`);
		},
	};
	return { fake, tui: fake as unknown as TUI, opened, inputs };
}

function hooks(name: string, log: string[]): TuiHooks {
	return {
		openUrl: (url) => {
			if (!url.endsWith(".png")) return false;
			log.push(`${name} opened ${url}`);
			return true;
		},
		input: (data, next) => {
			log.push(`${name} saw ${data}`);
			next();
		},
	};
}

test("image links go to the hook and other links to Pi, and input runs through it", () => {
	const { fake, tui, opened, inputs } = renderer("fullscreen");
	const log: string[] = [];
	hookTui(tui, hooks("first", log));
	fake.openUrl("file:///a.png");
	fake.openUrl("https://example.com");
	fake.handleTerminalInput("x");
	assert.deepEqual(log, ["first opened file:///a.png", "first saw x"]);
	assert.deepEqual(opened, ["https://example.com"]);
	assert.deepEqual(inputs, ["x"]);
});

test("a renderer is wrapped once: a reload swaps the hooks, a shutdown leaves Pi alone", () => {
	const { fake, tui, opened, inputs } = renderer("fullscreen");
	const log: string[] = [];
	hookTui(tui, hooks("first", log));
	const wrapped = fake.openUrl;
	hookTui(tui, hooks("second", log));
	assert.equal(fake.openUrl, wrapped);
	fake.openUrl("file:///a.png");
	hookTui(tui, undefined);
	fake.openUrl("file:///b.png");
	fake.handleTerminalInput("y");
	assert.deepEqual(log, ["second opened file:///a.png"]);
	assert.deepEqual(opened, ["file:///b.png"]);
	assert.deepEqual(inputs, ["y"]);
});

test("regular mode, where the terminal opens links, is left alone", () => {
	const { fake, tui } = renderer("regular");
	const { openUrl, handleTerminalInput } = fake;
	hookTui(tui, hooks("first", []));
	assert.equal(fake.openUrl, openUrl);
	assert.equal(fake.handleTerminalInput, handleTerminalInput);
});
