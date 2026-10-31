// The extension against a fake Pi: handlers are driven in the order Pi fires them, and
// fetch, llama.cpp and the store are stubbed. No network, no process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { autoEffort, type Deps } from "../index.ts";

type Reply = { status?: number; body: unknown } | Error | Promise<never>;

interface Setup {
	env?: Record<string, string>;
	fetch?: (url: string, init: RequestInit) => Reply;
	model?: { id: string; reasoning: boolean };
	level?: string;
	saved?: Record<string, any>;
	run?: Deps["run"];
	// What llama-server prints right after it starts; it then keeps running.
	serverOutput?: string;
	// Answers to the setup's questions, in order.
	answers?: (string | boolean)[];
}

const ENV = {
	AUTO_EFFORT_ENDPOINT: "https://jev.example/v1/systemone",
	AUTO_EFFORT_API_KEY: "test-key",
	AUTO_EFFORT_MODEL: "jev-test",
};

function jevReply(choice: string, confidence: number): Reply {
	return {
		body: {
			model: "jev-1.13.0",
			answers: { effort: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } },
			usage: { input_tokens: 300, output_tokens: 20 },
		},
	};
}

function harness({ env = ENV, fetch: respond, model = { id: "claude-opus-5-5", reasoning: true }, level = "medium", saved = {}, run, serverOutput, answers = [] }: Setup = {}) {
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const commands = new Map<string, any>();
	let thinking = level;
	const seen = {
		requests: [] as { url: string; headers: any; body: any }[],
		// The footer is never used: every line goes to the chat.
		statuses: [] as (string | undefined)[],
		notices: [] as string[],
		// The chat in order: user messages as Pi draws them, and the extension's notices.
		chat: [] as string[],
		spawned: [] as string[][],
		levels: [] as string[],
	};
	async function emit(type: string, event: object = {}) {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	}
	const pi = {
		on(type: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(type, [...(handlers.get(type) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		getThinkingLevel: () => thinking,
		// Like Pi: the change is recorded, and thinking_level_select follows asynchronously.
		setThinkingLevel(next: string) {
			const previousLevel = thinking;
			if (next === previousLevel) return;
			thinking = next;
			seen.levels.push(next);
			void Promise.resolve().then(() => emit("thinking_level_select", { level: next, previousLevel }));
		},
	};
	const ui = {
		setStatus: (_key: string, text: string | undefined) => seen.statuses.push(text),
		notify: (text: string, type = "info") => {
			seen.notices.push(text);
			seen.chat.push(`${type}: ${text}`);
		},
		select: async () => answers.shift(),
		input: async () => answers.shift(),
		confirm: async () => answers.shift() === true,
	};
	const ctx = {
		ui,
		hasUI: true,
		model,
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Look at the parser" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Shall I refactor the parser?" }] } },
			],
		},
	};
	const deps: Deps = {
		env: () => env,
		fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input);
			seen.requests.push({ url, headers: init.headers, body: JSON.parse(String(init.body ?? "{}")) });
			const reply = await (respond ? respond(url, init) : jevReply("high", 0.9));
			if (reply instanceof Error) throw reply;
			return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
		}) as typeof fetch,
		run: run ?? (async () => ({ stdout: "version: 0.5.0-dev (build 11408, commit 9f12cd4)", stderr: "" })),
		spawn(argv, onOutput) {
			seen.spawned.push(argv);
			if (serverOutput === undefined) return { kill() {}, done: Promise.resolve() };
			onOutput(serverOutput);
			return { kill() {}, done: new Promise<void>(() => {}) };
		},
		store: {
			get: async (key) => saved[key],
			set: async (key, value) => {
				saved[key] = value;
			},
		},
		holder: {},
		log() {},
	};
	autoEffort(pi as any, deps);

	const flush = () => new Promise((resolve) => setImmediate(resolve));
	// The user message entering the transcript; the level it runs at is the one Pi reads next.
	// Like Pi, the message is drawn after the extensions' message_start handlers.
	async function deliver(text: string) {
		const message = { role: "user", content: [{ type: "text", text }] };
		await emit("message_start", { message });
		seen.chat.push(`user: ${text}`);
		await emit("message_end", { message });
		await flush();
		return thinking;
	}
	async function input(text: string, streamingBehavior?: "steer" | "followUp") {
		await emit("input", { text, source: "interactive", streamingBehavior });
	}
	async function start(text: string) {
		await emit("before_agent_start", { messageType: "user", prompt: text });
		return deliver(text);
	}
	async function settle() {
		await emit("agent_settled", { aborted: false });
		await flush();
	}
	// A prompt sent while idle, run to the end; returns the level it ran at.
	async function prompt(text: string) {
		await input(text);
		const ran = await start(text);
		await settle();
		return ran;
	}
	async function command(args: string) {
		const before = seen.notices.length;
		await commands.get("auto-effort").handler(args, ctx);
		return seen.notices.slice(before).join("\n");
	}
	// The extension's lines in the chat, without the user messages.
	const lines = () => seen.chat.filter((line) => !line.startsWith("user: "));
	return { ctx: ctx as any, emit, input, start, deliver, settle, prompt, command, seen, lines, level: () => thinking, setLevel: pi.setThinkingLevel, flush };
}

