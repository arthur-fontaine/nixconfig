// The countdown itself, without Pi imports so its tests run under plain node.

export const DEFAULT_TTL_MINUTES = 60;

// Entries read from the session branch, newest first. Only the fields used here.
export type Entry =
	| {
			type: "message";
			message: {
				role: string;
				timestamp?: number;
				usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
			};
	  }
	| { type: "usage"; kind: string; timestamp: string }
	| { type: "custom"; customType: string; data?: unknown }
	| { type: string };

// "none": nothing has touched a cache yet. "reset": the next request can't reuse
// the last cache (compacted, or another model), so it is cold whatever the clock.
export type Touch = { kind: "none" } | { kind: "reset" } | { kind: "touched"; at: number };

export function ttlMsFrom(settings: unknown): number {
	const minutes = (settings as { cacheTimer?: { ttlMinutes?: unknown } } | undefined)?.cacheTimer?.ttlMinutes;
	return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60_000;
}

// Walks back from the leaf to the last request that reached the model. Pi's own
// cache refreshes and cache-warmer's pings after it count as touches too.
export function lastTouch(newestFirst: Iterable<Entry>): Touch {
	let at = 0;
	let reset = false;
	for (const entry of newestFirst) {
		if (entry.type === "message" && "message" in entry && entry.message.role === "assistant") {
			const u = entry.message.usage;
			// A request that failed before the provider read the prompt touched nothing.
			if ((u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) === 0) continue;
			if (reset) return { kind: "reset" };
			return { kind: "touched", at: Math.max(at, entry.message.timestamp ?? 0) };
		}
		if (reset) continue;
		if (entry.type === "usage" && "kind" in entry && entry.kind === "cache_warm") {
			at = Math.max(at, Date.parse(entry.timestamp) || 0);
		} else if (entry.type === "custom" && "customType" in entry && entry.customType === "cache-warmer") {
			const ping = (entry.data as { warm?: { lastPingAt?: unknown } } | undefined)?.warm?.lastPingAt;
			if (typeof ping === "number") at = Math.max(at, ping);
		} else if (entry.type === "compaction" || entry.type === "model_change") {
			if (at > 0) return { kind: "touched", at };
			// Only matters if an earlier request had warmed a cache: a new session
			// starts with a model_change and nothing to count down.
			reset = true;
		}
	}
	return at > 0 ? { kind: "touched", at } : { kind: "none" };
}

// Shown only near the end, in the theme's warning color: until then there is
// nothing to act on, and once cold the next message re-sends everything anyway.
export const WARN_MS = 5 * 60_000;

export type Label = { text: string; tone: "warning" };

export function label(touch: Touch, ttlMs: number, now: number): Label | undefined {
	if (touch.kind !== "touched") return undefined;
	const left = touch.at + ttlMs - now;
	if (left <= 0 || left > WARN_MS) return undefined;
	return { text: `cache expires in ${Math.ceil(left / 60_000)} min`, tone: "warning" };
}
