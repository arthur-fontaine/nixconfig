// The utilization over time, which claude-usage.json alone forgets: one line per change of
// either window (or every ten minutes while nothing changes), two weeks kept. The estimate
// of the tokens left (estimate.ts) reads it against the tokens the session logs spent.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { writeAtomic } from "./atomic.ts";

export const HISTORY_KEEP = 14 * 86_400_000;
const HEARTBEAT = 10 * 60_000;

export type Point = { utilization: number; resetsAt?: number };
export type Sample = { at: number; fiveHour: Point | null; sevenDay: Point | null };
type Windowed = { at: number; fiveHour?: { utilization?: number; resetsAt?: number } | null; sevenDay?: { utilization?: number; resetsAt?: number } | null };

export const historyFile = (dir: string) => path.join(dir, "claude-usage.history.jsonl");

function point(w: Windowed["fiveHour"]): Point | null {
	if (!w || typeof w.utilization !== "number") return null;
	return typeof w.resetsAt === "number" ? { utilization: w.utilization, resetsAt: w.resetsAt } : { utilization: w.utilization };
}

export function sampleOf(record: Windowed): Sample {
	return { at: record.at, fiveHour: point(record.fiveHour), sevenDay: point(record.sevenDay) };
}

function parse(line: string): Sample | null {
	try {
		const s = JSON.parse(line) as Sample;
		return typeof s?.at === "number" ? s : null;
	} catch {
		return null;
	}
}

// The last whole line, from the file's tail: the history is appended from every session.
function lastSample(file: string): Sample | null {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, 4096);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n").filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			const s = parse(lines[i]);
			if (s) return s;
		}
		return null;
	} finally {
		closeSync(fd);
	}
}

const same = (a: Point | null, b: Point | null) => a?.utilization === b?.utilization && a?.resetsAt === b?.resetsAt;

export function appendSample(dir: string, record: Windowed) {
	const sample = sampleOf(record);
	if (!sample.fiveHour && !sample.sevenDay) return;
	const file = historyFile(dir);
	const last = lastSample(file);
	if (last && same(last.fiveHour, sample.fiveHour) && same(last.sevenDay, sample.sevenDay) && sample.at - last.at < HEARTBEAT) return;
	// One short line in append mode: writes from several sessions don't interleave.
	appendFileSync(file, `${JSON.stringify(sample)}\n`);
	// Rewritten a day's worth at a time rather than on every line.
	const first = firstSample(file);
	if (first && first.at < sample.at - HISTORY_KEEP - 86_400_000) trimHistory(dir, sample.at);
}

function firstSample(file: string): Sample | null {
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(512);
			const n = readSync(fd, buffer, 0, 512, 0);
			return parse(buffer.toString("utf8", 0, n).split("\n")[0]);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

export function readHistory(dir: string): Sample[] {
	let text: string;
	try {
		text = readFileSync(historyFile(dir), "utf8");
	} catch {
		return [];
	}
	const samples: Sample[] = [];
	for (const line of text.split("\n")) {
		const s = line ? parse(line) : null;
		if (s) samples.push(s);
	}
	return samples.sort((a, b) => a.at - b.at);
}

export function writeHistory(dir: string, samples: Sample[]) {
	writeAtomic(historyFile(dir), samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""), true);
}

export function trimHistory(dir: string, now: number) {
	const samples = readHistory(dir);
	const kept = samples.filter((s) => s.at >= now - HISTORY_KEEP);
	if (kept.length === samples.length && samples.length > 0) return;
	if (samples.length === 0 && kept.length === 0) return;
	writeHistory(dir, kept);
}