test("a confident Jev answer sets the thinking level of the run, then the session's comes back", async () => {
	const h = harness();
	assert.equal(await h.prompt("Migrate every module from callbacks to async/await and make the tests pass"), "high");
	assert.equal(h.level(), "medium");
	assert.deepEqual(h.seen.levels, ["high", "medium"]);
	// Right under the prompt it applies to, once.
	assert.deepEqual(h.seen.chat, [
		"user: Migrate every module from callbacks to async/await and make the tests pass",
		"info: Thinking for this prompt: high, for multi-step work",
	]);
});

test("nothing goes to the footer", async () => {
	const h = harness();
	await h.prompt("Migrate the build to Vite");
	await h.command("off");
	await h.prompt("Migrate the build to Vite");
	await h.command("on");
	const nisev = harness({ env: NISEV_ENV, fetch: refused, serverOutput: "llama_model_loader: downloading 42%" });
	await nisev.emit("session_start", { reason: "startup" });
	await nisev.prompt("Refactor the parser");
	assert.deepEqual([...h.seen.statuses, ...nisev.seen.statuses], []);
});

test("a lower pick says so, and the status names the level the last decision kept", async () => {
	let fail = false;
	const h = harness({ fetch: () => (fail ? new TypeError("fetch failed") : jevReply("low", 0.8)) });
	assert.equal(await h.prompt("Fix the typo in the README"), "low");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: low, for a quick request"]);
	fail = true;
	await h.prompt("Fix the typo in the README");
	const text = await h.command("status");
	assert.match(text, /Last decision: kept medium \(endpoint unavailable\), in \d+ ms/);
	assert.doesNotMatch(text, /default/);
	assert.match(text, /Thinking level: medium/);
	assert.match(text, /Last problem: effort request failed: fetch failed/);
});

test("the status names the level a decision ran at, not \"default\"", async () => {
	const h = harness({ fetch: () => jevReply("default", 0.7), level: "high" });
	await h.prompt("Add a --verbose flag to the CLI");
	assert.match(await h.command("status"), /Last decision: set to medium, for a small change \(70% sure\)/);
	const unsure = harness({ fetch: () => jevReply("low", 0.3), level: "high" });
	await unsure.prompt("hmm");
	assert.match(await unsure.command("status"), /Last decision: kept high; it leaned to low but was only 30% sure/);
	const raised = harness();
	await raised.prompt("Migrate the build to Vite");
	assert.match(await raised.command("status"), /Last decision: set to high, for multi-step work \(90% sure\)/);
});

test("the request goes to the configured endpoint with the key and model", async () => {
	const h = harness({ env: { AUTO_EFFORT_API_KEY: "k-123", AUTO_EFFORT_ENDPOINT: "https://other.example/v1/systemone", AUTO_EFFORT_MODEL: "jev-1.13-free" } });
	await h.prompt("yes, do it");
	assert.equal(h.seen.requests.length, 1);
	const [req] = h.seen.requests;
	assert.equal(req!.url, "https://other.example/v1/systemone");
	assert.equal(req!.headers.Authorization, "Bearer k-123");
	assert.equal(req!.body.model, "jev-1.13-free");
	assert.equal(req!.body.state.latest_user_message, "yes, do it");
	assert.equal(req!.body.state.previous_assistant_reply, "Shall I refactor the parser?");
	assert.equal(req!.body.state.model, "claude-opus-5-5");
	assert.deepEqual(Object.keys(req!.body.questions.effort.criteria), ["low", "medium", "default", "high", "xhigh", "max"]);
});

