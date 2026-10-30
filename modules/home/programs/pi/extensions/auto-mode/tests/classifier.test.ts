import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { classify, type Complete, parseCategory, parseSeverity, type Reply, type Request, stage1TimeoutMs } from "../classifier.ts";
import { loadTemplates, SUFFIX } from "../prompt.ts";

loadTemplates(path.join(path.dirname(process.argv[1]!), ".."));

const ok = (text: string): Reply => ({ text, stop: "stop" });
const fail = (error: string): Reply => ({ text: "", stop: "error", error });

function scripted(...replies: Reply[]) {
	const requests: Request[] = [];
	const complete: Complete = async (r) => {
		requests.push(r);
		const next = replies.shift();
		assert.ok(next, "unexpected request");
		return next;
	};
	return { complete, requests };
}

const run = (complete: Complete, thresholds: { t1: number; t2: number } | null = { t1: 25, t2: 35 }) =>
	classify(complete, {
		system: "S",
		leading: [],
		transcript: "<transcript>\n</transcript>\n",
		thresholds,
		tokens: 1000,
		signal: new AbortController().signal,
		delay: async () => {},
	});

test("severity is read only from a reply that ended on its own, outside thinking", () => {
	assert.equal(parseSeverity(ok("<severity>12</severity>")), 12);
	assert.equal(parseSeverity(ok("<thinking>maybe <severity>90</severity></thinking><severity>40")), 40);
	assert.equal(parseSeverity(ok("<thinking>unfinished <severity>3")), null);
	assert.equal(parseSeverity(ok("<severity>1</severity><severity>2</severity>")), null);
	assert.equal(parseSeverity({ text: "<severity>1", stop: "length" }), null);
});

test("a category must name a known rule", () => {
	assert.deepEqual(parseCategory("<category>Data Exfiltration</category>"), { slug: "data_exfiltration", name: "Data Exfiltration" });
	assert.equal(parseCategory("<category>Made Up</category>"), undefined);
	assert.equal(parseCategory("<category>Git Destructive</category><category>Data Exfiltration</category>"), undefined);
});

test("stage 1's timeout grows with the transcript", () => {
	assert.equal(stage1TimeoutMs(10_000), 60_000);
	assert.equal(stage1TimeoutMs(50_001), 70_000);
	assert.equal(stage1TimeoutMs(160_000), 90_000);
	assert.equal(stage1TimeoutMs(2_000_000), 120_000);
});

test("a clear stage-1 allow ends the check", async () => {
	const { complete, requests } = scripted(ok("<severity>5</severity>"));
	assert.deepEqual(await run(complete), { kind: "allow", reason: "Allowed by fast classifier", stage: "fast", severity: 5 });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.maxTokens, 64);
	assert.equal(requests[0]!.stopSequence, "</severity>");
	assert.ok(requests[0]!.transcript.endsWith(SUFFIX.severity1));
});

test("a stage-1 block goes to stage 2, which decides", async () => {
	const allowed = scripted(ok("<severity>60</severity>"), ok("<thinking>user asked</thinking><severity>30</severity>"));
	assert.equal((await run(allowed.complete)).kind, "allow");
	assert.equal(allowed.requests[1]!.maxTokens, 8192);
	assert.ok(allowed.requests[1]!.transcript.endsWith(SUFFIX.severity2));

	const blocked = scripted(ok("<severity>60</severity>"), ok("<thinking>no</thinking><severity>80</severity><category>Data Exfiltration</category>"));
	assert.deepEqual(await run(blocked.complete), { kind: "block", stage: "thinking", reason: "[Data Exfiltration]", category: "data_exfiltration", severity: 80 });
});

test("an allow with extra text is set aside for stage 2", async () => {
	const { complete, requests } = scripted(ok("<severity>5</severity> looks fine"), ok("<severity>90</severity>"));
	assert.deepEqual(await run(complete), { kind: "block", stage: "thinking", reason: "Blocked by classifier", severity: 90 });
	assert.equal(requests.length, 2);
});

test("unparseable replies are asked again, then fail closed", async () => {
	const { complete, requests } = scripted(ok("<severity>10</severity>"));
	assert.equal((await run(complete)).kind, "allow");
	assert.equal(requests.length, 1);

	const garbage = Array.from({ length: 10 }, () => ok("I think it's fine"));
	const bad = scripted(...garbage);
	assert.deepEqual(await run(bad.complete), {
		kind: "parse_failure",
		reason: "Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details",
	});
	assert.equal(bad.requests.length, 10);
});

test("API failures: retried when transient, then unavailable; after stage 1, a block", async () => {
	const down = scripted(...Array.from({ length: 5 }, () => fail("529 overloaded")));
	assert.deepEqual(await run(down.complete), {
		kind: "unavailable",
		reason: "Classifier unavailable - blocking for safety",
		status: " (overloaded)",
		error: "529 overloaded",
	});
	assert.equal(down.requests.length, 5);

	const flaky = scripted(fail("socket hang up"), ok("<severity>1</severity>"));
	assert.equal((await run(flaky.complete)).kind, "allow");

	const stage2 = scripted(ok("<severity>70</severity>"), fail("Claude Code exited with code 1"));
	const verdict = await run(stage2.complete);
	assert.equal(verdict.kind, "block");
	assert.match(verdict.reason, /^Stage 2 classifier error/);
});

test("refusals and oversized transcripts", async () => {
	assert.equal((await run(scripted(fail("The model refused to complete the request"), ok("garbage")).complete)).kind, "refusal");
	assert.deepEqual(await run(scripted(ok("<severity>70</severity><category>Git Destructive</category>"), fail("The model refused to complete the request")).complete), {
		kind: "block",
		stage: "fast",
		reason: "[Git Destructive]",
		category: "git_destructive",
		severity: 70,
	});
	assert.equal((await run(scripted(fail("prompt is too long: 250000 tokens > 200000 maximum")).complete)).kind, "too_long");
});

test("models without severity thresholds answer <block>", async () => {
	const { complete, requests } = scripted(ok("<block>no</block>"));
	assert.equal((await run(complete, null)).kind, "allow");
	assert.equal(requests[0]!.stopSequence, "</block>");
	const blocked = scripted(ok("<block>yes"), ok("<thinking>x</thinking><block>yes</block><reason>[Git Destructive] force push</reason>"));
	assert.deepEqual(await run(blocked.complete, null), { kind: "block", stage: "thinking", reason: "[Git Destructive] force push" });
});
