// The original mod's tests (hooks/warm.test.ts), plus Pi-specific cases.
// Run: node --test modules/home/programs/pi/extensions/cache-warmer/
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "./view.ts";
import { configFrom, type Host, type PingResult, type Usage, Warmer, type WarmState } from "./warmer.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

const hit = (context: number): Usage => ({ input: 12, output: 1, cacheRead: context, cacheWrite: 0 });
const miss = (context: number): Usage => ({ input: context, output: 1, cacheRead: 0, cacheWrite: 0 });
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// A clock whose timers fire, in order, only when advanced; each callback is
// awaited so a ping's follow-up schedule lands before the next one is due.
function fakeClock(start: number) {
	let now = start;
	let seq = 0;
	let timers: { at: number; id: number; run: () => Promise<void> }[] = [];
	return {
		now: () => now,
		after(ms: number, run: () => Promise<void>) {
			const id = ++seq;
			timers.push({ at: now + ms, id, run });
			return { cancel: () => (timers = timers.filter((t) => t.id !== id)) };
		},
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
				if (!next) break;
				timers = timers.filter((t) => t !== next);
				now = next.at;
				await next.run();
			}
			now = end;
		},
		// Moves time without firing anything, as a machine asleep would.
		skip(ms: number) {
			now += ms;
		},
	};
}

// The world beneath the warmer: a session of `context` tokens whose replayed
// request answers from `answers` in order, and a store shared by `share`.
function world(context: number, answers: (Usage | PingResult)[], options: Record<string, unknown> = {}, share?: { data: Map<string, unknown> }) {
	const clock = fakeClock(Date.UTC(2026, 9, 4, 9, 0, 0));
	const data: Map<string, unknown> = share?.data ?? new Map();
	const seen = { forks: 0, compacts: 0, status: [] as (string | undefined)[], toasts: [] as string[], saved: [] as WarmState[] };
	const session = { context, canPing: true, onPing: () => {} };
	const host: Host = {
		now: clock.now,
		after: clock.after,
		contextTokens: () => session.context,
		canPing: () => session.canPing,
		async ping() {
			session.onPing();
			const answer = answers[Math.min(seen.forks, answers.length - 1)] ?? hit(session.context);
			seen.forks += 1;
			return "isAnswered" in answer ? answer : { isAnswered: true, usage: answer };
		},
		async compact() {
			seen.compacts += 1;
			return { tokensBefore: session.context, tokensAfter: 30_000 };
		},
		show: (state) => seen.status.push(describe(state)),
		toast: (text) => seen.toasts.push(text),
		log: () => {},
		save: (state) => seen.saved.push(state),
		store: {
			get: async (key) => data.get(key),
			set: async (key, value) => void data.set(key, value),
			delete: async (key) => void data.delete(key),
		},
	};
	const warmer = new Warmer(host, configFrom(options));
	return {
		clock,
		data,
		seen,
		session,
		warmer,
		start: (saved?: WarmState) => warmer.start(saved),
		turn: () => warmer.turnCompleted(),
		warm: (args: string) => warmer.command(args),
		lastStatus: () => seen.status.at(-1),
	};
}

test("a large idle session is pinged every 50 minutes", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	await w.clock.advance(49 * MIN);
	assert.equal(w.seen.forks, 0);
	await w.clock.advance(2 * MIN);
	assert.equal(w.seen.forks, 1);
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 2);
	assert.match(w.lastStatus() ?? "", /^warm · 2 pings · next \d\d:\d\d · 600k$/);
});

test("a new prompt cancels the pending ping", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	await w.clock.advance(40 * MIN);
	w.warmer.promptSubmitted();
	await w.clock.advance(30 * MIN);
	assert.equal(w.seen.forks, 0);
});

test("a small session is left alone", async () => {
	const w = world(40_000, [hit(40_000)]);
	w.start();
	w.turn();
	await w.clock.advance(3 * HOUR);
	assert.equal(w.seen.forks, 0);
});

test("a ping that finds the cache cold stops the keep-alive", async () => {
	const w = world(600_000, [miss(600_000)]);
	w.start();
	w.turn();
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 1);
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 1);
	assert.match(w.lastStatus() ?? "", /^cold · /);
});

test("after the warm window a session above 500k is compacted once, while warm", async () => {
	const w = world(600_000, [hit(600_000)], { minCompactContextK: 500 });
	w.start();
	w.turn();
	for (let i = 0; i < 11; i += 1) await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 11); // pings at 50m … 9h10m
	assert.equal(w.seen.compacts, 0);
	await w.clock.advance(50 * MIN); // the 12th wake lands at 10h: the window closes, so compact instead of ping
	assert.equal(w.seen.compacts, 1);
	assert.equal(w.seen.forks, 11);
	await w.clock.advance(3 * HOUR);
	assert.equal(w.seen.forks, 11);
	assert.equal(w.seen.compacts, 1);
	assert.match(w.lastStatus() ?? "", /^compacted · \d\d:\d\d · 600k → 30k while warm$/);
	assert.equal(w.warmer.state.lastPingAt, 0); // cache-timer must not count the compacted prefix's pings
});

test("after the warm window a session under 500k is left to cool", async () => {
	const w = world(300_000, [hit(300_000)], { minCompactContextK: 500 });
	w.start();
	w.turn();
	for (let i = 0; i < 13; i += 1) await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 11); // pings at 50m…9h10m; at 10h the window closes first
	assert.equal(w.seen.compacts, 0);
	assert.match(w.lastStatus() ?? "", /^warm stopped · /);
});

