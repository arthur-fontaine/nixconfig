import assert from "node:assert/strict";
import { test } from "node:test";
import { footer, widget } from "./view.ts";
import { configFrom, INITIAL, type WarmState } from "./warmer.ts";

const MIN = 60_000;
const T = new Date(2026, 9, 4, 9, 0).getTime();
const cfg = configFrom();
const warming = (change: Partial<WarmState> = {}): WarmState => ({
	...INITIAL,
	phase: "warming",
	lastActivityAt: T,
	nextPingAt: T + 50 * MIN,
	contextTokens: 225_000,
	...change,
});

test("while warming the footer says so, and nothing shows under the editor", () => {
	assert.deepEqual(footer(warming()), { text: "keeping cache warm", tone: "dim" });
	assert.equal(widget(warming(), cfg), undefined);
	assert.equal(footer({ ...INITIAL, phase: "active" }), undefined);
	assert.equal(footer({ ...INITIAL, phase: "small" }), undefined);
});

test("the last wake of the warm window is announced with what it will do", () => {
	assert.deepEqual(widget(warming({ nextPingAt: T + 10 * 60 * MIN }), cfg), {
		text: "cache-warmer: warm window ends · compacting 225k at 19:00 (≥ 100k)",
		tone: "dim",
	});
	assert.match(widget(warming({ nextPingAt: T + 10 * 60 * MIN, contextTokens: 80_000 }), cfg)?.text ?? "", /letting the cache cool at 19:00 \(80k < 100k\)/);
});

test("a failing ping shows its error and the retry", () => {
	const s = warming({ errors: 1, note: "ping failed (overloaded)", nextPingAt: T + 55 * MIN });
	assert.deepEqual(footer(s), { text: "retrying to keep cache warm", tone: "dim" });
	assert.deepEqual(widget(s, cfg), { text: "cache-warmer: ping failed (overloaded) · retry 2 of 3 at 09:55", tone: "warning" });
});

test("why it stopped stays under the editor until the next message", () => {
	const s: WarmState = { ...INITIAL, phase: "stopped", note: "daily keep-alive budget reached (2000k of 2000k)" };
	assert.deepEqual(footer(s), { text: "stopped keeping cache warm", tone: "dim" });
	assert.equal(widget(s, cfg)?.text, "cache-warmer: stopped · daily keep-alive budget reached (2000k of 2000k)");
	assert.deepEqual(footer({ ...INITIAL, phase: "paused" }), { text: "cache warming off", tone: "dim" });
	assert.deepEqual(footer({ ...INITIAL, phase: "cold" }), { text: "cache went cold", tone: "dim" });
	assert.deepEqual(footer({ ...INITIAL, phase: "compacted" }), { text: "compacted while idle", tone: "dim" });
});
