// The extension's wiring against a stand-in for Pi: commands, events, the model and intercom.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Deps, MODEL, PROVIDER, sessionName } from "../index.ts";
import { ENTRY_TYPE, POLICY } from "../naming.ts";
import { CHECK_SYSTEM, RENAME_SYSTEM } from "../prompts.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = Record<string, unknown> & { type: string };

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { model?: boolean; intercom?: { name: string; pid: number }[]; idle?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: Entry[] = [];
	const notes: { text: string; type?: string }[] = [];
	const calls: { provider: string; id: string; system: string; user: string }[] = [];
	const replies: string[] = [];
	let name: string | undefined;
	let clock = 0;
	let timer: (() => void) | undefined;
	const stamp = () => new Date(clock).toISOString();

	const emit = async (event: string, payload: unknown = {}) => {
		for (const h of handlers.get(event) ?? []) await h(payload, ctx);
	};
	// Pi emits session_info_changed without waiting for the extensions, as here.
	const rename = (next: string) => {
		name = next;
		entries.push({ type: "session_info", name: next, timestamp: stamp() });
		void emit("session_info_changed", { type: "session_info_changed", name: next });
	};

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(command: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(command, options);
		},
		events: {
			emit(channel: string, data: unknown) {
				for (const h of bus.get(channel) ?? []) h(data);
			},
			on(channel: string, h: (data: unknown) => void) {
				bus.set(channel, [...(bus.get(channel) ?? []), h]);
				return () => {};
			},
		},
		setSessionName: rename,
		getSessionName: () => name,
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data, timestamp: stamp() });
		},
	};

	const ctx = {
		hasUI: true,
		ui: { notify: (text: string, type?: string) => notes.push({ text, type }) },
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getLeafId: () => String(entries.length),
		},
		modelRegistry: {
			find: (provider: string, id: string) => (options.model === false ? undefined : { provider, id }),
			hasConfiguredAuth: () => true,
			streamSimple(model: { provider: string; id: string }, context: { systemPrompt: string; messages: { content: { text: string }[] }[] }) {
				calls.push({ ...model, system: context.systemPrompt, user: context.messages[0]!.content[0]!.text });
				const text = replies.shift() ?? "";
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text }] }) };
			},
		},
	};

	if (options.intercom) {
		const sessions = options.intercom.map((s, i) => ({ id: `peer-${i}`, ...s }));
		pi.events.on("intercom:extension-register", (data) => {
			(data as { onReady(channel: unknown): void }).onReady({ listSessions: async () => sessions });
		});
	}

	const deps: Deps = {
		now: () => clock,
		schedule(run) {
			timer = run;
			return () => {
				if (timer === run) timer = undefined;
			};
		},
		policy: POLICY,
		log() {},
	};
	sessionName(pi as unknown as ExtensionAPI, deps);

	return {
		pi,
		entries,
		notes,
		calls,
		replies,
		bus,
		get name() {
			return name;
		},
		rename,
		emit,
		command: (args: string) => commands.get("rename")!.handler(args, ctx),
		advance(ms: number) {
			clock += ms;
		},
		// A prompt and its reply, then the run settling.
		async turn(prompt: string, reply: string) {
			entries.push({ type: "message", timestamp: stamp(), message: { role: "user", content: [{ type: "text", text: prompt }] } });
			entries.push({ type: "message", timestamp: stamp(), message: { role: "assistant", content: [{ type: "text", text: reply }] } });
			await emit("agent_settled", { type: "agent_settled", aborted: false });
		},
		async fire() {
			const run = timer;
			timer = undefined;
			run?.();
			await tick();
			await tick();
		},
		get pending() {
			return timer !== undefined;
		},
		modes: () => entries.filter((e) => e.customType === ENTRY_TYPE).map((e) => e.data),
	};
}

const long = (topic: string) => `${topic} `.repeat(400);

test("an unnamed session is named after its first run, with Claude Code's prompt through claude-code Haiku", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	h.replies.push('{"name": "fix-login-bug"}');
	await h.turn("The login form rejects valid passwords", "Fixed the hash comparison.");
	await tick();
	assert.equal(h.name, "fix-login-bug");
	assert.deepEqual(h.calls.map((c) => [c.provider, c.id, c.system]), [[PROVIDER, MODEL, RENAME_SYSTEM]]);
	assert.match(h.calls[0]!.user, /^<conversation>\nUser: The login form rejects valid passwords\nAssistant: Fixed/);
	assert.deepEqual(h.modes(), [{ mode: "auto", name: "fix-login-bug" }]);
	assert.deepEqual(h.notes, [{ text: "Session named: fix-login-bug", type: "info" }]);
	// The extension's own rename isn't taken for a hand-given one.
	await tick();
	assert.deepEqual(h.modes(), [{ mode: "auto", name: "fix-login-bug" }]);
});

test("/rename <name> sets a manual name that is never changed automatically", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.command("My Login Work");
	assert.equal(h.name, "my-login-work");
	assert.deepEqual(h.modes(), [{ mode: "manual", name: "my-login-work" }]);
	assert.equal(h.notes.at(-1)!.text, "Session renamed to: my-login-work");
	h.advance(POLICY.maxIntervalMs);
	await h.turn(long("billing export"), long("done"));
	assert.equal(h.pending, false);
	assert.equal(h.calls.length, 0);
});

test("/rename with no argument generates a name and returns to automatic mode", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.command("mine");
	h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "Add CSV export to billing" }] } });
	h.replies.push('{"name": "add-billing-export"}');
	await h.command("");
	assert.equal(h.name, "add-billing-export");
	assert.deepEqual(h.modes().at(-1), { mode: "auto", name: "add-billing-export" });
	assert.equal(h.calls[0]!.system, RENAME_SYSTEM);
});

