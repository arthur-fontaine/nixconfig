// The extension's wiring against a stand-in for Pi: no network, no model, no Pi install needed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { cells } from "../debug.ts";
import { autoCompact } from "../extension.ts";
import { systemPromptV2 } from "../summarizer.ts";
import { questionV2 } from "../task.ts";
import { rowsOf } from "../transcript.ts";
import { MEMORY_LIMIT } from "../tree.ts";
import { FIXTURES } from "./fixtures/parity.js";

function answer(choice: string, p: number) {
	const probabilities: Record<string, number> = { continuation: 0, follow_up: 0, related: 0, independent: 0, return: 0 };
	for (const k of Object.keys(probabilities)) probabilities[k] = (1 - p) / 4;
	probabilities[choice] = p;
	return { answers: { boundary: { type: "choice", choice, probabilities, confidence: p } }, usage: { input_tokens: 900 } };
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (text: string, calls: { id: string; name: string; arguments: object }[] = []) => ({
	role: "assistant", timestamp: 0, stopReason: "stop",
	content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", ...c }))],
});
const result = (toolCallId: string, isError = false) => ({ role: "toolResult", toolCallId, toolName: "edit", content: [{ type: "text", text: "ok" }], isError, timestamp: 0 });

const MESSAGES = [
	{ role: "system", content: "You are Pi." },
	user("Add a --verbose flag to the CLI"),
	assistant("Added it in src/cli.py and a test.", [{ id: "t1", name: "edit", arguments: { file_path: "src/cli.py" } }]),
	result("t1"),
	user("thanks, now the README section"),
	assistant("Done."),
];
const LONG = [...MESSAGES.slice(0, 5), assistant("Long reply. ".repeat(100))];

const MAMMOTH = {
	AUTO_COMPACT_ENDPOINT: "https://inference.baseten.co/v1/systemone",
	AUTO_COMPACT_MODEL: "decision-models/baseten-mammoth-27b-latest",
	AUTO_COMPACT_AUTH: "Api-Key",
	AUTO_COMPACT_API_KEY: "test-key",
};

const SERVER_KEY = Symbol.for("pi-auto-compact.server");
const realFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "auto-compact-test-"));
	for (const k of Object.keys(process.env)) if (k.startsWith("AUTO_COMPACT_")) delete process.env[k];
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	process.env.AUTO_COMPACT_DATA_DIR = path.join(dir, "data");
	process.env.AUTO_COMPACT_DEBUG_LOG = path.join(dir, "debug.log");
	delete (globalThis as any)[SERVER_KEY];
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

