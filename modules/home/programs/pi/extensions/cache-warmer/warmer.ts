// cache-warmer's schedule, ported from the Claude Code mod
// (samyakjain0606/awesome-learning-material, cache-warmer/hooks/register.ts).
// Everything Pi-specific sits behind Host, in index.ts, so this file has no
// runtime imports and its tests run under plain node.
//
// After each run the session's prompt cache is warm. If the person goes idle,
// this replays the last request every `pingIntervalMinutes` (under the cache
// lifetime), so returning inside the warm window costs a cache read, not a full
// re-send. Once the idle time passes `warmHours`, pinging stops: a session above
// `minCompactContextK` is compacted once, a smaller one is simply left to cool.
//
// It never pings a cache that has already lapsed (laptop asleep, timer late),
// and it stops for the day once `dailyBudgetK` keep-alive spend is reached
// across every session, counted in full-price token equivalents.

import { hhmm, k, MAX_ERRORS, pad, span, windowEnd } from "./view.ts";

export type WarmPhase = "idle" | "active" | "small" | "warming" | "compacted" | "cold" | "paused" | "stopped";

export type WarmState = {
	phase: WarmPhase;
	lastActivityAt: number;
	lastPingAt: number;
	nextPingAt: number;
	pings: number;
	pingTokens: number;
	contextTokens: number;
	errors: number;
	note: string;
};

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

// `stop` ends keep-alive for this idle period instead of retrying, with that
// note: Claude Code's fork answered 'nothing-to-fork' when there was no prefix.
export type PingResult =
	| { isAnswered: true; usage: Usage }
	| { isAnswered: false; reason: string; usage: Usage; stop?: string };

export type CompactResult = { tokensBefore?: number; tokensAfter?: number; skip?: string };

export interface Timer {
	cancel(): void;
}