test('"default" applies the model\'s own level, and says so', async () => {
	const same = harness({ fetch: () => jevReply("default", 0.95) });
	assert.equal(await same.prompt("Add a --verbose flag to the CLI"), "medium");
	assert.deepEqual(same.lines(), ["info: Thinking for this prompt: medium, for a small change"]);
	const h = harness({ fetch: () => jevReply("default", 0.95), level: "high" });
	assert.equal(await h.prompt("Add a --verbose flag to the CLI"), "medium");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: medium, for a small change"]);
});

test("a low-confidence answer keeps the session effort, and says so every time", async () => {
	const h = harness({ fetch: () => jevReply("low", 0.3) });
	assert.equal(await h.prompt("hmm"), "medium");
	assert.equal(await h.prompt("hmm again"), "medium");
	assert.deepEqual(h.lines(), [
		"info: Thinking kept at: medium, the picker leaned to low but was unsure",
		"info: Thinking kept at: medium, the picker leaned to low but was unsure",
	]);
});

test("a pick equal to the session's level still says so, so you see the picker ran", async () => {
	const h = harness({ level: "high" });
	assert.equal(await h.prompt("Migrate the build to Vite"), "high");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: high, for multi-step work"]);
});

test("the pick is capped at max_effort", async () => {
	const h = harness({ fetch: () => jevReply("max", 0.99) });
	assert.equal(await h.prompt("Audit every endpoint, leave nothing unchecked"), "xhigh");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: xhigh, the highest allowed, for an exhaustive task"]);
});

test("an HTTP error keeps the session effort and lets the prompt through", async () => {
	const h = harness({ fetch: () => ({ status: 429, body: "rate limited" }) });
	assert.equal(await h.prompt("Fix the flaky test"), "medium");
	assert.deepEqual(h.seen.chat, [
		"user: Fix the flaky test",
		"warning: The effort classifier did not answer, so thinking stays at medium. See /auto-effort.",
	]);
});

test("a classifier that stays down says so once, and again after it came back", async () => {
	let down = true;
	const h = harness({ fetch: () => (down ? new TypeError("fetch failed") : jevReply("default", 0.9)) });
	await h.prompt("Fix the flaky test");
	await h.prompt("And the other one");
	assert.equal(h.lines().length, 1);
	down = false;
	await h.prompt("Add a flag");
	down = true;
	await h.prompt("Fix it again");
	// The warning, the pick once it came back, then the warning again.
	assert.equal(h.lines().length, 3);
});

test("a failed fetch keeps the session effort", async () => {
	const h = harness({ fetch: () => new TypeError("fetch failed") });
	assert.equal(await h.prompt("Fix the flaky test"), "medium");
});

test("a slow endpoint times out and keeps the session effort", async () => {
	const h = harness({
		env: { ...ENV, AUTO_EFFORT_TIMEOUT_MS: "50" },
		fetch: (_url, init) => new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
	});
	const started = Date.now();
	assert.equal(await h.prompt("Audit everything"), "medium");
	assert.ok(Date.now() - started < 2000);
});

test("with no environment no endpoint is called, and a notice names what to set", async () => {
	const h = harness({ env: {} });
	assert.equal(await h.prompt("Refactor the parser"), "medium");
	assert.equal(h.seen.requests.length, 0);
	assert.ok(h.seen.notices.includes("auto-effort: run /auto-effort setup, or set AUTO_EFFORT_ENDPOINT, AUTO_EFFORT_API_KEY, AUTO_EFFORT_MODEL"));
});

test("there is no default endpoint or model", async () => {
	const h = harness({ env: { AUTO_EFFORT_API_KEY: "test-key" } });
	await h.prompt("Refactor the parser");
	assert.equal(h.seen.requests.length, 0);
	assert.ok(h.seen.notices.includes("auto-effort: run /auto-effort setup, or set AUTO_EFFORT_ENDPOINT, AUTO_EFFORT_MODEL"));
});

test("OPENCODE_API_KEY is not read", async () => {
	const h = harness({ env: { AUTO_EFFORT_ENDPOINT: ENV.AUTO_EFFORT_ENDPOINT, AUTO_EFFORT_MODEL: "jev-test", OPENCODE_API_KEY: "test-key" } });
	await h.prompt("Refactor the parser");
	assert.equal(h.seen.requests.length, 0);
});

test("a model without reasoning keeps its level, and says nothing", async () => {
	const h = harness({ model: { id: "claude-haiku-4-5", reasoning: false }, fetch: () => new TypeError("fetch failed") });
	assert.equal(await h.prompt("Migrate the build to Vite"), "medium");
	assert.deepEqual(h.seen.levels, []);
	assert.deepEqual(h.lines(), []);
});