interface Setup {
	env?: Record<string, string>;
	messages?: unknown[];
	fetch?: (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
	complete?: () => { stopReason: string; text?: string; errorMessage?: string };
	select?: (title: string, options: string[]) => string | undefined;
	compactError?: string;
	mode?: "tui" | "print";
	tokens?: number | null;
	keepRecentTokens?: number;
}

function stub({ env = MAMMOTH, messages = MESSAGES, fetch, complete, select, compactError, mode = "tui", tokens = 82_000, keepRecentTokens }: Setup = {}) {
	Object.assign(process.env, env);
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const commands = new Map<string, any>();
	const seen = {
		requests: [] as { url: string; headers: any; body: any }[],
		completions: [] as any[],
		// The footer is never used: every line goes to the chat.
		statuses: [] as (string | undefined)[],
		// The chat in order: user messages as Pi draws them, and the extension's notices.
		chat: [] as string[],
		compactions: [] as any[],
		compacted: [] as any[],
		summarized: [] as any[],
		selects: [] as string[],
		notified: [] as string[],
		widget: undefined as any,
	};
	const emit = async (name: string, event: any) => {
		let out: unknown;
		for (const handler of handlers.get(name) ?? []) out = (await handler({ type: name, ...event }, ctx)) ?? out;
		return out;
	};
	const ctx: any = {
		mode, hasUI: mode === "tui", cwd: dir, model: { provider: "claude-code", id: "claude-opus-5-5", contextWindow: 200_000 },
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : (tokens / 200_000) * 100 }),
		sessionManager: { getSessionId: () => "session-1", buildSessionProjection: () => ({ messages }) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getAvailable: () => [],
			streamSimple: (model: any, context: any, options: any) => {
				seen.completions.push({ model, context, options });
				const r = complete ? complete() : { stopReason: "stop", text: "task: verbose flag [done]" };
				return { result: async () => ({ stopReason: r.stopReason, errorMessage: r.errorMessage, content: [{ type: "text", text: r.text ?? "" }] }) };
			},
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus: (_key: string, text: string | undefined) => seen.statuses.push(text),
			notify: (text: string, type = "info") => {
				seen.notified.push(text);
				seen.chat.push(type + ": " + text);
			},
			select: async (title: string, options: string[]) => {
				seen.selects.push(title);
				return select?.(title, options);
			},
			setWidget: (_key: string, content: unknown) => {
				seen.widget = content;
			},
		},
		compact: (options: any) => {
			seen.compactions.push(options);
			void (async () => {
				if (compactError) return options.onError(new Error(compactError));
				const out: any = await emit("session_before_compact", {
					reason: "manual", customInstructions: options.customInstructions,
					preparation: { tokensBefore: 1234 }, branchEntries: [], willRetry: false, signal: new AbortController().signal,
				});
				seen.compacted.push(out);
				if (!out?.compaction) return options.onError(new Error("Compaction cancelled"));
				// Pi draws its compaction block before the compaction resolves.
				seen.chat.push("[compaction]");
				options.onComplete({ ...out.compaction, estimatedTokensAfter: 300 });
			})();
		},
	};
	globalThis.fetch = (async (url: string, init?: any) => {
		seen.requests.push({ url: String(url), headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
		const r = fetch ? await fetch(String(url)) : { status: 200, body: answer("follow_up", 0.92) };
		return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
	}) as typeof globalThis.fetch;
	const pi: any = {
		on: (name: string, handler: any) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		getSettings: () => ({ compaction: { reserveTokens: 16_384, ...(keepRecentTokens !== undefined && { keepRecentTokens }) } }),
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	};
	autoCompact(pi, {
		summarizeMessages: (async (...args: unknown[]) => {
			seen.summarized.push(args);
			return { text: "## Goal\nCI for this repo", usage: { input: 1, output: 1 } };
		}) as any,
	});
	// A prompt as Pi sends it: the input hook, then the user message, drawn after the extensions'
	// message_start handlers and before message_end's.
	const input = async (text: string, extra: { streamingBehavior?: string } = {}) => {
		const out = await emit("input", { text, source: "interactive", ...extra });
		if (extra.streamingBehavior) return out;
		const message = user(text);
		await emit("message_start", { message });
		seen.chat.push("user: " + text);
		await emit("message_end", { message });
		return out;
	};
	return {
		seen,
		input,
		lines: () => seen.chat.filter((line) => !line.startsWith("user: ")),
		settle: () => emit("agent_settled", { aborted: false }),
		command: (args: string) => commands.get("auto-compact").handler(args, ctx),
	};
}

const log = () => {
	try {
		return readFileSync(process.env.AUTO_COMPACT_DEBUG_LOG!, "utf8").split("\n").map((l) => l.replace(/^\S+ /, ""));
	} catch {
		return [];
	}
};
const decisions = () => log().filter((l) => l.startsWith("[auto-compact] ") && l.includes(" → "));
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("a follow-up keeps the context, logs the decision and says nothing", async () => {
	const { seen, input, lines } = stub();
	assert.equal(await input("and add a changelog entry for it"), undefined);
	assert.equal(seen.compactions.length, 0);
	assert.deepEqual(decisions(), ["[auto-compact] follow_up · 0.92 → keep"]);
	assert.deepEqual(lines(), []);
});

test("nothing goes to the footer", async () => {
	const { seen, input, command, settle } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("related", 0.9) }) });
	await input("now set up CI for this repo");
	await settle();
	await command("mode off");
	await stub({ env: {} }).input("hello there");
	assert.deepEqual(seen.statuses, []);
});

