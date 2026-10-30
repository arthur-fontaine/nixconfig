import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTE, plain } from "../note.ts";
import { noteRenderer } from "../render.ts";

const MUTED = "\x1b[38;5;244m";
const theme = {
	fg: (color: string, text: string) => `${color === "muted" ? MUTED : "\x1b[2m"}${text}\x1b[39m`,
	getFgAnsi: (color: string) => (color === "muted" ? MUTED : "\x1b[2m"),
} as any;

const inner = { render: (width: number) => [`${MUTED}Took 0.1s\x1b[39m`.padEnd(width + MUTED.length + 5)], invalidate() {} };
const definition = { name: "bash", renderResult: () => inner } as any;
const context = (toolCallId: string, extra: object = {}) => ({ toolCallId, isError: false, lastComponent: undefined, ...extra }) as any;
const result = (details?: unknown) => ({ content: [], details }) as any;
const final = { expanded: false, isPartial: false };

test("tools without a result renderer, and the Agent row, keep Pi's own definition", () => {
	const resolve = noteRenderer(() => true);
	const bare = { name: "plain_tool", execute() {} } as any;
	assert.equal(resolve("plain_tool", () => bare), bare);
	assert.equal(resolve("Agent", () => definition), definition);
	assert.equal(resolve("unknown", () => undefined), undefined);
});

test("a call auto mode didn't allow gets the inner renderer's component itself", () => {
	const renderers = noteRenderer((id) => id === "yes")("bash", () => definition)!;
	assert.equal(renderers.renderResult!(result(), final, theme, context("no")), inner);
	assert.equal(renderers.renderResult!(result(), { ...final, isPartial: true }, theme, context("yes")), inner);
	assert.equal(renderers.renderResult!(result(), final, theme, context("yes", { isError: true })), inner);
});

test("an allowed call, from the call id or from the saved details, gets the note beside Took", () => {
	const renderers = noteRenderer((id) => id === "yes")("bash", () => definition)!;
	for (const [details, id] of [[undefined, "yes"], [{ autoMode: { allowed: true } }, "resumed"]] as const) {
		const component = renderers.renderResult!(result(details), final, theme, context(id));
		assert.notEqual(component, inner);
		assert.equal(plain(component.render(40)[0]).trimEnd(), `Took 0.1s  ${NOTE}`);
		// Pi hands the wrapper back on the next render; the inner renderer gets its own component.
		let seen: unknown;
		const spy = noteRenderer(() => true)("bash", () => ({ renderResult: (_r: any, _o: any, _t: any, c: any) => ((seen = c.lastComponent), inner) }) as any)!;
		spy.renderResult!(result(), final, theme, context("x", { lastComponent: component }));
		assert.equal(seen, inner);
	}
});
