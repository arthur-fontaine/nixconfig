import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Deps, INTERVAL, poll, recordOf, tokenOf, waitAfter } from "../poll.ts";

const BODY = {
	five_hour: { utilization: 42, resets_at: "2026-11-06T15:00:00+00:00" },
	seven_day: { utilization: 95, resets_at: "2026-11-10T09:00:00Z" },
};

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "herdr-usage-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(now: { t: number }, answer: () => Response | Promise<Response>) {
	const calls: string[] = [];
	const d: Deps = {
		dir,
		now: () => now.t,
		token: async () => "tok",
		fetch: (async (url: string, init: RequestInit) => {
			calls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
			return answer();
		}) as typeof fetch,
	};
	return { d, calls };
}

const usage = () => JSON.parse(readFileSync(path.join(dir, "claude-usage.json"), "utf8"));

test("the endpoint's windows land in claude-usage.json as the turns write them", async () => {
	const now = { t: 1_000_000 };
	const { d, calls } = deps(now, () => Response.json(BODY));
	assert.equal(await poll(d), "written");
	assert.deepEqual(calls, ["https://api.anthropic.com/api/oauth/usage Bearer tok"]);
	assert.deepEqual(usage(), {
		at: 1_000_000,
		fiveHour: { utilization: 0.42, resetsAt: Date.parse("2026-11-06T15:00:00Z") / 1000 },
		sevenDay: { utilization: 0.95, resetsAt: Date.parse("2026-11-10T09:00:00Z") / 1000 },
		overageStatus: null,
		usingOverage: false,
	});
});

test("many sessions ticking ask the account once per interval", async () => {
	const now = { t: 1_000_000 };
	const { d, calls } = deps(now, () => Response.json(BODY));
	const results = await Promise.all([poll(d), poll(d), poll(d), poll(d)]);
	assert.equal(results.filter((r) => r === "written").length, 1);
	now.t += INTERVAL - 1;
	assert.equal(await poll(d), "skipped");
	now.t += 1;
	assert.equal(await poll(d), "written");
	assert.equal(calls.length, 2);
});

test("a turn's fresh write stands in for an ask, and its overage is kept", async () => {
	const now = { t: 1_000_000 };
	const file = path.join(dir, "claude-usage.json");
	writeFileSync(file, JSON.stringify({ at: now.t - 1000, fiveHour: { utilization: 0.1 }, sevenDay: null, overageStatus: "rejected", usingOverage: true }));
	const { d, calls } = deps(now, () => Response.json(BODY));
	assert.equal(await poll(d), "skipped");
	now.t += INTERVAL;
	assert.equal(await poll(d), "written");
	assert.equal(calls.length, 1);
	assert.equal(usage().overageStatus, "rejected");
	assert.equal(usage().usingOverage, true);
});

test("a lock left by a dead session is taken over once stale, not before", async () => {
	const now = { t: Date.now() };
	const lock = path.join(dir, "claude-usage.poll.lock");
	writeFileSync(lock, "");
	const { d } = deps(now, () => Response.json(BODY));
	assert.equal(await poll(d), "skipped");
	const old = (Date.now() - 60_000) / 1000;
	utimesSync(lock, old, old);
	assert.equal(await poll(d), "written");
});

test("failures back off and leave the last usage alone", async () => {
	const now = { t: 1_000_000 };
	let ok = false;
	const { d, calls } = deps(now, () => (ok ? Response.json(BODY) : new Response("no", { status: 429 })));
	assert.equal(await poll(d), "failed");
	now.t += INTERVAL;
	assert.equal(await poll(d), "skipped"); // waits 2 intervals after one failure
	now.t += INTERVAL;
	assert.equal(await poll(d), "failed");
	now.t += 2 * INTERVAL;
	assert.equal(await poll(d), "skipped"); // 4 intervals after two
	now.t += 2 * INTERVAL;
	ok = true;
	assert.equal(await poll(d), "written");
	assert.equal(calls.length, 3);
	assert.equal(waitAfter({ at: 0, failures: 30 }), 15 * 60_000);
});

test("no token, no request", async () => {
	const now = { t: 1_000_000 };
	const { d, calls } = deps(now, () => Response.json(BODY));
	d.token = async () => null;
	assert.equal(await poll(d), "failed");
	assert.equal(calls.length, 0);
});

test("bodies with limits[] rows or no windows", () => {
	const rows = { limits: [{ kind: "weekly_all", percent_used: 50 }, { kind: "session", utilization: 10, resets_at: null }] };
	assert.deepEqual(recordOf(rows, null, 5), { at: 5, fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.5 }, overageStatus: null, usingOverage: false });
	assert.equal(recordOf({}, null, 5), null);
	assert.equal(recordOf(null, null, 5), null);
});

test("the token is Claude Code's OAuth access token while unexpired", () => {
	const creds = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt } });
	assert.equal(tokenOf(creds(2000), 1000), "a");
	assert.equal(tokenOf(creds(500), 1000), null);
	assert.equal(tokenOf("not json", 1000), null);
	assert.equal(tokenOf(null, 1000), null);
});