test("the request is the v2 state the model was trained on, sent with the configured auth", async () => {
	const { seen, input } = stub();
	await input("what is a monad?");
	const [req] = seen.requests;
	assert.equal(req!.url, MAMMOTH.AUTO_COMPACT_ENDPOINT);
	assert.equal(req!.headers.Authorization, "Api-Key test-key");
	assert.equal(req!.body.model, MAMMOTH.AUTO_COMPACT_MODEL);
	assert.deepEqual(Object.keys(req!.body), ["model", "state", "questions"]);
	assert.deepEqual(Object.keys(req!.body.state), ["memory", "last_agent_message", "latest_user_message"]);
	assert.equal(req!.body.state.latest_user_message, "what is a monad?");
	assert.equal(req!.body.state.memory.split("\n")[0], "0+1|user: Add a --verbose flag to the CLI");
	assert.equal(req!.body.state.memory.split("\n").length, 4);
	assert.equal(req!.body.state.last_agent_message, "Done.");
	assert.deepEqual(req!.body.questions.boundary, questionV2());
});

test("in suggest mode nothing happens without the press, and the line says it was your choice", async () => {
	const { seen, input } = stub({ fetch: () => ({ status: 200, body: answer("independent", 0.91) }) });
	await input("unrelated: write me a haiku about rain");
	assert.equal(seen.selects.length, 1);
	assert.match(seen.selects[0]!, /looks independent \(91%\)\. Clear the context first\? The context holds 82k tokens \(41%\)\.$/);
	assert.equal(seen.compactions.length, 0);
	assert.deepEqual(decisions(), ["[auto-compact] independent · 0.91 → suggested"]);
	// Under the prompt: there is no compaction block to go under.
	assert.deepEqual(seen.chat, ["user: unrelated: write me a haiku about rain", "info: Context kept: you chose to send the prompt as is"]);
});

test("in suggest mode the press compacts before the prompt goes on", async () => {
	const { seen, input } = stub({
		fetch: () => ({ status: 200, body: answer("related", 0.7) }),
		select: (_title, options) => options[0],
	});
	await input("now set up CI for this repo");
	assert.equal(seen.compactions.length, 1);
	assert.deepEqual(seen.chat, ["[compaction]", "info: Context compacted, as you chose: this prompt starts a related task", "user: now set up CI for this repo"]);
});

test("with no one to ask (-p), suggest mode keeps the context, and says nothing", async () => {
	const { seen, input, lines } = stub({ fetch: () => ({ status: 200, body: answer("independent", 0.91) }), mode: "print" });
	await input("write me a haiku");
	assert.equal(seen.selects.length, 0);
	assert.equal(seen.compactions.length, 0);
	assert.deepEqual(lines(), []);
});

test("auto compacts a related task with the view lines as what to keep, keeping nothing verbatim", async () => {
	const { seen, input } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("related", 0.9) }) });
	assert.equal(await input("now set up CI for this repo"), undefined); // the prompt goes on, unchanged
	assert.equal(seen.compactions.length, 1);
	assert.match(seen.compactions[0].customInstructions, /0\+1\|user: Add a --verbose flag to the CLI/);
	assert.equal(seen.summarized.length, 1);
	assert.equal(seen.summarized[0][6], seen.compactions[0].customInstructions);
	assert.deepEqual(seen.compacted[0].compaction, {
		summary: "## Goal\nCI for this repo", firstKeptEntryId: null, tokensBefore: 1234, usage: { input: 1, output: 1 },
		details: { autoCompact: { action: "compact_view", category: "related", confidence: 0.9 } },
	});
	// Right under Pi's compaction block, which it explains; the prompt comes after.
	assert.deepEqual(seen.chat, ["[compaction]", "info: Context compacted: this prompt starts a related task", "user: now set up CI for this repo"]);
	assert.ok(log().includes("[auto-compact] compacted, sending the prompt"));
});