test("thinking turned off is left alone", async () => {
	const h = harness({ level: "off" });
	assert.equal(await h.prompt("Migrate the build to Vite"), "off");
	assert.deepEqual(h.lines(), []);
});

test("the decision does not leak into the next run", async () => {
	const h = harness();
	assert.equal(await h.prompt("Migrate the build to Vite"), "high");
	// A run an extension's custom message starts isn't a prompt.
	await h.emit("before_agent_start", { messageType: "custom", message: {} });
	assert.equal(await h.deliver(""), "medium");
});

test("a follow-up queued during a run applies to its own part, not the running one", async () => {
	const h = harness({ fetch: (_url, init) => jevReply(JSON.parse(String(init.body)).state.latest_user_message.includes("audit") ? "xhigh" : "default", 0.9) });
	await h.input("Fix the flaky test");
	assert.equal(await h.start("Fix the flaky test"), "medium");
	await h.input("Then audit the auth module", "followUp");
	assert.equal(h.level(), "medium");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: medium, for a small change"]);
	assert.equal(await h.deliver("Then audit the auth module"), "xhigh");
	// Each under its own prompt; the follow-up's when Pi delivers it.
	assert.deepEqual(h.seen.chat, [
		"user: Fix the flaky test",
		"info: Thinking for this prompt: medium, for a small change",
		"user: Then audit the auth module",
		"info: Thinking for this prompt: xhigh, for a hard task",
	]);
	await h.settle();
	assert.equal(h.level(), "medium");
});

test("a steer joins the running work and is not classified", async () => {
	const h = harness();
	await h.input("Fix the flaky test");
	assert.equal(await h.start("Fix the flaky test"), "high");
	await h.input("Status? One line.", "steer");
	assert.equal(await h.deliver("Status? One line."), "high");
	assert.equal(h.seen.requests.length, 1);
});

test("a prompt another extension consumed passes no decision on", async () => {
	const h = harness();
	await h.input("Migrate the build to Vite"); // handled by a later input handler: no run
	await h.emit("before_agent_start", { messageType: "custom", message: {} });
	assert.equal(await h.deliver(""), "medium");
});

test("/auto-effort off stops the overrides, and is kept for the next session", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ saved });
	assert.equal(await h.command("off"), "Effort picker turned off.");
	assert.equal(await h.prompt("Migrate the build to Vite"), "medium");
	assert.equal(h.seen.requests.length, 0);
	assert.equal(saved.enabled, false);
	const next = harness({ saved });
	await next.emit("session_start", { reason: "startup" });
	assert.equal(await next.prompt("Migrate the build to Vite"), "medium");
	assert.match(await next.command("status"), /Effort picker: off/);
});

test("/auto-effort off during a run gives the session its level back", async () => {
	const h = harness();
	await h.input("Migrate the build to Vite");
	assert.equal(await h.start("Migrate the build to Vite"), "high");
	await h.command("off");
	assert.equal(h.level(), "medium");
});

test("a level chosen by hand during the run stands", async () => {
	const h = harness();
	await h.input("Migrate the build to Vite");
	assert.equal(await h.start("Migrate the build to Vite"), "high");
	h.setLevel("low");
	await h.flush();
	await h.settle();
	assert.equal(h.level(), "low");
});

test("quitting mid-run gives the session its level back", async () => {
	const h = harness();
	await h.input("Migrate the build to Vite");
	await h.start("Migrate the build to Vite");
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.level(), "medium");
});

test("/auto-effort status reports the configuration", async () => {
	const text = await harness().command("");
	assert.match(text, /Endpoint: https:\/\/jev\.example\/v1\/systemone · model jev-test/);
	assert.match(text, /API key: set/);
	assert.doesNotMatch(text, /Missing/);
});

test("/auto-effort status lists unset variables", async () => {
	const text = await harness({ env: {} }).command("status");
	assert.match(text, /Endpoint: unset · model unset/);
	assert.match(text, /Missing: AUTO_EFFORT_ENDPOINT, AUTO_EFFORT_API_KEY, AUTO_EFFORT_MODEL/);
});

// The Nisev provider: the fine-tuned model in llama.cpp, asked the category question.

const MODELS: Reply = { body: { data: [{ id: "nisev" }] } };
const NISEV_ENV = { AUTO_EFFORT_PROVIDER: "nisev" };
const MULTI_STEP = { trivial: 0.02, light: 0.03, ordinary: 0.1, multi_step: 0.8, hard: 0.04, exhaustive: 0.01 };