export interface Store {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface Host {
	now(): number;
	after(ms: number, run: () => Promise<void>): Timer;
	// Tokens in the session's context, or undefined when unknown.
	contextTokens(): number | undefined;
	// Whether there is a request to replay (none after a restart, until the next turn).
	canPing(): boolean;
	// Replays the session's last request; must not throw.
	ping(): Promise<PingResult>;
	compact(instructions: string): Promise<CompactResult>;
	// Draws the state; the texts are in view.ts.
	show(state: WarmState): void;
	toast(text: string): void;
	log(text: string): void;
	save(state: WarmState): void;
	store: Store;
}

export type Config = {
	pingIntervalMs: number;
	cacheTtlMs: number;
	warmWindowMs: number;
	minPingTokens: number;
	minCompactTokens: number;
	dailyBudget: number;
};

export const INITIAL: WarmState = {
	phase: "idle",
	lastActivityAt: 0,
	lastPingAt: 0,
	nextPingAt: 0,
	pings: 0,
	pingTokens: 0,
	contextTokens: 0,
	errors: 0,
	note: "",
};

export const COMPACT_INSTRUCTIONS =
	"The user is resuming this session after a long break. Keep: the current task and its goal, " +
	"the plan and exactly where it stands, every file touched and what changed in each, decisions " +
	"made and why, open items and next steps, and any commands, paths or URLs needed to continue.";

// Full-price token equivalents per token, by kind (base input price = 1).
const WEIGHT = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

const RETRY_MS = 5 * 60_000;

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Defaults are the original's, except minCompactContextK: 100 here, as this
// setup configured it in Claude Code, so every session kept warm is compacted
// when its window ends.
export function configFrom(options: Record<string, unknown> = {}): Config {
	return {
		pingIntervalMs: num(options.pingIntervalMinutes, 50) * 60_000,
		cacheTtlMs: num(options.cacheTtlMinutes, 60) * 60_000,
		warmWindowMs: num(options.warmHours, 10) * 3_600_000,
		minPingTokens: num(options.minPingContextK, 100) * 1000,
		minCompactTokens: num(options.minCompactContextK, 100) * 1000,
		dailyBudget: num(options.dailyBudgetK, 2000) * 1000,
	};
}

export function dateKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function budgetKey(ms: number): string {
	return `budget:${dateKey(ms)}`;
}

function offKey(ms: number): string {
	return `off:${dateKey(ms)}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Warmer {
	private readonly host: Host;
	private readonly cfg: Config;
	private s: WarmState = INITIAL;
	private timer: Timer | null = null;

	// No parameter properties: node's type stripping, which runs the tests, rejects them.
	constructor(host: Host, cfg: Config) {
		this.host = host;
		this.cfg = cfg;
	}

	get state(): WarmState {
		return this.s;
	}

	private update(change: (prev: WarmState) => WarmState): WarmState {
		this.s = change(this.s);
		this.host.save(this.s);
		return this.s;
	}

	private cancel(): void {
		this.timer?.cancel();
		this.timer = null;
	}

	private paint(s: WarmState): void {
		this.host.show(s);
	}

	private setPhase(phase: WarmPhase, note = ""): WarmState {
		const s = this.update((prev) => ({ ...prev, phase, note, nextPingAt: 0 }));
		this.paint(s);
		return s;
	}

	private log(text: string): void {
		this.host.log(`cache-warmer: ${text}`);
	}

	private async spentToday(now: number): Promise<number> {
		return Number((await this.host.store.get(budgetKey(now))) ?? 0);
	}

	private async addSpend(now: number, equivalents: number): Promise<number> {
		const total = (await this.spentToday(now)) + equivalents;
		await this.host.store.set(budgetKey(now), Math.round(total));
		return total;
	}

	private async isOffToday(now: number): Promise<boolean> {
		return (await this.host.store.get(offKey(now))) === true;
	}

	private schedule(delayMs: number): void {
		this.cancel();
		const now = this.host.now();
		const wait = Math.max(0, delayMs);
		const s = this.update((prev) => ({ ...prev, phase: "warming", nextPingAt: now + wait }));
		this.timer = this.host.after(wait, () => this.tick());
		this.paint(s);
	}

	// Arm the first ping relative to the last time the cache was touched.
	private armFrom(touchedAt: number): void {
		const sinceTouch = this.host.now() - touchedAt;
		if (sinceTouch >= this.cfg.cacheTtlMs) {
			this.setPhase("cold", `cache lapsed ${span(sinceTouch - this.cfg.cacheTtlMs)} ago, nothing to keep warm`);
			return;
		}
		this.schedule(this.cfg.pingIntervalMs - sinceTouch);
	}

	private async compactWarm(s: WarmState): Promise<void> {
		try {
			const r = await this.host.compact(COMPACT_INSTRUCTIONS);
			// The pinged prefix is gone; a saved lastPingAt would read as a warm cache to cache-timer.
			if (r.skip === undefined) this.update((prev) => ({ ...prev, lastPingAt: 0 }));
			if (r.skip !== undefined) {
				this.setPhase("stopped", `compaction skipped: ${r.skip}`);
				return;
			}
			const before = r.tokensBefore ?? s.contextTokens;
			const after = r.tokensAfter;
			const note = `${hhmm(this.host.now())} · ${k(before)}${after !== undefined ? ` → ${k(after)}` : ""} while warm`;
			this.setPhase("compacted", note);
			this.host.toast(`cache-warmer: compacted the session while its cache was warm (${k(before)})`);
		} catch (error) {
			this.setPhase("stopped", `compaction failed: ${errorText(error)}`);
		}
	}

	async tick(): Promise<void> {
		this.timer = null;
		try {
			const s = this.s;
			if (s.phase !== "warming") return;

			const now = this.host.now();
			const idleFor = now - s.lastActivityAt;
			const sinceTouch = now - Math.max(s.lastActivityAt, s.lastPingAt);

			// 1. The cache has already lapsed (the machine slept, the timer ran late).
			//    Pinging now would pay full price to warm a cache nobody is using.
			if (sinceTouch >= this.cfg.cacheTtlMs) {
				this.setPhase("cold", `cache lapsed after ${span(sinceTouch)} untouched, not re-warmed`);
				return;
			}

			// 2. The warm window is over: compact a large session once, let a small one cool.
			if (idleFor >= this.cfg.warmWindowMs) {
				if (s.contextTokens >= this.cfg.minCompactTokens) {
					await this.compactWarm(s);
				} else {
					this.setPhase(
						"stopped",
						`${span(idleFor)} idle, ${k(s.contextTokens)} under the ${k(this.cfg.minCompactTokens)} compact line, left to cool`,
					);
				}
				return;
			}

			// 3. Switched off for the day, or the shared daily budget is spent.
			if (await this.isOffToday(now)) {
				this.setPhase("stopped", "off in every session for today (/warm off all)");
				return;
			}
			const spent = await this.spentToday(now);
			if (spent >= this.cfg.dailyBudget) {
				this.setPhase("stopped", `daily keep-alive budget reached (${k(spent)} of ${k(this.cfg.dailyBudget)})`);
				this.host.toast("cache-warmer: daily keep-alive budget reached, pinging stopped for today");
				return;
			}

			// 4. Touch the cache: replay the session's last request, one output token.
			const r = await this.host.ping();
			const u = r.usage;
			const equivalents =
				u.input * WEIGHT.input + u.cacheWrite * WEIGHT.cacheWrite + u.cacheRead * WEIGHT.cacheRead + u.output * WEIGHT.output;
			if (equivalents > 0) await this.addSpend(now, equivalents);
			// A run that starts while the ping is in flight aborts it and owns the state.
			if (this.s.phase !== "warming") return;
			if (!r.isAnswered && r.stop !== undefined) {
				this.setPhase("stopped", r.stop);
				return;
			}

			if (!r.isAnswered) {
				const errors = s.errors + 1;
				this.update((prev) => ({ ...prev, errors, note: `ping failed (${r.reason})` }));
				this.log(`ping failed (${r.reason}), attempt ${errors}`);
				if (errors >= MAX_ERRORS) {
					this.setPhase("stopped", `${errors} pings failed in a row (${r.reason})`);
					return;
				}
				this.schedule(RETRY_MS);
				return;
			}

			const total = u.input + u.cacheRead + u.cacheWrite;
			const hit = total > 0 ? u.cacheRead / total : 0;

			// 5. The ping found the cache cold: paid once, stop here.
			if (hit < 0.5) {
				this.setPhase("cold", `ping at ${hhmm(now)} found the cache cold (${Math.round(hit * 100)}% served), stopped`);
				this.host.toast("cache-warmer: the cache was already cold, keep-alive stopped for this idle period");
				return;
			}

			this.update((prev) => ({
				...prev,
				pings: prev.pings + 1,
				pingTokens: prev.pingTokens + u.cacheRead,
				lastPingAt: now,
				contextTokens: total > 0 ? total : prev.contextTokens,
				errors: 0,
				note: "",
			}));
			this.log(`ping ${s.pings + 1}: ${k(u.cacheRead)} served from cache, ${Math.round(hit * 100)}% hit`);
			this.schedule(this.cfg.pingIntervalMs);
		} catch (error) {
			this.log(`tick failed: ${errorText(error)}`);
		}
	}

	// Pi only: says when the warm window closes and what happens then.
	private windowLine(s: WarmState): string {
		const end = windowEnd(s, this.cfg);
		const then = end.compacts
			? `compact (${k(s.contextTokens)} ≥ ${k(this.cfg.minCompactTokens)})`
			: `let it cool (${k(s.contextTokens)} < ${k(this.cfg.minCompactTokens)})`;
		return `  warm window ends: ${hhmm(end.at)}, then ${then}`;
	}

	async statusText(): Promise<string> {
		const s = this.s;
		const now = this.host.now();
		const spent = await this.spentToday(now);
		const off = await this.isOffToday(now);
		const c = this.cfg;
		const lines: (string | null)[] = [
			`cache-warmer · ${s.phase}${s.note ? ` · ${s.note}` : ""}`,
			`  context: ${k(s.contextTokens)} tokens`,
			s.lastActivityAt > 0
				? `  last activity: ${hhmm(s.lastActivityAt)} (${span(now - s.lastActivityAt)} ago)`
				: "  last activity: none yet",
			`  pings this idle period: ${s.pings} (${k(s.pingTokens)} served from cache)`,
			s.phase === "warming" ? `  next ping: ${hhmm(s.nextPingAt)}` : null,
			s.phase === "warming" ? this.windowLine(s) : null,
			`  today's keep-alive spend: ${k(spent)} of ${k(c.dailyBudget)} equivalents${off ? " · off in every session today" : ""}`,
			`  settings: ping every ${span(c.pingIntervalMs)} · cache lifetime ${span(c.cacheTtlMs)} · warm window ${span(c.warmWindowMs)} · ping ≥ ${k(c.minPingTokens)} · compact ≥ ${k(c.minCompactTokens)}`,
			"  commands: /warm · /warm off · /warm on · /warm off all · /warm on all · /warm now",
		];
		return lines.filter((line): line is string => line !== null).join("\n");
	}

	// Picks the schedule back up from saved state after /reload or a resume.
	start(saved?: WarmState): void {
		this.cancel();
		this.s = saved ?? INITIAL;
		const s = this.s;
		if (s.phase === "warming" && s.lastActivityAt > 0) {
			// After a restart there is no request to replay until the next turn.
			if (this.host.canPing()) this.armFrom(Math.max(s.lastActivityAt, s.lastPingAt));
			else this.setPhase("stopped", "nothing to keep warm yet");
		} else {
			this.paint(s);
		}
	}

	promptSubmitted(): void {
		this.cancel();
		const s = this.update((prev) => ({
			...prev,
			phase: prev.phase === "paused" ? "paused" : "active",
			nextPingAt: 0,
			note: "",
		}));
		this.paint(s);
	}

	turnCompleted(): void {
		const now = this.host.now();
		const tokens = this.host.contextTokens() ?? 0;
		const s = this.update((prev) => ({
			...prev,
			lastActivityAt: now,
			lastPingAt: 0,
			nextPingAt: 0,
			pings: 0,
			pingTokens: 0,
			errors: 0,
			contextTokens: tokens,
			note: "",
			phase: prev.phase === "paused" ? "paused" : tokens >= this.cfg.minPingTokens ? "warming" : "small",
		}));
		if (s.phase === "warming") this.schedule(this.cfg.pingIntervalMs);
		else this.paint(s);
	}

	// Pi only: the next request won't extend the one a ping would replay (the
	// conversation was compacted or rewound, the model or thinking level changed).
	contextChanged(): void {
		if (this.s.phase !== "warming") return;
		this.cancel();
		this.update((prev) => ({ ...prev, lastPingAt: 0 }));
		this.setPhase("stopped", "conversation changed since the last turn, nothing to keep warm");
	}

	ended(): void {
		this.cancel();
	}

	private async resumeHere(): Promise<string> {
		const s = this.update((prev) => ({ ...prev, note: "" })); // drop the "off" note
		if (s.lastActivityAt === 0) {
			this.setPhase("idle");
			return "cache-warmer is on for this session. It arms after the next turn.";
		}
		const tokens = this.host.contextTokens() ?? s.contextTokens;
		this.update((prev) => ({ ...prev, contextTokens: tokens }));
		if (tokens < this.cfg.minPingTokens) {
			this.setPhase("small");
			return `cache-warmer is on for this session. Context is ${k(tokens)}, under the ${k(this.cfg.minPingTokens)} ping line, so nothing to do yet.`;
		}
		this.armFrom(Math.max(s.lastActivityAt, s.lastPingAt));
		return this.statusText();
	}

	async command(args: string): Promise<string> {
		const arg = args.trim().toLowerCase().replace(/\s+/g, " ");
		const now = this.host.now();

		// This session only. 'paused' survives later turns, so it stays off until /warm on.
		if (arg === "off" || arg === "pause") {
			this.cancel();
			this.setPhase("paused", "off for this session (/warm off)");
			return "cache-warmer is off for this session only. Other sessions keep warming. /warm on turns it back on here.";
		}

		if (arg === "on" || arg === "resume") {
			const note = (await this.isOffToday(now))
				? " Note: /warm off all is still in effect for every session today, so nothing will ping until /warm on all."
				: "";
			return (await this.resumeHere()) + note;
		}

		// Every session, for the rest of today.
		if (arg === "off all") {
			this.cancel();
			await this.host.store.set(offKey(now), true);
			this.setPhase("stopped", "off in every session for today (/warm off all)");
			return `cache-warmer is off in every session for the rest of ${dateKey(now)}. /warm on all lifts it.`;
		}

		if (arg === "on all") {
			await this.host.store.delete(offKey(now));
			return `Lifted /warm off all: every session can warm again.\n${await this.resumeHere()}`;
		}

		if (arg === "now") {
			if (this.s.lastActivityAt === 0) return "Nothing to ping yet: no turn has completed in this session.";
			this.cancel();
			this.update((prev) => ({ ...prev, phase: "warming" }));
			await this.tick();
			return this.statusText();
		}

		return this.statusText();
	}
}
