// cache-warmer for Pi: keeps an idle session's prompt cache warm, then compacts
// it once when the warm window ends. The schedule is warmer.ts; this file
// connects it to Pi. See README.md.
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
	type ContextWithSystemEvent,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { fileStore } from "./store.ts";
import { footer, type Line, widget } from "./view.ts";
import { type Config, configFrom, type Host, type PingResult, type Usage, Warmer, type WarmState } from "./warmer.ts";
import { mainSessionOnly } from "./main-session.ts";

const STATUS_KEY = "cache-warmer";
const ENTRY_TYPE = "cache-warmer";
// cache-timer listens to show a ping as soon as it lands.
const STATE_EVENT = "cache-warmer:state";
const MAX_SCAN = 2000;
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Messages = ContextWithSystemEvent["messages"];
type Model = NonNullable<ExtensionContext["model"]>;
type Request = { model: Model; messages: Messages; thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> };

// The last request of each session, as the provider got it. Kept on globalThis
// so /reload, which re-runs this file in the same process, can keep warming.
const requests: Map<string, Request> = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi.cache-warmer.requests")] ??=
	new Map()) as Map<string, Request>;

// Set PI_CACHE_WARMER_DEBUG to a file path to log pings there.
function debug(message: string) {
	const file = process.env.PI_CACHE_WARMER_DEBUG;
	if (file) appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

// Pi's own rule for its cache refreshes: Anthropic's budget-based thinking takes
// its budget from max_tokens, so a one-token replay would be another request.
function replayable({ model, thinkingLevel }: Request) {
	const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
	return thinkingLevel === "off" || model.api !== "anthropic-messages" || compat?.forceAdaptiveThinking === true;
}

// Pi's images.blockImages filter, which it applies after convertToLlm.
function withoutImages(messages: ReturnType<typeof convertToLlm>) {
	const placeholder = "Image reading is disabled.";
	return messages.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		if (!message.content.some((c) => c.type === "image")) return message;
		const content = message.content
			.map((c) => (c.type === "image" ? { type: "text" as const, text: placeholder } : c))
			.filter((c, i, all) => !(c.type === "text" && c.text === placeholder && i > 0 && all[i - 1]!.type === "text" && (all[i - 1] as { text: string }).text === placeholder));
		return { ...message, content } as typeof message;
	});
}

function* newestFirst(ctx: ExtensionContext) {
	const session = ctx.sessionManager;
	let entry = session.getLeafEntry();
	for (let i = 0; entry && i < MAX_SCAN; i++) {
		yield entry;
		entry = entry.parentId ? session.getEntry(entry.parentId) : undefined;
	}
}

function savedState(ctx: ExtensionContext): WarmState | undefined {
	for (const entry of newestFirst(ctx)) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const warm = (entry.data as { warm?: WarmState } | undefined)?.warm;
		return warm && typeof warm.phase === "string" ? warm : undefined;
	}
	return undefined;
}

// Prompt size of the last request, as Pi measures it for its own cache refreshes;
// getContextUsage() has no count right after a compaction.
function lastPromptTokens(ctx: ExtensionContext) {
	for (const entry of newestFirst(ctx)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = entry.message.usage;
			return u.input + u.cacheRead + u.cacheWrite;
		}
	}
	return undefined;
}

