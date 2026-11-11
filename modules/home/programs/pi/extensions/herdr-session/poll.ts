// Claude usage asked of the account itself, so Herdr's panel moves while no agent works.
// Every Pi session ticks, but the sessions share one claim per interval: the attempt file
// says when the account was last asked, and a lock (created exclusively) lets only one
// session ask at a time. A response written by a turn counts as fresh usage too.
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeAtomic } from "./atomic.ts";
import { appendSample } from "./history.ts";
import type { Window } from "./usage.ts";

// The endpoint 429s after a short burst (anthropics/claude-code#31637); failures back off below.
export const INTERVAL = 20_000;
// A lock older than this belongs to a session that died while asking.
const LOCK_TTL = 30_000;
const MAX_BACKOFF = 15 * 60_000;
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export type UsageRecord = {
	at: number;
	fiveHour: Window | null;
	sevenDay: Window | null;
	overageStatus: string | null;
	usingOverage: boolean;
};

type Attempt = { at: number; failures: number };

export type Deps = {
	dir: string;
	now: () => number;
	token: () => Promise<string | null>;
	fetch: typeof fetch;
};

const files = (dir: string) => ({
	usage: path.join(dir, "claude-usage.json"),
	attempt: path.join(dir, "claude-usage.poll.json"),
	lock: path.join(dir, "claude-usage.poll.lock"),
});

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

export { writeAtomic };

// Every write of the usage, from a poll or a response, also lands in the history.
export function writeUsage(dir: string, record: UsageRecord) {
	writeAtomic(files(dir).usage, record);
	try {
		appendSample(dir, record);
	} catch {}
}

// The wait after an attempt: the interval, doubled for each failure in a row.
export function waitAfter(attempt: Attempt | null) {
	if (!attempt) return 0;
	return Math.min(INTERVAL * 2 ** Math.min(attempt.failures, 10), MAX_BACKOFF);
}

export function due(dir: string, now: number) {
	const f = files(dir);
	const usage = readJson<Partial<UsageRecord>>(f.usage);
	if (usage?.at && now - usage.at < INTERVAL) return false;
	const attempt = readJson<Attempt>(f.attempt);
	return !attempt || now - attempt.at >= waitAfter(attempt);
}

function claim(lock: string, now: number) {
	try {
		closeSync(openSync(lock, "wx"));
		return true;
	} catch {
		try {
			if (now - statSync(lock).mtimeMs < LOCK_TTL) return false;
			unlinkSync(lock);
			closeSync(openSync(lock, "wx"));
			return true;
		} catch {
			return false;
		}
	}
}

// The endpoint's windows: utilization 0–100 and an ISO reset, as Claude Code's /usage reads
// them; the record keeps the response headers' units (0–1, epoch seconds). Newer bodies
// also list rows in limits[], keyed by kind.
function windowOf(raw: unknown): Window | null {
	const w = raw as { utilization?: unknown; percent_used?: unknown; resets_at?: unknown } | null;
	if (!w || typeof w !== "object") return null;
	const percent = typeof w.utilization === "number" ? w.utilization : typeof w.percent_used === "number" ? w.percent_used : null;
	if (percent === null) return null;
	const resets = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
	return { utilization: percent / 100, ...(Number.isNaN(resets) ? {} : { resetsAt: Math.round(resets / 1000) }) };
}

export function recordOf(body: unknown, previous: Partial<UsageRecord> | null, now: number): UsageRecord | null {
	const b = (body ?? {}) as { five_hour?: unknown; seven_day?: unknown; limits?: { kind?: string }[] };
	const row = (kind: string) => (Array.isArray(b.limits) ? b.limits.find((l) => l?.kind === kind) : undefined);
	const fiveHour = windowOf(b.five_hour) ?? windowOf(row("session"));
	const sevenDay = windowOf(b.seven_day) ?? windowOf(row("weekly_all"));
	if (!fiveHour && !sevenDay) return null;
	// Overage is only in a response's headers; the last turn's word on it stands.
	return {
		at: now,
		fiveHour,
		sevenDay,
		overageStatus: previous?.overageStatus ?? null,
		usingOverage: previous?.usingOverage === true,
	};
}

async function ask(deps: Deps, previous: Partial<UsageRecord> | null) {
	const token = await deps.token();
	if (!token) return null;
	const response = await deps.fetch(ENDPOINT, {
		headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "pi-herdr-session" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) return null;
	return recordOf(await response.json(), previous, deps.now());
}

// One tick: asks the account if no session has lately, and says whether it did.
export async function poll(deps: Deps): Promise<"skipped" | "written" | "failed"> {
	const f = files(deps.dir);
	if (!due(deps.dir, deps.now()) || !claim(f.lock, deps.now())) return "skipped";
	try {
		// Another session may have written between the check and the claim.
		if (!due(deps.dir, deps.now())) return "skipped";
		const previous = readJson<Partial<UsageRecord>>(f.usage);
		const record = await ask(deps, previous).catch(() => null);
		const failures = record ? 0 : (readJson<Attempt>(f.attempt)?.failures ?? 0) + 1;
		writeAtomic(f.attempt, { at: deps.now(), failures });
		if (!record) return "failed";
		writeUsage(deps.dir, record);
		return "written";
	} finally {
		try {
			unlinkSync(f.lock);
		} catch {}
	}
}

// Claude Code's OAuth login, which pi-claude-code's CLI keeps refreshed: the macOS keychain,
// or ~/.claude/.credentials.json elsewhere. An expired token is left for Claude Code to renew.
export async function claudeToken(now = Date.now()): Promise<string | null> {
	const text =
		process.platform === "darwin"
			? await new Promise<string | null>((resolve) =>
					execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000 }, (error, stdout) =>
						resolve(error ? null : stdout),
					),
				)
			: await readFile(path.join(homedir(), ".claude", ".credentials.json"), "utf8").catch(() => null);
	return tokenOf(text, now);
}

export function tokenOf(text: string | null, now: number) {
	try {
		const oauth = (JSON.parse(text ?? "") as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
		if (!oauth?.accessToken) return null;
		if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
		return oauth.accessToken;
	} catch {
		return null;
	}
}
