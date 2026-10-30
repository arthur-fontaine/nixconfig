// What cache-warmer shows. Claude Code gave the mod one status line; Pi has
// footer statuses and widgets, so the state is split by how urgent it is:
// a short footer entry always, and a line under the editor only when there is
// something to know before the next message (see README.md).
import type { Config, WarmState } from "./warmer.ts";

export const MAX_ERRORS = 3;

// Theme colors, applied by index.ts.
export type Tone = "dim" | "muted" | "success" | "warning";
export type Line = { text: string; tone: Tone };

export function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function hhmm(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function k(n: number): string {
	return `${Math.round(n / 1000)}k`;
}

export function span(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${pad(m % 60)}`;
}

// The original mod's status line, word for word.
export function describe(s: WarmState): string | undefined {
	switch (s.phase) {
		case "warming":
			return `warm · ${s.pings} ping${s.pings === 1 ? "" : "s"} · next ${hhmm(s.nextPingAt)} · ${k(s.contextTokens)}`;
		case "compacted":
			return `compacted · ${s.note}`;
		case "cold":
			return `cold · ${s.note}`;
		case "paused":
			return "warm off for this session · /warm on";
		case "stopped":
			return `warm stopped · ${s.note}`;
		default:
			return undefined;
	}
}

// When the warm window closes, and what happens then: the wake at or after it
// compacts or lets the cache cool instead of pinging.
export function windowEnd(s: WarmState, cfg: Config): { at: number; compacts: boolean } {
	return { at: s.lastActivityAt + cfg.warmWindowMs, compacts: s.contextTokens >= cfg.minCompactTokens };
}

export function footer(s: WarmState): Line | undefined {
	switch (s.phase) {
		case "warming":
			return s.errors > 0
				? { text: `warm · retry ${hhmm(s.nextPingAt)}`, tone: "warning" }
				: { text: `warm · next ${hhmm(s.nextPingAt)}`, tone: "dim" };
		case "compacted":
			return { text: "warm · compacted", tone: "success" };
		case "cold":
			return { text: "warm · cold", tone: "warning" };
		case "stopped":
			return { text: "warm · stopped", tone: "warning" };
		case "paused":
			return { text: "warm · off", tone: "muted" };
		default:
			return undefined;
	}
}

export function widget(s: WarmState, cfg: Config): Line | undefined {
	switch (s.phase) {
		case "warming": {
			if (s.errors > 0) {
				return {
					text: `cache-warmer: ${s.note} · retry ${s.errors + 1} of ${MAX_ERRORS} at ${hhmm(s.nextPingAt)}`,
					tone: "warning",
				};
			}
			const end = windowEnd(s, cfg);
			if (s.nextPingAt < end.at) return undefined;
			return {
				text: end.compacts
					? `cache-warmer: warm window ends · compacting ${k(s.contextTokens)} at ${hhmm(s.nextPingAt)} (≥ ${k(cfg.minCompactTokens)})`
					: `cache-warmer: warm window ends · letting the cache cool at ${hhmm(s.nextPingAt)} (${k(s.contextTokens)} < ${k(cfg.minCompactTokens)})`,
				tone: "dim",
			};
		}
		case "compacted":
			return { text: `cache-warmer: compacted at ${s.note}`, tone: "success" };
		case "cold":
			return { text: `cache-warmer: cold · ${s.note}`, tone: "warning" };
		case "stopped":
			return { text: `cache-warmer: stopped · ${s.note}`, tone: "warning" };
		default:
			return undefined;
	}
}