test("auto clears an independent task without a summary call, and the prompt still goes", async () => {
	const { seen, input } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("independent", 0.95) }) });
	await input("write a poem");
	assert.equal(seen.summarized.length, 0);
	assert.equal(seen.compacted[0].compaction.firstKeptEntryId, null);
	assert.match(seen.compacted[0].compaction.summary, /cleared/);
	assert.deepEqual(seen.chat, ["[compaction]", "info: Context cleared: this prompt starts an unrelated task", "user: write a poem"]);
	assert.deepEqual(decisions().slice(0, 1), ["[auto-compact] independent · 0.95 → clear"]);
});

test("a session Pi would refuse to compact is not decided at all", async () => {
	for (const setup of [{ tokens: 12_000 }, { tokens: 20_000 }, { tokens: null }, { tokens: 30_000, keepRecentTokens: 40_000 }]) {
		const { seen, input } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("independent", 0.95) }), ...setup });
		await input("write a poem");
		assert.equal(seen.requests.length, 0);
		assert.equal(seen.compacted.length, 0);
		assert.deepEqual(seen.chat, ["user: write a poem"]);
	}
	const { seen, input } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("independent", 0.95) }), tokens: 12_000, keepRecentTokens: 5_000 });
	await input("write a poem");
	assert.equal(seen.requests.length, 1);
});

test("a compaction Pi refuses keeps the context and says why", async () => {
	const { seen, input, command } = stub({
		env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answer("independent", 0.95) }),
		compactError: "Nothing to compact (session too small)",
	});
	await input("write a poem");
	assert.ok(log().includes("[auto-compact] keep (could not clear: Nothing to compact (session too small)), sending the prompt"));
	assert.deepEqual(seen.chat, ["user: write a poem", "warning: Could not clear the context, so it was kept: Nothing to compact (session too small)"]);
	await command("");
	assert.match(seen.notified[1]!, /Clear falls back to keeping the context: Nothing to compact/);
});

test("other compactions are left to Pi", async () => {
	const { seen } = stub();
	const handlers: any[] = [];
	const pi: any = { on: (name: string, h: any) => name === "session_before_compact" && handlers.push(h), registerCommand() {}, exec: async () => ({}) };
	autoCompact(pi, { summarizeMessages: (async () => ({})) as any });
	assert.equal(await handlers[0]({ reason: "manual", customInstructions: "focus on tests" }, {}), undefined);
	assert.equal(await handlers[0]({ reason: "threshold" }, {}), undefined);
	assert.equal(seen.summarized.length, 0);
});

test("auto does not act below the confidence threshold, nor on continuation or follow_up, and says nothing", async () => {
	const answers = [answer("related", 0.6), answer("continuation", 0.99), answer("follow_up", 0.99)];
	const { seen, input, lines } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 200, body: answers.shift() }) });
	for (const text of ["a", "b", "c"]) await input(text);
	assert.equal(seen.compactions.length, 0);
	assert.deepEqual(decisions(), ["[auto-compact] related · 0.60 → keep (low confidence)",
		"[auto-compact] continuation · 0.99 → keep", "[auto-compact] follow_up · 0.99 → keep"]);
	assert.deepEqual(lines(), []);
});

test("with no provider nothing is asked", async () => {
	const { seen, input } = stub({ env: {} });
	await input("hello there");
	await input("and again");
	assert.equal(seen.requests.length, 0);
	// Once, under the first prompt.
	assert.deepEqual(seen.chat, ["user: hello there", "warning: auto-compact: run /auto-compact setup to choose a provider", "user: and again"]);
});

test("a provider error keeps the context", async () => {
	const { seen, input } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, fetch: () => ({ status: 429, body: "slow down" }) });
	await input("next");
	await input("and next");
	assert.equal(seen.compactions.length, 0);
	assert.ok(log().some((l) => l.includes("HTTP 429")));
	// Said once, not on every prompt, under the prompt it happened on.
	assert.deepEqual(seen.chat, ["user: next", "warning: auto-compact: the decision model failed (HTTP 429 slow down); the context is kept.", "user: and next"]);
});

