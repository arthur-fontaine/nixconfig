// The footer segment: what the extension is doing or last decided, then how full the context is
// against the point where Pi compacts by itself. One short segment, under its own status key,
// next to the other extensions' (Pi joins them on one line and cuts what overflows).

import type { Paint, Tone } from "./debug.ts";
import type { Decision } from "./policy.ts";

export interface Fill {
	percent: number | null;
	// Where Pi's own threshold compaction starts, in percent of the window; null when it is off.
	threshold: number | null;
}

const TONE: Record<string, Tone> = { keep: "success", compact_view: "warning", compact_branch: "warning", clear: "error" };

export function toneOf(decision: Partial<Decision> | null | undefined): Tone {
	return decision?.category ? TONE[decision.action ?? "keep"] ?? "text" : "dim";
}

// Pi compacts once tokens pass contextWindow - reserveTokens (compaction.md), with per-model overrides.
export function compactionPoint(settings: any, model: { provider: string; id: string; contextWindow?: number } | undefined) {
	const compaction = settings?.compaction ?? {};
	if (compaction.enabled === false || !model?.contextWindow) return null;
	const reserve = compaction.modelOverrides?.[model.provider + "/" + model.id]?.reserveTokens ?? compaction.reserveTokens ?? 16_384;
	return reserve < model.contextWindow ? ((model.contextWindow - reserve) / model.contextWindow) * 100 : null;
}

// `context kept · 92% · ctx 41/92%`: the context is 41% full, and Pi compacts by itself at 92%.
export function statusLine(text: string, tone: Tone, fill: Fill | null, paint: Paint) {
	const parts = [paint(tone, text)];
	if (fill && fill.percent !== null) {
		const near = fill.threshold !== null && fill.percent >= fill.threshold - 10;
		const value = "ctx " + Math.round(fill.percent) + (fill.threshold === null ? "" : "/" + Math.round(fill.threshold)) + "%";
		parts.push(paint(near ? "warning" : "dim", value));
	}
	return parts.join(paint("dim", " · "));
}

export function tokens(n: number) {
	return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
