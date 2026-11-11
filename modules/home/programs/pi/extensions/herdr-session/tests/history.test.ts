import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { appendSample, HISTORY_KEEP, readHistory, trimHistory } from "../history.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "herdr-history-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => path.join(dir, "claude-usage.history.jsonl");
const record = (at: number, five: number, week = 0.5) => ({
	at,
	fiveHour: { utilization: five, resetsAt: 2000, status: "allowed" },
	sevenDay: { utilization: week, resetsAt: 9000 },
	overageStatus: null,
	usingOverage: false,
});

test("a sample keeps only the windows' utilization and reset", () => {
	appendSample(dir, record(1000, 0.1));
	assert.deepEqual(readHistory(dir), [{ at: 1000, fiveHour: { utilization: 0.1, resetsAt: 2000 }, sevenDay: { utilization: 0.5, resetsAt: 9000 } }]);
});

test("an unchanged sample is skipped until ten minutes have gone by", () => {
	appendSample(dir, record(1000, 0.1));
	appendSample(dir, record(2000, 0.1));
	appendSample(dir, record(3000, 0.11));
	appendSample(dir, record(3000 + 10 * 60_000, 0.11));
	assert.deepEqual(
		readHistory(dir).map((s) => s.at),
		[1000, 3000, 3000 + 10 * 60_000],
	);
});

test("trimming keeps the last two weeks, and a torn line is ignored", () => {
	const now = 100 * 86_400_000;
	appendSample(dir, record(now - HISTORY_KEEP - 1, 0.1));
	appendSample(dir, record(now - HISTORY_KEEP + 1, 0.2));
	writeFileSync(file(), `${readFileSync(file(), "utf8")}{"at":`);
	trimHistory(dir, now);
	assert.deepEqual(
		readHistory(dir).map((s) => s.at),
		[now - HISTORY_KEEP + 1],
	);
	assert.equal(readFileSync(file(), "utf8").split("\n").filter(Boolean).length, 1);
});

test("appending trims once the oldest line is a day past the two weeks", () => {
	const now = 100 * 86_400_000;
	appendSample(dir, record(now - HISTORY_KEEP - 86_400_000 - 2, 0.1));
	appendSample(dir, record(now - HISTORY_KEEP + 5, 0.2));
	assert.equal(readHistory(dir).length, 2);
	appendSample(dir, record(now, 0.3));
	assert.deepEqual(
		readHistory(dir).map((s) => s.at),
		[now - HISTORY_KEEP + 5, now],
	);
});

test("no history reads as empty", () => {
	assert.deepEqual(readHistory(dir), []);
	trimHistory(dir, Date.now());
	assert.deepEqual(readHistory(dir), []);
});