test("a slow provider times out and keeps the context", async () => {
	const { seen, input } = stub({
		env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto", AUTO_COMPACT_TIMEOUT_MS: "50" },
		fetch: () => new Promise(() => {}),
	});
	globalThis.fetch = ((_url: string, init: any) => new Promise((_resolve, reject) => {
		init.signal.addEventListener("abort", () => reject(init.signal.reason));
	})) as typeof fetch;
	await input("next");
	assert.equal(seen.compactions.length, 0);
	assert.ok(log().some((l) => l.includes("timed out after 50ms")));
});

test("a delivery into a running turn and slash commands are left alone", async () => {
	const { seen, input } = stub();
	await input("peer message", { streamingBehavior: "steer" });
	await input("/skill:review the diff");
	assert.equal(seen.requests.length, 0);
});

test("agent_settled builds the summaries with the pinned Haiku and saves them; then the prompt is decided", async () => {
	const { seen, input, settle } = stub({ messages: LONG, mode: "print" });
	await settle();
	assert.equal(seen.completions.length, 1);
	const call = seen.completions[0];
	assert.equal(call.model.id, "claude-haiku-5-5");
	assert.equal(call.model.provider, "claude-code");
	assert.equal(call.options.reasoning, "low");
	assert.equal(call.options.maxTokens, 4096);
	assert.equal(call.context.systemPrompt, systemPromptV2((FIXTURES as any).v2.promptTemplate, MEMORY_LIMIT));
	assert.match(call.context.messages[0].content[0].text, /Compress message 3 into one line\./);
	const saved = JSON.parse(readFileSync(path.join(dir, "data", "trees", "session-1.json"), "utf8"));
	assert.equal(saved.version, 2);
	assert.equal(Object.keys(saved.nodes).length, 1);
	await input("one more thing");
	assert.equal(decisions().length, 1);
	assert.match(seen.requests[0]!.body.state.memory, /3\+1\|task: verbose flag \[done\]/);
	// The reply raw, under its 1,536-byte budget, after the memory line that summarizes it.
	assert.equal(seen.requests[0]!.body.state.last_agent_message, "Long reply. ".repeat(100).trim());
});

