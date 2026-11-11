// The extension against a stand-in Pi and a stand-in daemon: when Pi's voice must stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonEvent } from "../client.ts";
import { type DaemonClient, voice } from "../extension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const ESC = "\x1b";

class FakePi {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	sent: Record<string, unknown>[] = [];
	userMessages: { text: string; options?: unknown }[] = [];
	terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	onEvent!: (e: DaemonEvent) => void;
	idle = true;
	navigated: string[] = [];

	constructor() {
		const pi = {
			on: (event: string, h: Handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]),
			registerCommand: (name: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => this.commands.set(name, o.handler),
			registerShortcut() {},
			registerEntryRenderer() {},
			appendEntry() {},
			getSessionName: () => "test",
			sendUserMessage: (text: string, options?: { expandPromptTemplates?: boolean }) => {
				if (options?.expandPromptTemplates && text.startsWith("/")) void this.commands.get(text.slice(1))!("", this.ctx());
				else this.userMessages.push({ text, options });
			},
		} as unknown as ExtensionAPI;
		voice(pi, {
			client: (onEvent) => {
				this.onEvent = onEvent;
				const c: DaemonClient = { connect: async () => {}, send: (m) => void this.sent.push(m), close() {} };
				return c;
			},
			tui: {} as never,
			isEscape: (data) => data === ESC,
		});
	}

	ctx() {
		return {
			cwd: "/tmp/x",
			mode: "tui",
			hasUI: true,
			isIdle: () => this.idle,
			abort() {},
			waitForIdle: async () => {},
			navigateTree: async (id: string) => {
				this.navigated.push(id);
				await this.emit("session_tree", { newLeafId: "p", oldLeafId: "l", fromExtension: true });
				return { cancelled: false };
			},
			sessionManager: { getSessionId: () => "s1", getBranch: () => [{ id: "u1", type: "message", message: { role: "user" } }] },
			modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
			ui: {
				setStatus() {},
				notify() {},
				confirm: async () => false,
				getEditorText: () => "",
				setEditorText() {},
				onTerminalInput: (fn: (data: string) => { consume?: boolean } | undefined) => {
					this.terminalInput = fn;
					return () => (this.terminalInput = undefined);
				},
			},
		};
	}

	async emit(event: string, payload: unknown = {}) {
		for (const h of this.handlers.get(event) ?? []) await h(payload, this.ctx());
	}

	/** A call that is on, with Pi speaking an answer. */
	async speaking() {
		await this.emit("session_start", { reason: "startup" });
		await this.commands.get("call")!("", this.ctx());
		this.onEvent({ type: "call", active: true, mine: true, owner: "test" });
		this.onEvent({ type: "state", name: "pi_speaking" });
		this.sent = [];
	}

	stops() {
		return this.sent.filter((m) => m.type === "answer" && m.state === "stopped");
	}
}

const tick = () => new Promise((r) => setImmediate(r));

test("Esc while Pi speaks stops its voice, and the key still goes to Pi", async () => {
	const pi = new FakePi();
	await pi.speaking();
	const result = pi.terminalInput!(ESC);
	assert.equal(pi.stops().length, 1);
	assert.ok(!result?.consume, "Esc is not taken from Pi (abort, rewind's double Esc)");
});

test("Esc when Pi isn't speaking does nothing to the call", async () => {
	const pi = new FakePi();
	await pi.speaking();
	pi.onEvent({ type: "state", name: "listening" });
	pi.terminalInput!(ESC);
	pi.terminalInput!("a");
	assert.equal(pi.stops().length, 0);
});

test("an aborted run (Esc during the run) stops the voice and drops what was queued", async () => {
	const pi = new FakePi();
	await pi.speaking();
	pi.idle = false;
	await pi.emit("agent_start");
	await pi.emit("agent_settled", { aborted: true });
	assert.equal(pi.stops().length, 1);
});

test("a rewind applied while Pi speaks stops the voice (session_tree)", async () => {
	const pi = new FakePi();
	await pi.speaking();
	await pi.emit("session_tree", { newLeafId: "a", oldLeafId: "b", fromExtension: true });
	assert.equal(pi.stops().length, 1);
});

test("a rewind picker opened then cancelled leaves the voice alone (no tree event)", async () => {
	const pi = new FakePi();
	await pi.speaking();
	// The rewind extension shows its picker and returns without navigating: Pi emits nothing.
	await tick();
	assert.equal(pi.stops().length, 0);
});

test("a compaction applied while Pi speaks (Summarize up to here) stops the voice", async () => {
	const pi = new FakePi();
	await pi.speaking();
	await pi.emit("session_compact", {});
	assert.equal(pi.stops().length, 0, "a compaction that isn't a rewind (auto, /compact) isn't a cancel");
	pi.onEvent({ type: "state", name: "pi_speaking" });
	await pi.emit("session_before_compact", { customInstructions: "rewind:summarize-up-to:u1" });
	await pi.emit("session_compact", {});
	assert.equal(pi.stops().length, 1);
});

test("the voice's own rewind (speech before Pi speaks) is not a stop: the message is resent", async () => {
	const pi = new FakePi();
	await pi.speaking();
	pi.onEvent({ type: "state", name: "pi_working" });
	// A voice message was sent and has its entry.
	pi.onEvent({ type: "turn", text: "Réponds par oui.", phase: "after_answer" });
	await pi.emit("message_end", { message: { role: "user", content: "Réponds par oui." } });
	await new Promise((r) => setTimeout(r, 5));
	pi.idle = false;
	pi.onEvent({ type: "turn", text: "Non, par non.", phase: "before_speech" });
	await tick();
	await tick();
	assert.deepEqual(pi.navigated, ["u1"]);
	assert.equal(pi.stops().length, 0);
	assert.equal(pi.userMessages.at(-1)?.text, "Réponds par oui. Non, par non.");
});
