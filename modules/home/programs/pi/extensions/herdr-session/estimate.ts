// The tokens left in each window, from the history (history.ts) and the logs' spend
// (ledger.ts). One session refreshes the fit every few minutes under a lock, as the poll
// shares its ask; every write of claude-usage.json then applies the latest fit to the
// utilization it carries (withEstimate), so Herdr only displays it.
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { claim, readJson, writeAtomic } from "./atomic.ts";
import { type Fit, fitRate, mixOf, stretches, tokensLeft, type WindowKey } from "./fit.ts";
import { readHistory, type Sample, trimHistory, writeHistory } from "./history.ts";
import { emptyLedger, type Ledger, readLogs, type Sources } from "./ledger.ts";

export const REFRESH = 5 * 60_000;
// A first refresh reads two weeks of logs; it takes seconds, not this long.
const LOCK_TTL = 10 * 60_000;
const FIVE_HOURS = 5 * 3_600_000;
// Recent stretches count most: limits and habits change.
const HALF_LIFE: Record<WindowKey, number> = { fiveHour: 3 * 86_400_000, sevenDay: 7 * 86_400_000 };

export type Model = { at: number; mix: number | null; fiveHour: Fit; sevenDay: Fit };

const files = (dir: string) => ({
	usage: path.join(dir, "claude-usage.json"),
	ledger: path.join(dir, "claude-usage.ledger.json"),
	model: path.join(dir, "claude-usage.estimate.json"),
	lock: path.join(dir, "claude-usage.estimate.lock"),
});

export const defaultSources = (dir: string): Sources => ({
	pi: path.join(dir, "sessions"),
	claude: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects"),
});

type Windowed = { fiveHour?: { utilization?: number } | null; sevenDay?: { utilization?: number } | null };

// The record with `tokensLeft` (raw tokens at the mix of the last five hours; null until
// the fit has enough stretches) and the fit behind it, on each window.
export function withEstimate<T extends Windowed>(record: T, dir: string): T {
	const model = readJson<Model>(files(dir).model);
	if (!model) return record;
	const window = (w: Windowed["fiveHour"], fit: Fit) => {
		if (!w || typeof w.utilization !== "number" || !fit) return w;
		return { ...w, tokensLeft: tokensLeft(w.utilization, fit, model.mix), estimate: { ...fit, mix: model.mix, at: model.at } };
	};
	return { ...record, fiveHour: window(record.fiveHour, model.fiveHour), sevenDay: window(record.sevenDay, model.sevenDay) };
}

// Consecutive samples that say the same are one, but for one every ten minutes.
function thin(samples: Sample[]) {
	const out: Sample[] = [];
	const key = (s: Sample) => JSON.stringify([s.fiveHour, s.sevenDay]);
	for (const s of samples) {
		const last = out[out.length - 1];
		if (last && key(last) === key(s) && s.at - last.at < 10 * 60_000) continue;
		out.push(s);
	}
	return out;
}

export async function refresh({ dir, now, sources = defaultSources(dir) }: { dir: string; now: number; sources?: Sources }): Promise<"skipped" | "written"> {
	const f = files(dir);
	const fresh = () => {
		const model = readJson<Model>(f.model);
		return model !== null && now - model.at < REFRESH;
	};
	if (fresh() || !claim(f.lock, now, LOCK_TTL)) return "skipped";
	try {
		if (fresh()) return "skipped";
		// Without a ledger, the logs are read from the start: Pi's responses carry the
		// utilization they left, which seeds the history.
		const first = !existsSync(f.ledger);
		const { ledger, samples } = await readLogs(first ? emptyLedger() : (readJson<Ledger>(f.ledger) ?? emptyLedger()), sources, now, { samples: first });
		if (samples.length) writeHistory(dir, thin([...readHistory(dir), ...samples].sort((a, b) => a.at - b.at)));
		trimHistory(dir, now);
		const history = readHistory(dir);
		const fit = (key: WindowKey) => fitRate(stretches(history, ledger.spends, key), now, HALF_LIFE[key]);
		const model: Model = { at: now, mix: mixOf(ledger.spends, now, FIVE_HOURS), fiveHour: fit("fiveHour"), sevenDay: fit("sevenDay") };
		writeAtomic(f.ledger, ledger);
		writeAtomic(f.model, model);
		const usage = readJson<Windowed>(f.usage);
		if (usage) writeAtomic(f.usage, withEstimate(usage, dir));
		return "written";
	} finally {
		try {
			unlinkSync(f.lock);
		} catch {}
	}
}
