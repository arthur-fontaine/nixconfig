// Voice calls with Pi (DESIGN.md). /call (or Ctrl+Alt+V) starts and ends a call; the daemon
// hears the person, decides when his turn is over and sends it here; Pi answers in writing as
// always, and the spoken version is made beside the written one and said by the daemon.
//
// Nothing goes into the main model's context: no system prompt change, no custom message, no
// tool. The spoken text is kept as a custom entry ("voice-spoken"), which Pi never sends to the
// model, and drawn as a collapsed row.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { changedFiles, type Phase, whatToDoWithAddition } from "./addition.ts";
import { Client, type DaemonEvent } from "./client.ts";
import { Blocks, isPlain, languageOf, ON_SCREEN, PROMPT, request, sentences } from "./spoken.ts";
import { type SpokenEntry, spokenRow, statusText, type Tui } from "./view.ts";

const TUI: Tui = { MouseRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi };

const ENTRY = "voice-spoken";
const STATUS = "voice";
const PROVIDER = "claude-code";
const HAIKU = "claude-haiku-5-5";
const MAX_TOKENS = 300;

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	const call = { active: false, mine: false, owner: null as string | null, state: "listening", partial: "", loading: false };
	// The voice message Pi is answering, and whether a tool changed files since.
	let voice: { entryId?: string; text: string; filesChanged: boolean } | undefined;
	const voiceTexts: string[] = []; // sent by voice, waiting for their entry
	let pendingRewind: { entryId: string; text: string } | undefined;
	// The answer being spoken: blocks of Pi's text, said in order.
	let answer: { id: string; blocks: Blocks; chain: Promise<void>; said: string[]; sentences: number; gen: number; started?: number } | undefined;
	let answerCount = 0;
	let generation = 0;
	const opened = new Map<string, { value: boolean }>();

	const client = new Client(onEvent, () => {
		if (call.active && call.mine) ctx?.ui.notify("The voice daemon stopped; the call ended.", "warning");
		Object.assign(call, { active: false, mine: false, owner: null, loading: false });
		render();
	});

	function render() {
		ctx?.ui.setStatus(STATUS, statusText(call));
	}

	async function connect(c: ExtensionContext) {
		await client.connect({ session: c.sessionManager.getSessionId(), name: pi.getSessionName() || c.cwd.split("/").pop() || "Pi" });
	}

	async function startCall(c: ExtensionContext, take = false) {
		try {
			await connect(c);
		} catch (e) {
			c.ui.notify(`Voice: ${(e as Error).message}`, "error");
			return;
		}
		client.send({ type: "call.start", take });
	}

	function endCall() {
		client.send({ type: "call.end" });
		answer = undefined;
		voice = undefined;
	}

	// ------------------------------------------------------------------ daemon events
	function onEvent(e: DaemonEvent) {
		switch (e.type) {
			case "call": {
				const wasMine = call.mine;
				Object.assign(call, { active: Boolean(e.active), mine: Boolean(e.mine), owner: (e.owner as string) ?? null });
				if (!call.mine) call.loading = false;
				if (wasMine && e.moved_to) ctx?.ui.notify(`The call moved to « ${e.moved_to} ».`, "info");
				break;
			}
			case "busy":
				void (async () => {
					const ok = await ctx?.ui.confirm("Voice", `Take the call from « ${e.owner} »?`);
					if (ok) client.send({ type: "call.start", take: true });
				})();
				break;
			case "loading":
				call.loading = true;
				break;
			case "ready":
				call.loading = false;
				break;
			case "state":
				call.state = String(e.name);
				if (call.state === "listening" || call.state === "pi_working") call.partial = "";
				break;
			case "partial":
				call.partial = String(e.text ?? "");
				break;
			case "turn":
				onTurn(String(e.text ?? ""), e.phase as Phase);
				break;
			case "barge":
				// Interrupted: what the spoken pass was still making for this answer is dropped.
				if (e.phase === "confirmed") generation++;
				break;
			case "speaking":
				if (answer && answer.started === undefined) answer.started = Date.now();
				break;
			case "spoken":
				onSpoken(String(e.id ?? ""), String(e.text ?? ""), Boolean(e.interrupted));
				break;
			case "idle_end":
				ctx?.ui.notify("Ten minutes without speech: the call ended.", "info");
				endCall();
				break;
			case "error":
				ctx?.ui.notify(`Voice: ${e.message}`, "error");
				break;
		}
		render();
	}

	function onTurn(text: string, phase: Phase) {
		if (!text.trim() || !ctx) return;
		const running = !ctx.isIdle();
		const decision = whatToDoWithAddition(text, {
			phase,
			voiceEntryId: voice?.entryId,
			voiceText: voice?.text,
			filesChanged: voice?.filesChanged ?? false,
			running,
		});
		if (decision.action === "rewind") {
			pendingRewind = { entryId: decision.entryId, text: decision.text };
			generation++; // what the spoken pass was making for the dropped answer is dropped too
			client.send({ type: "answer", state: "aborted" });
			pi.sendUserMessage("/voice-rewind", { expandPromptTemplates: true });
			return;
		}
		// Pi's answer goes on: what the daemon held back while he spoke can play.
		if (phase === "before_speech") client.send({ type: "answer", state: "continue" });
		if (decision.action === "steer" || running) {
			pi.sendUserMessage(decision.text, { deliverAs: "steer" });
			return;
		}
		sendVoice(decision.text);
	}

	function sendVoice(text: string) {
		voiceTexts.push(text.trim());
		voice = { text: text.trim(), filesChanged: false };
		pi.sendUserMessage(text);
	}

	function onSpoken(id: string, text: string, interrupted: boolean) {
		if (!text.trim()) return;
		const durationMs = answer?.id === id && answer.started ? Date.now() - answer.started : undefined;
		pi.appendEntry<SpokenEntry>(ENTRY, { text: text.trim(), interrupted, durationMs });
	}

	// ------------------------------------------------------------------ the spoken pass
	function speakSentences(a: NonNullable<typeof answer>, text: string) {
		for (const s of sentences(text)) {
			if (a.gen !== generation) return;
			a.sentences++;
			a.said.push(s);
			client.send({ type: "speak", id: a.id, text: s, final: false });
		}
	}

	async function haiku(a: NonNullable<typeof answer>, block: string) {
		const c = ctx;
		const model = c?.modelRegistry.find(PROVIDER, HAIKU);
		if (!c || !model || !c.modelRegistry.hasConfiguredAuth(model)) throw new Error("Haiku isn't available");
		const stream = c.modelRegistry.streamSimple(
			model,
			{ systemPrompt: PROMPT, messages: [{ role: "user", content: [{ type: "text", text: request(block, a.said.join(" ")) }], timestamp: Date.now() }] },
			{ maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(20_000) },
		);
		let pending = "";
		for await (const ev of stream as AsyncIterable<{ type: string; delta?: string }>) {
			if (a.gen !== generation) return;
			if (ev.type !== "text_delta" || !ev.delta) continue;
			pending += ev.delta;
			const parts = sentences(pending);
			// Every sentence but the last is complete; the last may still grow.
			if (parts.length > 1 && /[.!?…]\s*$/.test(parts[parts.length - 2] ?? "")) {
				speakSentences(a, parts.slice(0, -1).join(" "));
				pending = parts[parts.length - 1] ?? "";
			}
		}
		const reply = await stream.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
		speakSentences(a, pending);
	}

	function onBlock(block: string) {
		const a = answer;
		if (!a || !block.trim()) return;
		a.chain = a.chain.then(async () => {
			if (a.gen !== generation) return;
			if (isPlain(block)) return speakSentences(a, block);
			try {
				await haiku(a, block);
			} catch {
				// Q6: without Haiku, only the plain blocks are said, and once that the answer is on screen.
				if (!a.said.includes(ON_SCREEN.fr) && !a.said.includes(ON_SCREEN.en)) speakSentences(a, ON_SCREEN[languageOf(block)]);
			}
		});
	}

	function finishAnswer() {
		const a = answer;
		if (!a) return;
		const rest = a.blocks.flush();
		if (rest) onBlock(rest);
		a.chain = a.chain.then(() => {
			if (a.gen !== generation) return;
			if (a.sentences) client.send({ type: "speak", id: a.id, text: "", final: true });
			else client.send({ type: "answer", state: "silent" });
		});
		answer = undefined;
	}

	const inCall = () => call.active && call.mine;

	pi.on("agent_start", () => {
		if (!inCall()) return;
		answer = { id: `a${++answerCount}`, blocks: new Blocks(), chain: Promise.resolve(), said: [], sentences: 0, gen: generation };
	});
	pi.on("message_update", (event) => {
		const e = event.assistantMessageEvent as { type: string; delta?: string };
		if (!inCall() || !answer || e.type !== "text_delta" || !e.delta) return;
		for (const block of answer.blocks.push(e.delta)) onBlock(block);
	});
	pi.on("message_end", (event) => {
		const m = event.message as { role: string; content?: unknown };
		if (m.role === "assistant" && answer) {
			const rest = answer.blocks.flush();
			if (rest) onBlock(rest);
		}
		if (m.role === "user" && voiceTexts.length) {
			const text = typeof m.content === "string" ? m.content : ((m.content as Array<{ type: string; text?: string }>) ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
			const i = voiceTexts.indexOf(text.trim());
			if (i !== -1) {
				voiceTexts.splice(i, 1);
				// The entry is appended after the handlers: read it on the next tick.
				setTimeout(() => {
					const branch = ctx?.sessionManager.getBranch() ?? [];
					for (let j = branch.length - 1; j >= 0; j--) {
						const entry = branch[j] as { id: string; type: string; message?: { role: string } };
						if (entry.type === "message" && entry.message?.role === "user") {
							if (voice && voice.text === text.trim()) voice.entryId = entry.id;
							break;
						}
					}
				}, 0);
			}
		}
	});
	pi.on("tool_execution_start", () => {
		if (!answer) return;
		const rest = answer.blocks.flush();
		if (rest) onBlock(rest);
	});
	pi.on("tool_execution_end", (event) => {
		const e = event as { toolName: string; result?: { details?: unknown }; isError?: boolean };
		if (voice && changedFiles(e.toolName, e.result?.details, Boolean(e.isError))) voice.filesChanged = true;
	});
	pi.on("agent_settled", (event) => {
		if (!inCall()) return;
		if (event.aborted && !pendingRewind) {
			generation++;
			answer = undefined;
			client.send({ type: "answer", state: "aborted" });
			return;
		}
		finishAnswer();
	});

	// ------------------------------------------------------------------ commands and keys
	pi.registerCommand("call", {
		description: "Start or end a voice call (Ctrl+Alt+V); /call mute, /call take",
		getArgumentCompletions: (prefix) =>
			["end", "mute", "unmute", "take"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, c) => {
			ctx = c;
			const arg = args.trim();
			if (arg === "mute" || arg === "unmute") {
				if (inCall()) client.send({ type: "mute", on: arg === "mute" });
				return;
			}
			if (arg === "take") return startCall(c, true);
			if (arg === "end" || inCall()) return endCall();
			return startCall(c);
		},
	});

	pi.registerCommand("voice-rewind", {
		description: "(voice) Drop Pi's answer and resend the last voice message with what was added",
		handler: async (_args, c: ExtensionCommandContext) => {
			const r = pendingRewind;
			if (!r) return;
			if (!c.isIdle()) {
				c.abort();
				await c.waitForIdle();
			}
			pendingRewind = undefined;
			answer = undefined;
			const draft = c.ui.getEditorText();
			await c.navigateTree(r.entryId);
			c.ui.setEditorText(draft);
			sendVoice(r.text);
		},
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: "Start or end a voice call",
		handler: async (c) => {
			ctx = c;
			if (inCall()) endCall();
			else await startCall(c);
		},
	});
	pi.registerShortcut("ctrl+alt+m", {
		description: "Mute or unmute the voice call",
		handler: async () => {
			if (!inCall()) return;
			const muted = call.state === "muted";
			client.send({ type: "mute", on: !muted });
		},
	});

	// ------------------------------------------------------------------ the row
	pi.registerEntryRenderer<SpokenEntry>(ENTRY, (entry, { expanded }, theme) => {
		let open = opened.get(entry.id);
		if (!open) opened.set(entry.id, (open = { value: false }));
		return spokenRow(TUI, entry.data as SpokenEntry, expanded, open, theme);
	});

	// ------------------------------------------------------------------ lifecycle
	pi.on("session_start", (_event, next) => {
		ctx = next;
		render();
	});
	pi.on("session_shutdown", () => {
		if (inCall()) endCall();
		client.close();
		ctx = undefined;
	});
}
