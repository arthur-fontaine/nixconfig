// The tokens the Claude subscription spent, from the session logs of Pi and Claude Code: both
// draw on the same limits. Read incrementally, by offset per file, so a refresh costs only
// the lines written since the last one. Only token counts, models, ids and times are kept.
import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { HISTORY_KEEP, type Sample, sampleOf } from "./history.ts";

// What a token weighs against the limits, in Opus input tokens. API prices as the shape
// (output 5×, cache writes 2× at the 1-hour price, Sonnet 0.6×, Haiku 0.2×), except cache
// reads: priced 0.1×, they fit the past utilization best at 0.05× (see README.md).
const KIND = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 2 };
const FAMILY: [string, number][] = [
	["haiku", 0.2],
	["sonnet", 0.6],
];

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function weigh(model: string | undefined, t: Tokens) {
	const family = FAMILY.find(([name]) => model?.includes(name))?.[1] ?? 1;
	return family * (t.input * KIND.input + t.output * KIND.output + t.cacheRead * KIND.cacheRead + t.cacheWrite * KIND.cacheWrite);
}

// [time (ms), weighted tokens, raw tokens, message id]
export type Spend = [number, number, number, string];
export type Ledger = { files: Record<string, { offset: number; ino: number }>; spends: Spend[] };
export type Sources = { pi: string; claude: string };

export const emptyLedger = (): Ledger => ({ files: {}, spends: [] });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const time = (v: unknown) => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN);

type Found = { id: string; at: number; model?: string; tokens: Tokens; sample?: Sample };

// A Pi entry: an assistant message through the claude-code provider (the subscription, by
// Claude Code's login). The anthropic provider may be an API key, so it isn't counted.
function piEntry(line: string, samples: boolean): Found | null {
	if (!line.includes('"claude-code"')) return null;
	const d = JSON.parse(line);
	const m = d?.message;
	if (d?.type !== "message" || m?.role !== "assistant" || m.provider !== "claude-code" || !m.usage) return null;
	const u = m.usage;
	const found: Found = {
		id: m.responseId ?? d.id,
		at: time(d.timestamp ?? m.timestamp),
		model: m.model,
		tokens: { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite) },
	};
	if (samples && Array.isArray(m.diagnostics)) {
		const rate = m.diagnostics.findLast((x: { type?: string }) => x?.type === "claude-code.rate-limit");
		const w = rate?.details?.unifiedWindows;
		if (w && typeof rate.timestamp === "number") found.sample = sampleOf({ at: rate.timestamp, fiveHour: w.five_hour, sevenDay: w.seven_day });
	}
	return found;
}

// A Claude Code entry: one line per content block of a message, each with its usage.
function claudeEntry(line: string): Found | null {
	if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
	const d = JSON.parse(line);
	const m = d?.message;
	if (d?.type !== "assistant" || !m?.usage || m.model === "<synthetic>") return null;
	const u = m.usage;
	return {
		id: m.id ?? d.uuid,
		at: time(d.timestamp),
		model: m.model,
		tokens: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) },
	};
}

function list(dir: string): string[] {
	try {
		return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

const CHUNK = 1 << 20;

// The whole lines from `offset` on, and where the next read starts.
async function* linesFrom(file: string, offset: number) {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(CHUNK);
		let rest = Buffer.alloc(0);
		let at = offset;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK, at);
			if (bytesRead === 0) break;
			at += bytesRead;
			const data = Buffer.concat([rest, buffer.subarray(0, bytesRead)]);
			const end = data.lastIndexOf(10);
			if (end < 0) {
				rest = data;
				continue;
			}
			for (const line of data.subarray(0, end).toString("utf8").split("\n")) if (line) yield { line, next: 0 };
			rest = data.subarray(end + 1);
			yield { line: "", next: at - rest.length };
		}
	} finally {
		await handle.close();
	}
}

export async function readLogs(ledger: Ledger, sources: Sources, now: number, options: { samples?: boolean } = {}) {
	const since = now - HISTORY_KEEP;
	const files: Ledger["files"] = {};
	const spends = ledger.spends.filter((s) => s[0] >= since);
	const seen = new Set(spends.map((s) => s[3]));
	const samples: Sample[] = [];
	const kinds: [string[], (line: string) => Found | null][] = [
		[list(sources.pi), (line) => piEntry(line, options.samples === true)],
		[list(sources.claude), claudeEntry],
	];
	for (const [paths, entry] of kinds) {
		for (const file of paths) {
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			const known = ledger.files[file];
			let offset = known && known.ino === stat.ino && known.offset <= stat.size ? known.offset : 0;
			// Nothing in a file untouched since before the window counts.
			if (!known && stat.mtimeMs < since) offset = stat.size;
			if (offset < stat.size) {
				try {
					for await (const { line, next } of linesFrom(file, offset)) {
						if (!line) {
							offset = next;
							continue;
						}
						let found: Found | null;
						try {
							found = entry(line);
						} catch {
							continue;
						}
						if (!found || !Number.isFinite(found.at)) continue;
						if (found.sample) samples.push(found.sample);
						if (found.at < since || !found.id || seen.has(found.id)) continue;
						seen.add(found.id);
						const t = found.tokens;
						spends.push([found.at, weigh(found.model, t), t.input + t.output + t.cacheRead + t.cacheWrite, found.id]);
					}
				} catch {}
			}
			files[file] = { offset, ino: stat.ino };
		}
	}
	spends.sort((a, b) => a[0] - b[0]);
	return { ledger: { files, spends }, samples: samples.sort((a, b) => a.at - b.at) };
}
