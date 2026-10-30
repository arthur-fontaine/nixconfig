import assert from "node:assert/strict";
import { test } from "node:test";

import { action, decide, describe, headers, logLine, NEVER_ACT, resolveConfig, SPISEV } from "../policy.ts";

const response = (choice: string, p: number) => ({ answers: { boundary: { type: "choice", choice, probabilities: { [choice]: p } } } });

test("there is no default provider", () => {
	const config = resolveConfig({});
	assert.equal(config.provider, undefined);
	assert.equal(config.mode, "suggest");
	assert.equal(config.minConfidence, 0.85);
	assert.equal(config.suggestConfidence, 0.6);
});

test("a cloud endpoint needs its model and key, and the key is never read from the store", () => {
	assert.deepEqual(resolveConfig({ endpoint: "https://x/v1/systemone" }).missing, ["AUTO_COMPACT_MODEL", "AUTO_COMPACT_API_KEY"]);
	const config = resolveConfig({}, { provider: "systemone", endpoint: "https://x", model: "m", apiKey: "stored" });
	assert.equal(config.apiKey, undefined);
	assert.deepEqual(config.missing, ["AUTO_COMPACT_API_KEY"]);
});

test("Spisev runs locally with no key, on a local port", () => {
	const config = resolveConfig({ provider: "spisev" });
	assert.equal(config.endpoint, SPISEV.endpoint);
	assert.equal(config.port, 8766);
	assert.deepEqual(config.missing, []);
	assert.equal(resolveConfig({ provider: "spisev", endpoint: "https://example.com/v1/systemone" }).problems.length, 1);
});

test("the saved mode applies, the environment wins", () => {
	assert.equal(resolveConfig({}, { mode: "auto" }).mode, "auto");
	assert.equal(resolveConfig({ mode: "off" }, { mode: "auto" }).mode, "off");
	assert.equal(resolveConfig({ mode: "nonsense" }).mode, "suggest");
});

test("Baseten keys go in an Api-Key header, others as a bearer token", () => {
	assert.equal(headers({ apiKey: "k", auth: "Api-Key" }).Authorization, "Api-Key k");
	assert.equal(headers({ apiKey: "k", auth: "Bearer" }).Authorization, "Bearer k");
	assert.equal(headers({ apiKey: undefined, auth: "Bearer" }).Authorization, undefined);
});

test("continuation and follow_up never act; auto needs the threshold; suggest offers", () => {
	for (const c of NEVER_ACT) assert.equal(action(c), "keep");
	const auto = { mode: "auto" as const, minConfidence: 0.85 };
	assert.equal(decide(response("follow_up", 0.99), auto).act, false);
	assert.partialDeepStrictEqual(decide(response("independent", 0.9), auto), { act: true, action: "clear" });
	assert.partialDeepStrictEqual(decide(response("related", 0.8), auto), { act: false, reason: "low confidence" });
	assert.partialDeepStrictEqual(decide(response("return", 0.6), { ...auto, mode: "suggest" }), { suggest: true, action: "compact_branch" });
	assert.partialDeepStrictEqual(decide({}, auto), { action: "keep", reason: "no answer" });
});

test("suggest mode does not ask below its own threshold", () => {
	const suggest = resolveConfig({ mode: "suggest" });
	assert.partialDeepStrictEqual(decide(response("independent", 0.4), suggest), { suggest: false, act: false, reason: "low confidence" });
	assert.partialDeepStrictEqual(decide(response("independent", 0.6), suggest), { suggest: true, action: "clear" });
	assert.equal(decide(response("related", 0.5), resolveConfig({ mode: "suggest", suggestConfidence: "0.3" })).suggest, true);
});

test("footer and debug lines", () => {
	const kept = decide(response("follow_up", 0.92), { mode: "suggest", minConfidence: 0.85 });
	assert.equal(describe(kept), "context kept · 92%");
	const related = decide(response("related", 0.71), { mode: "suggest", minConfidence: 0.85 });
	assert.equal(describe(related), "compact? related · 71%");
	const clear = decide(response("independent", 0.91), { mode: "auto", minConfidence: 0.85 });
	assert.equal(describe(clear, true), "cleared · independent · 91%");
	assert.equal(logLine(clear, "cleared"), "[auto-compact] independent · 0.91 → cleared");
});
