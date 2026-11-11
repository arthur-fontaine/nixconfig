// How many weighted tokens one point of a window's utilization is worth, fitted from the
// history against the ledger: stretches of at least five points within one window (the 1%
// granularity would swamp smaller ones; a reset is never crossed), each giving a ratio.
import type { Sample } from "./history.ts";
import type { Spend } from "./ledger.ts";

export type WindowKey = "fiveHour" | "sevenDay";
export type Stretch = { from: number; at: number; points: number; weighted: number };
export type Fit = { perPoint: number | null; spread: number | null; stretches: number; needed: number };

export const MIN_POINTS = 5;
// Forty points of use at least, in eight stretches, before a figure is shown.
export const MIN_STRETCHES = 8;

// The weighted tokens spent in (from, to], by binary search over prefix sums.
function summer(spends: Spend[]) {
	const times = spends.map((s) => s[0]);
	const sums = [0];
	for (const s of spends) sums.push(sums[sums.length - 1] + s[1]);
	const after = (t: number) => {
		let lo = 0;
		let hi = times.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (times[mid] <= t) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	return (from: number, to: number) => sums[after(to)] - sums[after(from)];
}

export function stretches(samples: Sample[], spends: Spend[], key: WindowKey, minPoints = MIN_POINTS): Stretch[] {
	const sum = summer(spends);
	const windows = new Map<number, { at: number; u: number }[]>();
	for (const s of samples) {
		const w = s[key];
		if (!w || typeof w.resetsAt !== "number") continue;
		const list = windows.get(w.resetsAt) ?? [];
		list.push({ at: s.at, u: w.utilization });
		windows.set(w.resetsAt, list);
	}
	const out: Stretch[] = [];
	for (const list of windows.values()) {
		list.sort((a, b) => a.at - b.at);
		let a = list[0];
		for (const b of list.slice(1)) {
			const points = Math.round((b.u - a.u) * 10_000) / 100;
			if (points < 0) a = b;
			else if (points >= minPoints) {
				out.push({ from: a.at, at: b.at, points, weighted: sum(a.at, b.at) });
				a = b;
			}
		}
	}
	return out.sort((x, y) => x.at - y.at);
}

function quantile(values: { v: number; w: number }[], q: number) {
	const sorted = [...values].sort((a, b) => a.v - b.v);
	const total = sorted.reduce((n, x) => n + x.w, 0);
	let acc = 0;
	for (const x of sorted) {
		acc += x.w;
		if (acc >= q * total) return x.v;
	}
	return sorted[sorted.length - 1]?.v ?? 0;
}

// The ratio of sums over the stretches, each weighed by its points and halved every
// `halfLife` of age. Ratios beyond 3× of the median are dropped: points spent where no log
// is read (claude.ai, another machine), or tokens a limit didn't count. `spread` is half the
// interquartile range of the ratios, relative to the fit.
export function fitRate(list: Stretch[], now: number, halfLife: number, min = MIN_STRETCHES): Fit {
	const none = (n: number): Fit => ({ perPoint: null, spread: null, stretches: n, needed: min });
	if (list.length < min) return none(list.length);
	const all = list.map((s) => ({ s, v: s.weighted / s.points, w: s.points * 0.5 ** (Math.max(0, now - s.at) / halfLife) }));
	const median = quantile(all, 0.5);
	const kept = all.filter((x) => x.v >= median / 3 && x.v <= median * 3);
	if (kept.length < min) return none(kept.length);
	const perPoint = kept.reduce((n, x) => n + x.w * x.s.weighted, 0) / kept.reduce((n, x) => n + x.w * x.s.points, 0);
	const spread = (quantile(kept, 0.75) - quantile(kept, 0.25)) / 2 / perPoint;
	return { perPoint, spread, stretches: kept.length, needed: min };
}

// Raw tokens (as the logs count them, cache reads included) per weighted token, over the
// last `span`, else over the whole ledger.
export function mixOf(spends: Spend[], now: number, span: number) {
	const ratio = (list: Spend[]) => {
		const weighted = list.reduce((n, s) => n + s[1], 0);
		return weighted > 0 ? list.reduce((n, s) => n + s[2], 0) / weighted : null;
	};
	return ratio(spends.filter((s) => s[0] > now - span && s[0] <= now)) ?? ratio(spends);
}

export function tokensLeft(utilization: number, fit: Fit, mix: number | null) {
	if (fit.perPoint === null || mix === null) return null;
	return Math.round(Math.max(0, 1 - utilization) * 100 * fit.perPoint * mix);
}
