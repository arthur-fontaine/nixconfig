// Run: node --test 'modules/home/programs/pi/extensions/cache-timer/*.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Entry, label, lastTouch, ttlMsFrom } from "./timer.ts";

const MIN = 60_000;
const T = Date.UTC(2026, 9, 4, 9, 0, 0);

const assistant = (timestamp: number, usage = { input: 10, cacheRead: 50_000, cacheWrite: 0 }): Entry => ({
	type: "message",
	message: { role: "assistant", timestamp, usage },
});
const user: Entry = { type: "message", message: { role: "user", timestamp: T } };
const warmed = (at: number): Entry => ({ type: "usage", kind: "cache_warm", timestamp: new Date(at).toISOString() });
const pinged = (at: number): Entry => ({ type: "custom", customType: "cache-warmer", data: { warm: { lastPingAt: at } } });

// Entries are given oldest first here, as they read in a session.
const touch = (...entries: Entry[]) => lastTouch(entries.reverse());

test("nothing is shown before the first request", () => {
	assert.equal(label(touch({ type: "model_change" }, { type: "thinking_level_change" }, user), 60 * MIN, T), undefined);
});

test("shows nothing until the last five minutes, counted from when the last request was sent", () => {
	const t = touch(user, assistant(T));
	assert.equal(label(t, 60 * MIN, T + 11_000), undefined);
	assert.equal(label(t, 60 * MIN, T + 54 * MIN), undefined);
	assert.deepEqual(label(t, 60 * MIN, T + 55 * MIN), { text: "cache expires in 5 min", tone: "warning" });
	assert.deepEqual(label(t, 60 * MIN, T + 56.5 * MIN), { text: "cache expires in 4 min", tone: "warning" });
});

test("under a minute it reads 1 min, then nothing once expired", () => {
	const t = touch(user, assistant(T));
	assert.equal(label(t, 60 * MIN, T + 59.5 * MIN)?.text, "cache expires in 1 min");
	assert.equal(label(t, 60 * MIN, T + 60 * MIN), undefined);
	assert.equal(label(t, 60 * MIN, T + 61 * MIN), undefined);
	// A 5-minute cache warns from the start.
	assert.equal(label(t, 5 * MIN, T + 30_000)?.text, "cache expires in 5 min");
});

test("cache-warmer's pings and Pi's own refreshes restart the clock", () => {
	assert.deepEqual(touch(user, assistant(T), pinged(T + 50 * MIN)), { kind: "touched", at: T + 50 * MIN });
	assert.deepEqual(touch(user, assistant(T), warmed(T + 4 * MIN)), { kind: "touched", at: T + 4 * MIN });
	// A ping recorded before the last request is older than it.
	assert.deepEqual(touch(pinged(T - 5 * MIN), user, assistant(T)), { kind: "touched", at: T });
});

test("a request that failed before reaching the model doesn't count", () => {
	const t = touch(user, assistant(T), user, assistant(T + 5 * MIN, { input: 0, cacheRead: 0, cacheWrite: 0 }));
	assert.deepEqual(t, { kind: "touched", at: T });
});

test("after a compaction or another model there is no cache left to count down", () => {
	assert.deepEqual(touch(user, assistant(T), { type: "compaction" }), { kind: "reset" });
	assert.equal(label(touch(user, assistant(T), { type: "compaction" }), 5 * MIN, T + MIN), undefined);
	assert.equal(label(touch(user, assistant(T), { type: "model_change" }), 5 * MIN, T + MIN), undefined);
	// …until a request warms the new prefix.
	assert.equal(label(touch(user, assistant(T), { type: "compaction" }, user, assistant(T + MIN)), 5 * MIN, T + 2 * MIN)?.text, "cache expires in 4 min");
});

test("the lifetime comes from settings.json's cacheTimer.ttlMinutes, 60 by default", () => {
	assert.equal(ttlMsFrom({}), 60 * MIN);
	assert.equal(ttlMsFrom({ cacheTimer: { ttlMinutes: 5 } }), 5 * MIN);
	assert.equal(ttlMsFrom({ cacheTimer: { ttlMinutes: "5" } }), 60 * MIN);
});