function nisevFetch(probabilities: Record<string, number>) {
	const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
	return (url: string): Reply =>
		url.endsWith("/v1/models") ? MODELS : { body: { model: "nisev", answers: { effort: { type: "choice", choice, probabilities, confidence: 0.5 } } } };
}

const refused = () => new TypeError("fetch failed");

test("Nisev is asked the category question, and its answer is mapped for the model", async () => {
	const h = harness({ env: NISEV_ENV, fetch: nisevFetch(MULTI_STEP) });
	// Opus 5.5 defaults to medium: verified multi-step work is raised to high.
	assert.equal(await h.prompt("Refactor the payment module and make the tests pass"), "high");
	const [req] = h.seen.requests.filter((r) => r.url.endsWith("/v1/systemone"));
	assert.equal(req!.url, "http://127.0.0.1:8765/v1/systemone");
	assert.equal(req!.body.model, "nisev");
	assert.deepEqual(Object.keys(req!.body.questions.effort.criteria), ["trivial", "light", "ordinary", "multi_step", "hard", "exhaustive"]);
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: high, for multi-step work"]);
});

test("ordinary work on Nisev runs at the model's default, even under a higher session level", async () => {
	const ordinary = { trivial: 0.05, light: 0.15, ordinary: 0.6, multi_step: 0.15, hard: 0.04, exhaustive: 0.01 };
	const h = harness({ env: NISEV_ENV, fetch: nisevFetch(ordinary) });
	assert.equal(await h.prompt("Add a --verbose flag"), "medium");
	const high = harness({ env: NISEV_ENV, fetch: nisevFetch(ordinary), level: "high" });
	assert.equal(await high.prompt("Add a --verbose flag"), "medium");
	assert.deepEqual(high.lines(), ["info: Thinking for this prompt: medium, for a typical task"]);
});

test("the same answer means the default on a model whose default is high", async () => {
	const h = harness({ env: NISEV_ENV, fetch: nisevFetch(MULTI_STEP), model: { id: "claude-sonnet-5-5", reasoning: true }, level: "high" });
	assert.equal(await h.prompt("Refactor the payment module and make the tests pass"), "high");
	assert.deepEqual(h.lines(), ["info: Thinking for this prompt: high, for multi-step work"]);
});

test("when llama-server is not running, the extension starts it and the prompt keeps its level", async () => {
	const h = harness({ env: NISEV_ENV, fetch: () => ({ status: 502, body: "" }) });
	assert.equal(await h.prompt("Refactor the parser"), "medium");
	assert.deepEqual(h.seen.spawned, [
		["llama-server", "-hf", "arthur-fontaine/nisev-1.7b-GGUF:Q8_0", "--host", "127.0.0.1", "--port", "8765", "--alias", "nisev", "-c", "8192", "-np", "2"],
	]);
	assert.deepEqual(h.seen.chat, ["user: Refactor the parser", "info: Nisev starting: thinking stays at medium until it is ready"]);
	// Still starting on the next prompt: said once.
	await h.prompt("Refactor the lexer");
	assert.equal(h.lines().length, 1);
});

test("once llama-server listens, prompts are classified", async () => {
	let up = false;
	const reply = nisevFetch(MULTI_STEP);
	const h = harness({ env: NISEV_ENV, fetch: (url) => (up ? reply(url) : refused()), serverOutput: "main: server is listening on http://127.0.0.1:8765" });
	await h.emit("session_start", { reason: "startup" });
	await h.flush();
	assert.equal(h.seen.spawned.length, 1);
	assert.match(await h.command("status"), /\(ready\)/);
	up = true;
	assert.equal(await h.prompt("Refactor the payment module and make the tests pass"), "high");
	assert.equal(h.seen.spawned.length, 1);
});

test("the warm-up and a first prompt start one llama-server", async () => {
	const h = harness({ env: NISEV_ENV, fetch: refused, serverOutput: "" });
	await Promise.all([h.emit("session_start", { reason: "startup" }), h.prompt("Refactor the parser")]);
	await h.flush();
	assert.equal(h.seen.spawned.length, 1);
});

test("an llama-server another process serves is used as is", async () => {
	const h = harness({ env: NISEV_ENV, fetch: nisevFetch(MULTI_STEP) });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(await h.prompt("Refactor the payment module and make the tests pass"), "high");
	assert.deepEqual(h.seen.spawned, []);
});

