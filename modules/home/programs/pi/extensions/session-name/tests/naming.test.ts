import assert from "node:assert/strict";
import { test } from "node:test";
import {
	condense,
	decide,
	ENTRY_TYPE,
	type EntryLike,
	MAX_CHARS,
	parseReply,
	POLICY,
	progress,
	recentExchange,
	restoreMode,
	sanitize,
	shouldCheck,
	toAddress,
	uniqueName,
} from "../naming.ts";

const user = (text: string, timestamp?: string): EntryLike => ({ type: "message", timestamp, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, timestamp?: string): EntryLike => ({ type: "message", timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });
const modeEntry = (mode: string, name?: string): EntryLike => ({ type: "custom", customType: ENTRY_TYPE, data: { mode, name } });

test("sanitize is Claude Code's: format and control characters out, 200 code points", () => {
	assert.equal(sanitize("  fix\u200Bthe\u0007bug\n "), "fix the bug");
	assert.equal([...sanitize("é".repeat(300))].length, 200);
});

test("names become lowercase kebab-case addresses cut at a word", () => {
	assert.equal(toAddress("Fix Login Bug"), "fix-login-bug");
	assert.equal(toAddress("auth_v2 / API client!"), "auth-v2-api-client");
	assert.equal(toAddress("don't  stop"), "dont-stop");
	assert.equal(toAddress("Réparer l'écran"), "réparer-lécran");
	assert.equal(toAddress("!!!"), "");
	const long = toAddress("refactor the authentication middleware for the billing service now");
	assert.ok(long.length <= MAX_CHARS && !long.endsWith("-"), long);
	assert.equal(toAddress("a".repeat(60)).length, MAX_CHARS);
});

test("a name held by another live session gets a number", () => {
	assert.equal(uniqueName("fix-login-bug", ["other"]), "fix-login-bug");
	assert.equal(uniqueName("fix-login-bug", ["Fix-Login-Bug"]), "fix-login-bug-2");
	assert.equal(uniqueName("fix-login-bug", ["fix login bug", "fix-login-bug-2"]), "fix-login-bug-3");
	assert.ok(uniqueName("a".repeat(MAX_CHARS), ["a".repeat(MAX_CHARS)]).length <= MAX_CHARS);
});

test("replies are read as JSON first, then as a bare name", () => {
	assert.deepEqual(parseReply('{"name": "fix-login-bug"}'), { action: "rename", name: "fix-login-bug" });
	assert.deepEqual(parseReply('```json\n{"action":"rename","name":"add-auth"}\n```'), { action: "rename", name: "add-auth" });
	assert.deepEqual(parseReply('{"action": "keep"}'), { action: "keep" });
	assert.deepEqual(parseReply("keep"), { action: "keep" });
	assert.deepEqual(parseReply("`debug-test-failures`"), { action: "rename", name: "debug-test-failures" });
	assert.equal(parseReply("I cannot name this session."), undefined);
	assert.equal(parseReply('{"action": "rename"}'), undefined);
});

test("only a different task renames; drift keeps the address", () => {
	assert.deepEqual(decide("fix-login-bug", { action: "keep" }), { kind: "keep" });
	assert.deepEqual(decide("fix-login-bug", undefined), { kind: "keep" });
	assert.deepEqual(decide("fix-login-bug", { action: "rename", name: "fix-login-bug" }), { kind: "keep" });
	assert.deepEqual(decide("fix-login-bug", { action: "rename", name: "fix-login-bug-tests" }), { kind: "keep" });
	assert.deepEqual(decide("fix-login-bug-2", { action: "rename", name: "login-bug" }), { kind: "keep" });
	assert.deepEqual(decide("fix-login-bug", { action: "rename", name: "Add Billing Export" }), { kind: "rename", name: "add-billing-export" });
	assert.deepEqual(decide("fix-login-bug", { action: "rename", name: "!!!" }), { kind: "keep" });
});

test("re-checks wait for a new prompt, enough new text and the interval", () => {
	const last = { prompts: 2, chars: 1000, at: 0, keeps: 0 };
	const later = POLICY.minIntervalMs;
	assert.equal(shouldCheck(last, { prompts: 2, chars: 9000 }, later), "wait", "no new prompt");
	assert.equal(shouldCheck(last, { prompts: 3, chars: 1100 }, later), "wait", "too little new text");
	assert.equal(shouldCheck(last, { prompts: 3, chars: 3000 }, later - 1), "wait", "too soon");
	assert.equal(shouldCheck(last, { prompts: 3, chars: 3000 }, later), "check");
	assert.equal(shouldCheck(last, { prompts: 1, chars: 400 }, later), "rebase");
});

test("each keep in a row doubles the interval, up to the cap", () => {
	const now = { prompts: 9, chars: 90_000 };
	assert.equal(shouldCheck({ prompts: 1, chars: 0, at: 0, keeps: 2 }, now, POLICY.minIntervalMs * 3), "wait");
	assert.equal(shouldCheck({ prompts: 1, chars: 0, at: 0, keeps: 2 }, now, POLICY.minIntervalMs * 4), "check");
	assert.equal(shouldCheck({ prompts: 1, chars: 0, at: 0, keeps: 20 }, now, POLICY.maxIntervalMs), "check");
});

test("the condensed conversation is user and assistant text, its tail when long", () => {
	const entries: EntryLike[] = [
		user("Fix the login bug"),
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "Found it." }] } },
		{ type: "custom_message", customType: "intercom_message", content: "**From api** please also check logout" },
		{ type: "custom_message", customType: "other", content: "noise" },
	];
	assert.equal(condense(entries), "User: Fix the login bug\nAssistant: Found it.\nMessage from another session: **From api** please also check logout");
	assert.ok(condense([user("x".repeat(5000))], 1000).length <= 1000);
	assert.deepEqual(progress(entries), { prompts: 1, chars: condense(entries, Infinity).length });
});

test("recent intercom traffic is seen; older traffic is not", () => {
	const now = Date.parse("2026-10-30T12:00:00Z");
	const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
	const call: EntryLike = { type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "toolCall", name: "intercom" }] } };
	const incoming: EntryLike = { type: "custom_message", customType: "intercom_message", timestamp: at(3), content: "hi" };
	assert.equal(recentExchange([user("a", at(1))], now), false);
	assert.equal(recentExchange([call, user("a", at(1))], now), true);
	assert.equal(recentExchange([incoming, assistant("ok", at(1))], now), true);
	assert.equal(recentExchange([{ ...incoming, timestamp: at(30) }, user("a", at(20))], now), false);
});

test("the mode survives a resume, and a name given outside the extension is manual", () => {
	assert.equal(restoreMode([], undefined), "auto");
	assert.equal(restoreMode([], "from-pi-name"), "manual");
	assert.equal(restoreMode([modeEntry("auto", "fix-login-bug")], "fix-login-bug"), "auto");
	assert.equal(restoreMode([modeEntry("auto", "fix-login-bug")], "changed-by-name"), "manual");
	assert.equal(restoreMode([modeEntry("manual", "mine")], "mine"), "manual");
	assert.equal(restoreMode([modeEntry("manual", "mine"), modeEntry("auto", "generated")], "generated"), "auto");
	assert.equal(restoreMode([modeEntry("auto", "a"), { type: "custom", customType: ENTRY_TYPE, data: { mode: "bogus" } }], "a"), "auto");
});