export default function (api: ExtensionAPI) {
	const pi = mainSessionOnly(api);
	let ctx: ExtensionContext | undefined;
	let warmer: Warmer | undefined;
	let pinging: AbortController | undefined;
	let compacting = false;
	let cfg: Config = configFrom();
	let latest: WarmState | undefined;
	let written = "";
	let shown: { status?: string; widget?: string } = {};

	const sessionId = () => ctx?.sessionManager.getSessionId() ?? "";
	const settings = () => pi.getSettings() as Record<string, unknown>;

	// A custom entry per state change would add a few to the session on every
	// turn, so state is written when a ping lands (cache-timer reads it) and when
	// the session closes, which is what a reload or resume needs.
	function write() {
		const json = JSON.stringify(latest);
		if (!latest || json === written) return;
		written = json;
		pi.appendEntry(ENTRY_TYPE, { warm: latest });
	}

	async function ping(): Promise<PingResult> {
		const request = requests.get(sessionId());
		if (!ctx || !request) return { isAnswered: false, reason: "nothing-to-fork", usage: ZERO, stop: "nothing to keep warm yet" };
		if (!replayable(request)) {
			return {
				isAnswered: false,
				reason: "not-replayable",
				usage: ZERO,
				stop: `${request.model.id} thinks on a budget, so its request can't be replayed with one output token`,
			};
		}
		let messages = convertToLlm(request.messages);
		if ((settings().images as { blockImages?: boolean } | undefined)?.blockImages) messages = withoutImages(messages);
		pinging = new AbortController();
		try {
			// What Pi's own cache refresh sends: the same request, capped at one output token.
			const message = await ctx.modelRegistry
				.streamSimple(
					request.model,
					{ messages },
					{
						reasoning: request.thinkingLevel === "off" ? undefined : request.thinkingLevel,
						sessionId: sessionId(),
						maxTokens: 1,
						maxRetries: 0,
						signal: pinging.signal,
					},
				)
				.result();
			const { input, output, cacheRead, cacheWrite } = message.usage;
			const usage = { input, output, cacheRead, cacheWrite };
			debug(`ping ${request.model.provider}/${request.model.id} ${message.stopReason} ${JSON.stringify(usage)}`);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return { isAnswered: false, reason: message.errorMessage ?? message.stopReason, usage };
			}
			return { isAnswered: true, usage };
		} catch (error) {
			return { isAnswered: false, reason: errorText(error), usage: ZERO };
		} finally {
			pinging = undefined;
		}
	}

	function compact(instructions: string) {
		return new Promise<{ tokensBefore?: number; tokensAfter?: number; skip?: string }>((resolve, reject) => {
			if (!ctx) return reject(new Error("no session"));
			compacting = true;
			ctx.compact({
				customInstructions: instructions,
				onComplete: (result) => {
					compacting = false;
					requests.delete(sessionId());
					resolve({ tokensBefore: result.tokensBefore, tokensAfter: result.estimatedTokensAfter });
				},
				onError: (error) => {
					compacting = false;
					// Pi's refusals, and another extension cancelling it, are skips, not failures.
					if (/already compacted|nothing to compact|cancel/i.test(error.message)) resolve({ skip: error.message });
					else reject(error);
				},
			});
		});
	}

	const host: Host = {
		now: () => Date.now(),
		after(ms, run) {
			const timer = setTimeout(() => void run(), ms);
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		},
		contextTokens: () => (ctx ? (ctx.getContextUsage()?.tokens ?? lastPromptTokens(ctx)) : undefined),
		canPing: () => requests.has(sessionId()),
		ping,
		compact,
		show(state) {
			const ui = ctx?.hasUI ? ctx.ui : undefined;
			if (!ui) return;
			// Colors are for the terminal; RPC clients get plain text.
			const paint = (line: Line | undefined) => line && (ctx?.mode === "tui" ? ui.theme.fg(line.tone, line.text) : line.text);
			const status = paint(footer(state));
			const below = paint(widget(state, cfg));
			if (status !== shown.status) ui.setStatus(STATUS_KEY, status);
			if (below !== shown.widget) ui.setWidget(STATUS_KEY, below === undefined ? undefined : [below], { placement: "belowEditor" });
			shown = { status, widget: below };
		},
		toast(text) {
			if (ctx?.hasUI) ctx.ui.notify(text, "info");
		},
		log: debug,
		save(state) {
			const pinged = state.lastPingAt !== latest?.lastPingAt && state.lastPingAt > 0;
			latest = state;
			if (pinged) write();
			pi.events.emit(STATE_EVENT, state);
		},
		store: fileStore(path.join(getAgentDir(), "cache-warmer.json")),
	};

	function contextChanged() {
		requests.delete(sessionId());
		warmer?.contextChanged();
	}

	pi.registerCommand("warm", {
		description: "Cache warmer: status, off/on for this session, off all/on all (every session, today), now (ping)",
		getArgumentCompletions: (prefix) => {
			const items = ["off", "on", "off all", "on all", "now"].filter((arg) => arg.startsWith(prefix.trim()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, next) => {
			ctx = next;
			if (!warmer) return;
			const text = await warmer.command(args);
			if (next.hasUI) next.ui.notify(text, "info");
		},
	});

	pi.on("session_start", async (event, next) => {
		ctx = next;
		cfg = configFrom(settings().cacheWarmer as Record<string, unknown> | undefined);
		shown = {};
		warmer = new Warmer(host, cfg);
		// A new or forked session starts afresh; only the same session picks its schedule back up.
		const saved = event.reason === "new" || event.reason === "fork" ? undefined : savedState(next);
		latest = saved;
		written = JSON.stringify(saved);
		warmer.start(saved);
	});

	pi.on("session_shutdown", async (event) => {
		pinging?.abort();
		warmer?.ended();
		write();
		if (event.reason !== "reload") requests.delete(sessionId());
		warmer = undefined;
		ctx = undefined;
	});

	pi.on("context_with_system", async (event, next) => {
		if (next.model) requests.set(next.sessionManager.getSessionId(), { model: next.model, messages: event.messages, thinkingLevel: pi.getThinkingLevel() });
	});

	pi.on("agent_start", async (_event, next) => {
		ctx = next;
		pinging?.abort();
		warmer?.promptSubmitted();
	});

	pi.on("agent_settled", async (_event, next) => {
		ctx = next;
		warmer?.turnCompleted();
	});

	pi.on("session_compact", async (_event, next) => {
		ctx = next;
		if (!compacting) contextChanged();
	});

	pi.on("session_tree", async (_event, next) => {
		ctx = next;
		contextChanged();
	});

	pi.on("model_select", async (event, next) => {
		ctx = next;
		if (event.source !== "restore") contextChanged();
	});

	pi.on("thinking_level_select", async (_event, next) => {
		ctx = next;
		contextChanged();
	});

	// Pi's own idle refreshes stop 30 minutes after the last request and use the
	// model's declared lifetime, so they can't keep a 1-hour cache warm for hours.
	// This extension owns idle warming; Pi keeps its refreshes during a run.
	pi.on("cache_warming_decision", async (_event, next) => {
		if (!next.isIdle()) return undefined;
		debug("stopped Pi's idle cache refresh");
		return { action: "stop" };
	});
}