test("a local GGUF file is passed with -m", async () => {
	const h = harness({ env: { ...NISEV_ENV, AUTO_EFFORT_MODEL: "/models/auto-effort-Q8_0.gguf" }, fetch: refused });
	await h.prompt("Refactor the parser");
	assert.deepEqual(h.seen.spawned[0]!.slice(0, 3), ["llama-server", "-m", "/models/auto-effort-Q8_0.gguf"]);
});

test("Nisev's endpoint sets the port llama.cpp serves on", async () => {
	const h = harness({ env: { ...NISEV_ENV, AUTO_EFFORT_ENDPOINT: "http://127.0.0.1:9000/v1/systemone" }, fetch: refused });
	await h.prompt("Refactor the parser");
	const argv = h.seen.spawned[0]!;
	assert.deepEqual(argv.slice(argv.indexOf("--port"), argv.indexOf("--port") + 2), ["--port", "9000"]);
});

test("a cloud endpoint's settings left in the environment don't start Nisev", async () => {
	const env = { ...NISEV_ENV, AUTO_EFFORT_ENDPOINT: "https://opencode.ai/zen/v1/systemone", AUTO_EFFORT_MODEL: "jev-1.13" };
	const h = harness({ env, fetch: refused });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(await h.prompt("Refactor the parser"), "medium");
	assert.deepEqual(h.seen.spawned, []);
	assert.match(h.seen.notices.at(-1)!, /AUTO_EFFORT_ENDPOINT is https:\/\/opencode.*AUTO_EFFORT_MODEL is jev-1\.13/);
});

// The setup wizard.

test("/auto-effort setup saves a Jev preset, never a key", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ env: {}, saved, answers: ["OpenCode Zen"] });
	const reply = await h.command("setup");
	assert.deepEqual(saved.config, { provider: "jev", endpoint: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" });
	assert.match(reply, /set AUTO_EFFORT_API_KEY/);
});

test("/auto-effort setup takes any System One endpoint under Other", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ env: { AUTO_EFFORT_API_KEY: "k" }, saved, answers: ["Other…", "http://127.0.0.1:8080/v1/systemone", "Other…", "kev"] });
	const reply = await h.command("setup");
	assert.deepEqual(saved.config, { provider: "jev", endpoint: "http://127.0.0.1:8080/v1/systemone", model: "kev" });
	assert.match(reply, /AUTO_EFFORT_API_KEY is set/);
});

test("/auto-effort setup without a UI changes nothing", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ env: {}, saved });
	assert.equal(await h.command("setup"), "Setup cancelled; nothing changed.");
	assert.deepEqual(saved, {});
});

test("/auto-effort setup refuses a llama-server without decision models", async () => {
	const h = harness({ env: {}, run: async () => ({ stdout: "version: 0.5.0 (build 11300, commit abc)", stderr: "" }), answers: ["Nisev (local)"] });
	assert.match(await h.command("setup"), /llama-server is build 11300; decision models need build 11361 or later/);
});

test("/auto-effort setup falls back to the unified llama CLI", async () => {
	const saved: Record<string, any> = {};
	const h = harness({
		env: {},
		fetch: refused,
		saved,
		run: async (argv) => {
			if (argv[0] !== "llama") throw new Error("spawn llama-server ENOENT");
			return { stdout: "version: 0.5.0-dev (build 11406, commit 8216c84)", stderr: "" };
		},
		answers: ["Nisev (local)", true],
	});
	const reply = await h.command("setup");
	assert.equal(saved.config.llamaServer, "llama");
	assert.deepEqual(h.seen.spawned[0]!.slice(0, 3), ["llama", "serve", "-hf"]);
	assert.match(reply, /served by llama serve \(build 11406\)/);
});

test("/auto-effort setup downloads and starts Nisev", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ env: {}, fetch: refused, saved, answers: ["Nisev (local)", true] });
	const reply = await h.command("setup");
	assert.equal(saved.config.provider, "nisev");
	assert.equal(h.seen.spawned.length, 1);
	assert.match(reply, /The first start downloads the model/);
});

test("/auto-effort setup asks before downloading", async () => {
	const saved: Record<string, any> = {};
	const h = harness({ env: {}, fetch: refused, saved, answers: ["Nisev (local)", false] });
	assert.equal(await h.command("setup"), "Setup cancelled; nothing changed.");
	assert.deepEqual(h.seen.spawned, []);
	assert.equal(saved.config, undefined);
});