test("/warm answers a status, /warm pause stops pings", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	assert.match(await w.warm(""), /cache-warmer · warming/);
	await w.warm("pause");
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 0);
});

test("/warm off stops only this session, survives the next turn, and /warm on resumes", async () => {
	const w = world(600_000, [hit(600_000), hit(600_000)]);
	w.start();
	w.turn();
	assert.match(await w.warm("off"), /this session only/);
	assert.doesNotMatch(await w.warm(""), /equivalents · off in every session/); // the shared all-sessions switch stays clear
	w.turn(); // a later turn must not re-arm a session switched off
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 0);
	assert.match(w.lastStatus() ?? "", /^warm off for this session/);
	await w.warm("on");
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 0); // the cache lapsed while off, so it is never re-warmed
	w.turn();
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 1);
});

test("/warm off all stops every session for today, /warm on all lifts it", async () => {
	const w = world(600_000, [hit(600_000)]);
	const other = world(600_000, [hit(600_000)], {}, w);
	w.start();
	other.start();
	w.turn();
	await w.warm("off all");
	assert.match(await w.warm(""), /equivalents · off in every session today/);
	w.turn();
	other.turn();
	await w.clock.advance(50 * MIN);
	await other.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 0);
	assert.equal(other.seen.forks, 0);
	await w.warm("on all");
	assert.doesNotMatch(await w.warm(""), /off in every session/); // the stale note is gone too
	w.turn();
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 1);
});

// Pi-specific from here on.

test("minCompactContextK defaults to 100, as configured for Claude Code", async () => {
	const w = world(300_000, [hit(300_000)]);
	w.start();
	w.turn();
	for (let i = 0; i < 12; i += 1) await w.clock.advance(50 * MIN);
	assert.equal(w.seen.compacts, 1);
});

test("the daily budget is shared and stops pinging once spent", async () => {
	// One ping on 600k from cache is about 60k equivalents.
	const w = world(600_000, [hit(600_000)], { dailyBudgetK: 100 });
	w.start();
	w.turn();
	await w.clock.advance(100 * MIN);
	assert.equal(w.seen.forks, 2);
	await w.clock.advance(50 * MIN);
	assert.equal(w.seen.forks, 2);
	assert.match(w.lastStatus() ?? "", /^warm stopped · daily keep-alive budget reached \(120k of 100k\)$/);
	assert.equal(w.data.get("budget:2026-10-04"), 120_034);
});

test("a failing ping is retried every 5 minutes, three times at most", async () => {
	const failed: PingResult = { isAnswered: false, reason: "overloaded", usage: ZERO };
	// At 50 minutes the third try would land on the cache's expiry and be skipped as lapsed.
	const w = world(600_000, [failed], { pingIntervalMinutes: 40 });
	w.start();
	w.turn();
	await w.clock.advance(40 * MIN);
	assert.equal(w.seen.forks, 1);
	await w.clock.advance(10 * MIN);
	assert.equal(w.seen.forks, 3);
	await w.clock.advance(HOUR);
	assert.equal(w.seen.forks, 3);
	assert.equal(w.lastStatus(), "warm stopped · 3 pings failed in a row (overloaded)");
});

test("a ping with nothing to replay stops with its note", async () => {
	const none: PingResult = { isAnswered: false, reason: "nothing-to-fork", usage: ZERO, stop: "nothing to keep warm yet" };
	const w = world(600_000, [none]);
	w.start();
	w.turn();
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 1);
	assert.equal(w.lastStatus(), "warm stopped · nothing to keep warm yet");
});

test("a timer that fires after the cache lapsed does not ping", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	w.clock.skip(70 * MIN);
	await w.warmer.tick();
	assert.equal(w.seen.forks, 0);
	assert.match(w.lastStatus() ?? "", /^cold · cache lapsed after 1h10 untouched/);
});

test("after /reload the schedule resumes from saved state, after a restart it stops", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	await w.clock.advance(20 * MIN);
	const saved = w.warmer.state;

	w.warmer.ended();
	w.start(saved);
	await w.clock.advance(31 * MIN);
	assert.equal(w.seen.forks, 1); // still 50 minutes after the turn

	w.warmer.ended();
	w.session.canPing = false;
	w.start(w.warmer.state);
	assert.equal(w.lastStatus(), "warm stopped · nothing to keep warm yet");
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 1);
});

test("a changed conversation stops the pending ping", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.start();
	w.turn();
	await w.clock.advance(50 * MIN);
	w.warmer.contextChanged();
	assert.equal(w.warmer.state.lastPingAt, 0);
	await w.clock.advance(2 * HOUR);
	assert.equal(w.seen.forks, 1);
	assert.match(w.lastStatus() ?? "", /^warm stopped · conversation changed/);
});

test("a ping still in flight when a turn starts leaves the turn's state alone", async () => {
	const w = world(600_000, [hit(600_000)]);
	w.session.onPing = () => w.warmer.promptSubmitted();
	w.start();
	w.turn();
	await w.clock.advance(50 * MIN);
	assert.equal(w.warmer.state.phase, "active");
	assert.equal(w.warmer.state.pings, 0);
});