test("the summarizer can be any Pi model, by provider/id", async () => {
	const { seen, settle } = stub({ env: { ...MAMMOTH, AUTO_COMPACT_SUMMARIZER_MODEL: "llama/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0" }, messages: LONG, mode: "print" });
	await settle();
	assert.deepEqual(seen.completions[0].model, { provider: "llama", id: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0" });
});

test("with Spisev, agent_settled prefills the state without a message", async () => {
	const models = { data: [{ id: "spisev-alpha" }] };
	const { seen, input, settle } = stub({
		env: { AUTO_COMPACT_PROVIDER: "spisev" }, mode: "print",
		fetch: (url) => ({ status: 200, body: url.endsWith("/v1/models") ? models : answer("follow_up", 0.92) }),
	});
	await settle();
	await tick();
	const asks = () => seen.requests.filter((r) => r.url.endsWith("/v1/systemone"));
	assert.equal(asks().length, 1);
	assert.equal(asks()[0]!.url, "http://127.0.0.1:8766/v1/systemone");
	assert.equal(asks()[0]!.body.model, "spisev-alpha");
	assert.equal(asks()[0]!.body.state.latest_user_message, "");
	await input("one more thing");
	// The decision's state starts with exactly what was prefilled.
	assert.equal(asks()[1]!.body.state.memory, asks()[0]!.body.state.memory);
	assert.equal(asks()[1]!.body.state.last_agent_message, asks()[0]!.body.state.last_agent_message);
	assert.equal(asks()[1]!.body.state.latest_user_message, "one more thing");
});

test("a cloud provider is never sent a prefill", async () => {
	const { seen, settle } = stub({ mode: "print" });
	await settle();
	await tick();
	assert.equal(seen.requests.length, 0);
});

test("a missing summary keeps the context, and only the debug view and the status say why", async () => {
	const { seen, input, lines, command } = stub({ messages: LONG });
	await input("next");
	assert.equal(seen.requests.length, 0);
	assert.deepEqual(lines(), []);
	await command("");
	assert.match(seen.notified[0]!, /Tree: catching up/);
});

test("a usage limit while summarizing pauses the summaries", async () => {
	const { seen, settle } = stub({ messages: LONG, mode: "print", complete: () => ({ stopReason: "error", errorMessage: "429 rate_limit_error" }) });
	await settle();
	assert.deepEqual(seen.notified, ["auto-compact: Claude usage limit, summaries paused. Until they catch up, every prompt keeps the context."]);
});

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

test("the debug view shows the message, the memory sent and the decision", async () => {
	const { seen, input, command } = stub();
	await command("debug");
	await input("and add a changelog entry for it");
	const lines: string[] = seen.widget({}, theme).render(100);
	assert.ok(lines.includes("and add a changelog entry for it"));
	assert.ok(lines.includes("Memory · 4 lines over 4 messages"));
	assert.ok(lines.some((l) => /^0\+1 raw +37 B · +91 left user: Add a --verbose flag to the CLI$/.test(l)));
	assert.ok(lines.some((l) => l.startsWith("follow_up · 92% → keep")));
	assert.ok(lines.includes("outcome: keep"));
	for (const width of [12, 30, 60, 200]) for (const line of seen.widget({}, theme).render(width)) assert.ok(cells(line) <= width, line);
	await command("debug");
	assert.equal(seen.widget, undefined);
});

test("the debug view marks a summarized line with what it was made from, and follows a compaction", async () => {
	const { seen, input, settle, command } = stub({
		env: { ...MAMMOTH, AUTO_COMPACT_MODE: "auto" }, messages: LONG, fetch: () => ({ status: 200, body: answer("related", 0.9) }),
	});
	await settle();
	await tick();
	await command("debug");
	await input("now set up CI");
	const lines: string[] = seen.widget({}, theme).render(120);
	assert.ok(lines.some((l) => /^3\+1 summary +25 B +task: verbose flag \[done\]$/.test(l)));
	assert.ok(lines.some((l) => /↳ message +agent: Long reply/.test(l)));
	assert.ok(lines.includes("outcome: compacted"));
});

test("the debug view says when nothing was sent, and before any prompt", async () => {
	const { seen, input, command } = stub({ messages: LONG });
	await command("debug");
	assert.match(seen.widget({}, theme).render(60)[1], /No prompt looked at yet/);
	await input("next");
	const lines: string[] = seen.widget({}, theme).render(60);
	assert.ok(lines.includes("Not sent."));
	assert.ok(lines.some((l) => l.startsWith("outcome: skipped (summaries catching up")));
});

test("/auto-compact mode is saved for later sessions; the environment wins", async () => {
	const { command, seen } = stub({});
	await command("mode auto");
	assert.match(seen.notified[0]!, /auto-compact mode: auto \(saved for later sessions\)\./);
	assert.equal(JSON.parse(readFileSync(path.join(dir, "agent", "auto-compact", "config.json"), "utf8")).mode, "auto");
	await command("");
	assert.match(seen.notified[1]!, /^auto-compact mode: auto \(acts at ≥ 0\.85\)/);
	await command("mode sometimes");
	assert.equal(seen.notified[2], "Usage: /auto-compact mode off|suggest|auto");
});

test("Pi's tool results mark the failed calls, and summaries and ! commands are left out", () => {
	const rows = rowsOf([
		user("fix it"),
		assistant("", [{ id: "a", name: "bash", arguments: { command: "pytest" } }, { id: "b", name: "read", arguments: { path: "x" } }]),
		result("a", true), result("b"),
		{ role: "compactionSummary", summary: "earlier", tokensBefore: 1, timestamp: 0 },
		{ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
	] as any);
	assert.deepEqual(rows, [
		{ role: "user", text: "fix it", toolUses: [] },
		{ role: "assistant", text: "", toolUses: [{ tool: "bash", input: { command: "pytest" }, isError: true }, { tool: "read", input: { path: "x" } }] },
	]);
});
