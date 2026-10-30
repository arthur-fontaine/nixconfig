import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, clamp, clip, DEFAULTS, decide, normalizeModel, resolveConfig } from "../policy.ts";

const TRUNCATED = "\n[… truncated …]\n".length;

test("endpoint, key, and model come only from the environment", () => {
	const config = resolveConfig({ endpoint: "https://env.example", apiKey: "k", model: "jev-from-env" });
	assert.equal(config.endpoint, "https://env.example");
	assert.equal(config.model, "jev-from-env");
	assert.deepEqual(config.missing, []);
	assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
	assert.deepEqual(resolveConfig({}).missing, ["AUTO_EFFORT_ENDPOINT", "AUTO_EFFORT_API_KEY", "AUTO_EFFORT_MODEL"]);
});

test("bad levels and numbers fall back to defaults", () => {
	const config = resolveConfig({ maxEffort: "huge", minConfidence: "abc" });
	assert.equal(config.maxEffort, "xhigh");
	assert.equal(config.minConfidence, 0.5);
});

test("clamp keeps a level inside the range", () => {
	assert.equal(clamp("max", "low", "high"), "high");
	assert.equal(clamp("low", "medium", "max"), "medium");
	assert.equal(clamp("high", "low", "xhigh"), "high");
});

test("long prompts are truncated at both ends", () => {
	const prompt = "A".repeat(5000) + "B".repeat(5000);
	const sent = buildRequest({ prompt }, resolveConfig({})).state.latest_user_message!;
	assert.ok(sent.length < 6100);
	assert.ok(sent.startsWith("AAA"));
	assert.ok(sent.endsWith("BBB"));
});

test("include_context false sends the prompt alone", () => {
	const body = buildRequest({ prompt: "go", previousReply: "Shall I?" }, resolveConfig({ includeContext: "false" }));
	assert.equal(body.state.previous_assistant_reply, undefined);
});

test("malformed answers keep the session effort", () => {
	const config = resolveConfig({});
	assert.equal(decide({}, config).effort, null);
	assert.equal(decide({ answers: { effort: { type: "choice", choice: "turbo", confidence: 1 } } }, config).effort, null);
});

test("the environment wins over what setup stored, and a key is never read from the store", () => {
	const stored = { provider: "jev", endpoint: "https://stored.example", model: "jev-stored", apiKey: "stored-key" };
	const config = resolveConfig({ endpoint: "https://env.example", model: "jev-env" }, stored);
	assert.equal(config.endpoint, "https://env.example");
	assert.equal(config.model, "jev-env");
	assert.equal(config.apiKey, undefined);
	assert.equal(resolveConfig({}, { provider: "jev", endpoint: "https://stored.example", model: "m" }).endpoint, "https://stored.example");
});

test("the Nisev provider needs no endpoint or key and clips like the training data", () => {
	const config = resolveConfig({ provider: "nisev" });
	assert.deepEqual(config.missing, []);
	assert.equal(config.endpoint, "http://127.0.0.1:8765/v1/systemone");
	const body = buildRequest({ prompt: "x".repeat(5000), previousReply: "y".repeat(2000) }, config);
	assert.equal(Array.from(body.state.latest_user_message!).length, 3000 - 20 + TRUNCATED);
	assert.equal(Array.from(body.state.previous_assistant_reply!).length, 800 - 20 + TRUNCATED);
});

test("clip counts code points, as Python does", () => {
	assert.equal(Array.from(clip("😀".repeat(50), 40)).length, 20 + TRUNCATED);
});

test("model names are normalized", () => {
	assert.equal(normalizeModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
	assert.equal(normalizeModel("us.anthropic.claude-opus-5-5-v1"), "claude-opus-5-5");
	assert.equal(normalizeModel("opus"), "claude-opus-5-5");
	assert.equal(normalizeModel("anthropic/claude-opus-5-5"), "claude-opus-5-5");
});

test("Haiku keeps its own effort on the Nisev provider", () => {
	const config = resolveConfig({ provider: "nisev" });
	const response = { answers: { effort: { type: "choice", choice: "hard", probabilities: { hard: 1 } } } };
	assert.equal(decide(response, config, "claude-haiku-4-5").effort, null);
	assert.equal(decide(response, config, "claude-opus-5-5").effort, "xhigh");
});

test("Cloudflare Workers AI's response, wrapped in result, is read like any other", () => {
	const config = resolveConfig({ endpoint: "https://api.cloudflare.com/x", apiKey: "k", model: "clef-flash" });
	const answer = { type: "choice", choice: "high", confidence: 0.8 };
	assert.equal(decide({ result: { answers: { effort: answer } }, success: true }, config).effort, "high");
});

test("an endpoint in the environment wins over a saved Nisev setup", () => {
	assert.equal(resolveConfig({ endpoint: "https://opencode.ai/zen/v1/systemone" }, { provider: "nisev" }).provider, "jev");
});

test("a saved cloud setup never leaks into Nisev", () => {
	const stored = { provider: "jev", endpoint: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" };
	const config = resolveConfig({ provider: "nisev" }, stored);
	assert.equal(config.model, "arthur-fontaine/nisev-1.7b-GGUF:Q8_0");
	assert.equal(config.endpoint, "http://127.0.0.1:8765/v1/systemone");
	assert.equal(config.port, 8765);
});

test("Nisev needs a local endpoint, whose port it serves on", () => {
	assert.equal(resolveConfig({ provider: "nisev", endpoint: "http://127.0.0.1:9000/v1/systemone" }).port, 9000);
	assert.equal(resolveConfig({ provider: "nisev", endpoint: "https://example.com/v1/systemone" }).problems.length, 1);
});

test("Nisev is asked under its alias, whatever file llama.cpp serves", () => {
	const config = resolveConfig({ provider: "nisev", model: "/models/nisev.gguf" });
	assert.equal(buildRequest({ prompt: "hi" }, config).model, "nisev");
});

test("a cloud endpoint's settings left in the environment are reported for Nisev, not served", () => {
	const { problems } = resolveConfig({ provider: "nisev", endpoint: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" });
	assert.equal(problems.length, 2);
	assert.match(problems[0]!, /AUTO_EFFORT_ENDPOINT is https:\/\/opencode\.ai/);
	assert.match(problems[1]!, /AUTO_EFFORT_MODEL is jev-1\.13/);
});