test("/rename with no argument says why it couldn't name the session", async () => {
	const empty = harness();
	await empty.emit("session_start", { reason: "startup" });
	await empty.command("");
	assert.equal(empty.notes.at(-1)!.text, "Could not generate a name: no conversation context yet. Usage: /rename <name>");
	const noModel = harness({ model: false });
	await noModel.emit("session_start", { reason: "startup" });
	noModel.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello there" }] } });
	await noModel.command("");
	assert.equal(noModel.notes.at(-1)!.type, "warning");
	assert.match(noModel.notes.at(-1)!.text, /claude-code\/claude-haiku-5-5 is not available/);
	assert.equal(noModel.name, undefined);
});

test("without the model, automatic naming skips silently", async () => {
	const h = harness({ model: false });
	await h.emit("session_start", { reason: "startup" });
	await h.turn("The login form rejects valid passwords", "Fixed.");
	await tick();
	assert.equal(h.name, undefined);
	assert.deepEqual(h.notes, []);
});

test("re-checks are debounced, skip small changes, keep on drift and rename on a new task", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	h.replies.push('{"name": "fix-login-bug"}');
	await h.turn("The login form rejects valid passwords", "Fixed.");
	await tick();

	// A new prompt cancels the pending check.
	await h.turn("and the logout?", "Also fixed.");
	assert.equal(h.pending, true);
	await h.emit("input", { text: "next" });
	assert.equal(h.pending, false);

	// Too little new conversation: no model call.
	h.advance(POLICY.minIntervalMs);
	await h.turn("thanks", "You're welcome.");
	await h.fire();
	assert.equal(h.calls.length, 1);

	// Enough change and time: the check runs with the current name; a refinement keeps it.
	await h.turn(long("login tests"), long("added"));
	h.replies.push('{"action": "rename", "name": "fix-login-bug-tests"}');
	await h.fire();
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1]!.system, CHECK_SYSTEM);
	assert.match(h.calls[1]!.user, /^Current name: "fix-login-bug"\n\n<conversation>\n/);
	assert.equal(h.name, "fix-login-bug");

	// After a keep the interval doubles.
	await h.turn(long("billing export"), long("started"));
	h.advance(POLICY.minIntervalMs);
	await h.fire();
	assert.equal(h.calls.length, 2);
	h.advance(POLICY.minIntervalMs);
	await h.turn(long("billing csv"), long("more"));
	h.replies.push('{"action": "rename", "name": "add-billing-export"}');
	await h.fire();
	assert.equal(h.calls.length, 3);
	assert.equal(h.name, "add-billing-export");
	assert.deepEqual(h.modes().at(-1), { mode: "auto", name: "add-billing-export" });
	assert.equal(h.notes.at(-1)!.text, "Session renamed to: add-billing-export (was fix-login-bug)");
});

test("a re-check waits while an intercom exchange is going on", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	h.replies.push('{"name": "fix-login-bug"}');
	await h.turn("The login form rejects valid passwords", "Fixed.");
	await tick();
	h.advance(POLICY.minIntervalMs);
	h.entries.push({ type: "custom_message", customType: "intercom_message", content: "**From api** ping", timestamp: new Date(POLICY.minIntervalMs).toISOString() });
	await h.turn(long("billing export"), long("started"));
	await h.fire();
	assert.equal(h.calls.length, 1);
	h.advance(POLICY.exchangeQuietMs + 1);
	await h.turn(long("billing csv"), long("more"));
	h.replies.push('{"action": "keep"}');
	await h.fire();
	assert.equal(h.calls.length, 2);
});

test("a name set with Pi's /name or intercom's /alias turns automatic naming off", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	h.replies.push('{"name": "fix-login-bug"}');
	await h.turn("The login form rejects valid passwords", "Fixed.");
	await tick();
	h.rename("api-owner");
	await tick();
	assert.deepEqual(h.modes().at(-1), { mode: "manual", name: "api-owner" });
	h.advance(POLICY.maxIntervalMs);
	await h.turn(long("billing export"), long("started"));
	assert.equal(h.pending, false);

	// And stays off after a resume.
	await h.emit("session_start", { reason: "resume" });
	await h.turn(long("billing csv"), long("more"));
	assert.equal(h.pending, false);
});

test("names are unique among live intercom sessions", async () => {
	const h = harness({ intercom: [{ name: "fix-login-bug", pid: 1 }, { name: "mine", pid: process.pid }] });
	await h.emit("session_start", { reason: "startup" });
	h.replies.push('{"name": "fix-login-bug"}');
	await h.turn("The login form rejects valid passwords", "Fixed.");
	await tick();
	assert.equal(h.name, "fix-login-bug-2");
	// This process's own entry doesn't count.
	await h.command("mine");
	assert.equal(h.name, "mine");
	await h.command("Fix login bug");
	assert.equal(h.name, "fix-login-bug-2");
	assert.equal(h.notes.at(-1)!.text, 'Session renamed to: fix-login-bug-2 ("fix-login-bug" is held by another live session on this machine)');
});

test("intercom loading after the extension still gets the registration", async () => {
	const h = harness();
	h.pi.events.on("intercom:extension-register", (data) => {
		(data as { onReady(channel: unknown): void }).onReady({ listSessions: async () => [{ id: "p", name: "taken", pid: 1 }] });
	});
	h.pi.events.emit("intercom:extension-registry-ready", { version: 1 });
	await h.emit("session_start", { reason: "startup" });
	await h.command("taken");
	assert.equal(h.name, "taken-2");
});
