import assert from "node:assert/strict";
import { test } from "node:test";
import { fitRate, MIN_STRETCHES, mixOf, stretches, tokensLeft } from "../fit.ts";
import type { Sample } from "../history.ts";
import type { Spend } from "../ledger.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-10T12:00:00Z");

// A seeded generator, so a failure replays.
function random(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
}

// Five-hour windows back to back from `start`: a turn every minute or so, utilization the
// true tokens over `perPoint`, in whole points as Anthropic reports it. `noise` scales each
// turn's logged weight against what the limit counted.
function simulate({ start, windows, perPoint, noise = 0, seed = 1 }: { start: number; windows: number; perPoint: number; noise?: number; seed?: number }) {
	const rnd = random(seed);
	const samples: Sample[] = [];
	const spends: Spend[] = [];
	for (let w = 0; w < windows; w++) {
		const from = start + w * 5 * HOUR;
		const resetsAt = (from + 5 * HOUR) / 1000;
		let used = 0;
		for (let t = from + MIN; t < from + 5 * HOUR - MIN; t += MIN * (0.5 + rnd())) {
			const counted = 20_000 + rnd() * 40_000;
			used += counted;
			const utilization = Math.min(1, Math.floor(used / perPoint) / 100);
			if (utilization >= 1) break;
			spends.push([t, counted * (1 + noise * (rnd() * 2 - 1)), counted * 7, `m${w}-${t}`]);
			samples.push({ at: t + 1000, fiveHour: { utilization, resetsAt }, sevenDay: null });
		}
	}
	return { samples, spends };
}

test("stretches stay within a window and span at least five points", () => {
	const { samples, spends } = simulate({ start: NOW - 10 * HOUR, windows: 2, perPoint: 400_000 });
	const list = stretches(samples, spends, "fiveHour");
	assert.ok(list.length >= 10);
	for (const s of list) assert.ok(s.points >= 5 - 1e-9 && s.points < 7, `points ${s.points}`);
	// No stretch spans the reset: the first window's last sample and the second's first.
	const reset = NOW - 5 * HOUR;
	for (const s of list) assert.ok(s.from >= reset || s.at < reset);
});

test("the fit finds the tokens per point through a reset and noise", () => {
	const { samples, spends } = simulate({ start: NOW - 20 * HOUR, windows: 4, perPoint: 400_000, noise: 0.3 });
	const fit = fitRate(stretches(samples, spends, "fiveHour"), NOW, 3 * 24 * HOUR);
	assert.ok(fit.perPoint !== null);
	assert.ok(Math.abs(fit.perPoint - 400_000) / 400_000 < 0.05, `perPoint ${fit.perPoint}`);
	assert.ok(fit.spread !== null && fit.spread < 0.25, `spread ${fit.spread}`);
});

test("stretches with no logged tokens (usage elsewhere) don't drag the fit", () => {
	const { samples, spends } = simulate({ start: NOW - 20 * HOUR, windows: 4, perPoint: 400_000 });
	const elsewhere = stretches(samples, spends, "fiveHour").concat([
		{ from: NOW - 3 * HOUR, at: NOW - 2 * HOUR, points: 20, weighted: 0 },
		{ from: NOW - 2 * HOUR, at: NOW - HOUR, points: 10, weighted: 0 },
	]);
	const fit = fitRate(elsewhere, NOW, 3 * 24 * HOUR);
	assert.ok(Math.abs(fit.perPoint! - 400_000) / 400_000 < 0.05, `perPoint ${fit.perPoint}`);
});

test("recent stretches outweigh old ones", () => {
	const old = simulate({ start: NOW - 7 * 24 * HOUR, windows: 4, perPoint: 200_000, seed: 2 });
	const recent = simulate({ start: NOW - 20 * HOUR, windows: 4, perPoint: 400_000, seed: 3 });
	const list = [...stretches(old.samples, old.spends, "fiveHour"), ...stretches(recent.samples, recent.spends, "fiveHour")];
	const fit = fitRate(list, NOW, 24 * HOUR);
	assert.ok(fit.perPoint! > 360_000, `perPoint ${fit.perPoint}`);
});

test("too few stretches give no figure, and say how many are needed", () => {
	const { samples, spends } = simulate({ start: NOW - 5 * HOUR, windows: 1, perPoint: 4_000_000 });
	const list = stretches(samples, spends, "fiveHour");
	assert.ok(list.length < MIN_STRETCHES);
	const fit = fitRate(list, NOW, 3 * 24 * HOUR);
	assert.equal(fit.perPoint, null);
	assert.equal(fit.stretches, list.length);
	assert.equal(fit.needed, MIN_STRETCHES);
});

test("tokens left: the points left at the fitted rate, at the recent mix", () => {
	const fit = { perPoint: 400_000, spread: 0.1, stretches: 20, needed: 8 };
	assert.equal(tokensLeft(0.36, fit, 7), Math.round(64 * 400_000 * 7));
	assert.equal(tokensLeft(1, fit, 7), 0);
	assert.equal(tokensLeft(0.5, { ...fit, perPoint: null }, 7), null);
});

test("the mix is raw tokens per weighted token over the span, else over everything", () => {
	const spends: Spend[] = [
		[NOW - 10 * HOUR, 10, 100, "a"],
		[NOW - HOUR, 10, 50, "b"],
	];
	assert.equal(mixOf(spends, NOW, 5 * HOUR), 5);
	assert.equal(mixOf(spends, NOW + 6 * HOUR, 5 * HOUR), 7.5);
	assert.equal(mixOf([], NOW, 5 * HOUR), null);
});
