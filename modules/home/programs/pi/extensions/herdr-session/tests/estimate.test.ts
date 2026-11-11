import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { REFRESH, refresh, withEstimate } from "../estimate.ts";
import { readHistory } from "../history.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-10T12:00:00Z");

let dir: string;
let sources: { pi: string; claude: string };
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "herdr-estimate-"));
	sources = { pi: path.join(dir, "sessions"), claude: path.join(dir, "projects") };
	mkdirSync(path.join(sources.pi, "--p--"), { recursive: true });
	mkdirSync(path.join(sources.claude, "-p"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Pi turns, 400k weighted tokens to the point, each carrying the utilization it left.
function piLog(windows: number) {
	const lines: string[] = [];
	for (let w = 0; w < windows; w++) {
		const from = NOW - (windows - w) * 5 * HOUR;
		const resetsAt = (from + 5 * HOUR) / 1000;
		let used = 0;
		for (let i = 0; i < 280; i++) {
			const at = from + MIN + i * MIN;
			used += 40_000;
			const utilization = Math.floor(used / 400_000) / 100;
			lines.push(
				JSON.stringify({
					type: "message",
					id: `e${w}-${i}`,
					timestamp: new Date(at).toISOString(),
					message: {
						role: "assistant",
						provider: "claude-code",
						model: "claude-opus-5-5",
						responseId: `msg_${w}_${i}`,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 20_000 },
						diagnostics: [{ type: "claude-code.rate-limit", timestamp: at + 500, details: { unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization: 0.5, resetsAt: NOW / 1000 + 86400 } } } }],
					},
				}),
			);
		}
	}
	writeFileSync(path.join(sources.pi, "--p--", "s.jsonl"), lines.join("\n") + "\n");
}

const record = (five: number) => ({ at: NOW, fiveHour: { utilization: five, resetsAt: NOW / 1000 + 3600 }, sevenDay: { utilization: 0.5 }, overageStatus: null, usingOverage: false });

test("the first refresh builds the history from Pi's responses, then estimates", async () => {
	piLog(3);
	assert.equal(await refresh({ dir, now: NOW, sources }), "written");
	assert.ok(readHistory(dir).length > 50);
	const out = withEstimate(record(0.36), dir);
	const est = out.fiveHour as { tokensLeft: number; estimate: { perPoint: number; stretches: number } };
	// 400k weighted per point; raw = weighted / 2 here (cache writes weigh 2).
	assert.ok(Math.abs(est.estimate.perPoint - 400_000) / 400_000 < 0.05, `perPoint ${est.estimate.perPoint}`);
	assert.ok(Math.abs(est.tokensLeft - 64 * 200_000) / (64 * 200_000) < 0.05, `left ${est.tokensLeft}`);
	// The week moved by nothing: not enough to say.
	const week = out.sevenDay as { tokensLeft: number | null; estimate: { stretches: number; needed: number } };
	assert.equal(week.tokensLeft, null);
	assert.deepEqual([week.estimate.stretches, week.estimate.needed], [0, 8]);
});

test("refreshes are spaced, and one runs at a time", async () => {
	piLog(1);
	const [a, b] = await Promise.all([refresh({ dir, now: NOW, sources }), refresh({ dir, now: NOW, sources })]);
	assert.deepEqual([a, b].sort(), ["skipped", "written"]);
	assert.equal(await refresh({ dir, now: NOW + REFRESH - 1, sources }), "skipped");
	assert.equal(await refresh({ dir, now: NOW + REFRESH, sources }), "written");
	assert.ok(!existsSync(path.join(dir, "claude-usage.estimate.lock")));
});

test("without a model the record is left as it is", () => {
	assert.deepEqual(withEstimate(record(0.2), dir), record(0.2));
});

test("a refresh puts the estimate into claude-usage.json at once", async () => {
	piLog(3);
	writeFileSync(path.join(dir, "claude-usage.json"), JSON.stringify(record(0.5)));
	await refresh({ dir, now: NOW, sources });
	const usage = JSON.parse(readFileSync(path.join(dir, "claude-usage.json"), "utf8"));
	assert.ok(usage.fiveHour.tokensLeft > 0);
	assert.equal(usage.at, NOW);
});
