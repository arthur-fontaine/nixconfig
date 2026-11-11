import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { emptyLedger, readLogs, weigh } from "../ledger.ts";

let root: string;
let pi: string;
let claude: string;
beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "herdr-ledger-"));
	pi = path.join(root, "pi-sessions");
	claude = path.join(root, "claude-projects");
	mkdirSync(path.join(pi, "--proj--"), { recursive: true });
	mkdirSync(path.join(claude, "-proj", "a1b2", "subagents"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-10T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const rateLimit = (at: number, five: number) => ({
	type: "claude-code.rate-limit",
	timestamp: at,
	details: { unifiedWindows: { five_hour: { utilization: five, resetsAt: 5000 }, seven_day: { utilization: 0.5, resetsAt: 9000 } } },
});

function piLine(id: string, minutesAgo: number, provider: string, usage: object, extra: object = {}) {
	return JSON.stringify({
		type: "message",
		id: `e-${id}`,
		timestamp: iso(minutesAgo),
		message: { role: "assistant", provider, model: "claude-opus-5-5", responseId: id, content: [{ type: "text", text: "secret" }], usage, ...extra },
	});
}

function claudeLine(id: string, minutesAgo: number, model: string, usage: object, block = 0) {
	return JSON.stringify({
		type: "assistant",
		uuid: `u-${id}-${block}`,
		requestId: `req-${id}`,
		timestamp: iso(minutesAgo),
		entrypoint: "cli",
		message: { id, model, role: "assistant", content: [{ type: "text", text: "secret" }], usage },
	});
}

const piUsage = (o: number) => ({ input: 10, output: o, cacheRead: 1000, cacheWrite: 100, totalTokens: 1110 + o });
const ccUsage = (o: number) => ({ input_tokens: 10, output_tokens: o, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 });

test("tokens weigh by kind and model, Opus input being the unit", () => {
	const u = { input: 100, output: 10, cacheRead: 1000, cacheWrite: 10 };
	assert.equal(weigh("claude-opus-5-5", u), 100 + 50 + 50 + 20);
	assert.equal(weigh("claude-sonnet-5-5", u), (100 + 50 + 50 + 20) * 0.6);
	assert.equal(weigh("claude-haiku-5-5", u), (100 + 50 + 50 + 20) * 0.2);
	assert.equal(weigh("claude-fable-5-1", u), 220);
});

test("both logs count, subscription messages only, each message once", async () => {
	const piFile = path.join(pi, "--proj--", "s1.jsonl");
	writeFileSync(
		piFile,
		[
			JSON.stringify({ type: "session", id: "s1" }),
			piLine("msg_pi1", 30, "claude-code", piUsage(100)),
			piLine("msg_other", 29, "openai-codex", piUsage(999)),
			piLine("msg_api", 28, "anthropic", piUsage(999)),
			// Pi's own turn, also persisted by the Claude Code CLI it drives.
			piLine("msg_shared", 27, "claude-code", piUsage(50)),
		].join("\n") + "\n",
	);
	// A fork copies earlier messages into a new file.
	writeFileSync(path.join(pi, "--proj--", "s2.jsonl"), piLine("msg_pi1", 30, "claude-code", piUsage(100)) + "\n");
	writeFileSync(
		path.join(claude, "-proj", "a1b2.jsonl"),
		[
			JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
			// One line per content block, the same usage on each.
			claudeLine("msg_cc1", 20, "claude-opus-5-5", ccUsage(200), 0),
			claudeLine("msg_cc1", 20, "claude-opus-5-5", ccUsage(200), 1),
			claudeLine("msg_shared", 27, "claude-opus-5-5", ccUsage(50)),
			claudeLine("msg_syn", 19, "<synthetic>", ccUsage(0)),
		].join("\n") + "\n",
	);
	writeFileSync(path.join(claude, "-proj", "a1b2", "subagents", "agent-x.jsonl"), claudeLine("msg_sub", 10, "claude-haiku-5-5", ccUsage(10)) + "\n");

	const { ledger } = await readLogs(emptyLedger(), { pi, claude }, NOW);
	const ids = ledger.spends.map((s) => s[3]).sort();
	assert.deepEqual(ids, ["msg_cc1", "msg_pi1", "msg_shared", "msg_sub"]);
	const pi1 = ledger.spends.find((s) => s[3] === "msg_pi1")!;
	assert.equal(pi1[0], NOW - 30 * 60_000);
	assert.equal(pi1[1], weigh("claude-opus-5-5", { input: 10, output: 100, cacheRead: 1000, cacheWrite: 100 }));
	assert.equal(pi1[2], 1210);
	const sub = ledger.spends.find((s) => s[3] === "msg_sub")!;
	assert.equal(sub[1], weigh("claude-haiku-5-5", { input: 10, output: 10, cacheRead: 1000, cacheWrite: 100 }));
});

test("a second read takes only the new lines, and waits for a torn one to finish", async () => {
	const file = path.join(claude, "-proj", "a1b2.jsonl");
	writeFileSync(file, claudeLine("msg_a", 20, "claude-opus-5-5", ccUsage(1)) + "\n");
	let { ledger } = await readLogs(emptyLedger(), { pi, claude }, NOW);
	assert.equal(ledger.spends.length, 1);
	const line = claudeLine("msg_b", 10, "claude-opus-5-5", ccUsage(2));
	appendFileSync(file, line.slice(0, 40));
	({ ledger } = await readLogs(ledger, { pi, claude }, NOW));
	assert.equal(ledger.spends.length, 1);
	const offset = ledger.files[file].offset;
	appendFileSync(file, `${line.slice(40)}\n`);
	({ ledger } = await readLogs(ledger, { pi, claude }, NOW));
	assert.deepEqual(
		ledger.spends.map((s) => s[3]),
		["msg_a", "msg_b"],
	);
	assert.ok(ledger.files[file].offset > offset);
});

test("files untouched for two weeks are skipped, and spends older than that are dropped", async () => {
	const old = path.join(claude, "-proj", "old.jsonl");
	writeFileSync(old, claudeLine("msg_old", 60, "claude-opus-5-5", ccUsage(1)) + "\n");
	const stale = (NOW - 20 * 86_400_000) / 1000;
	utimesSync(old, stale, stale);
	const recent = path.join(claude, "-proj", "recent.jsonl");
	writeFileSync(recent, [claudeLine("msg_ancient", 15 * 24 * 60, "claude-opus-5-5", ccUsage(1)), claudeLine("msg_new", 5, "claude-opus-5-5", ccUsage(1))].join("\n") + "\n");
	const { ledger } = await readLogs(emptyLedger(), { pi, claude }, NOW);
	assert.deepEqual(
		ledger.spends.map((s) => s[3]),
		["msg_new"],
	);
	assert.ok(ledger.files[old].offset > 0);
});

test("asked to, the reader also returns the utilization Pi's responses carried", async () => {
	const at = NOW - 5 * 60_000;
	writeFileSync(path.join(pi, "--proj--", "s1.jsonl"), piLine("msg_pi1", 5, "claude-code", piUsage(1), { diagnostics: [{ type: "other" }, rateLimit(at, 0.42)] }) + "\n");
	const plain = await readLogs(emptyLedger(), { pi, claude }, NOW);
	assert.deepEqual(plain.samples, []);
	const { samples } = await readLogs(emptyLedger(), { pi, claude }, NOW, { samples: true });
	assert.deepEqual(samples, [{ at, fiveHour: { utilization: 0.42, resetsAt: 5000 }, sevenDay: { utilization: 0.5, resetsAt: 9000 } }]);
});

test("a file that shrank is read again from the start", async () => {
	const file = path.join(claude, "-proj", "a1b2.jsonl");
	writeFileSync(file, [claudeLine("msg_a", 20, "claude-opus-5-5", ccUsage(1)), claudeLine("msg_b", 19, "claude-opus-5-5", ccUsage(1))].join("\n") + "\n");
	let { ledger } = await readLogs(emptyLedger(), { pi, claude }, NOW);
	writeFileSync(file, claudeLine("msg_c", 2, "claude-opus-5-5", ccUsage(1)) + "\n");
	({ ledger } = await readLogs(ledger, { pi, claude }, NOW));
	assert.deepEqual(
		ledger.spends.map((s) => s[3]),
		["msg_a", "msg_b", "msg_c"],
	);
});
