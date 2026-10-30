// The extension's wiring, with Pi's own summarizer passed in by index.ts so tests can load it
// without Pi installed next to it.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CompactionResult, ExtensionAPI, ExtensionContext, generateSummaryWithUsage, InputEvent, Theme } from "@earendil-works/pi-coding-agent";
import { drawDebug, fit, type Paint, TITLE, type Trace, WIDGET } from "./debug.ts";
import { parseBuild, parseServerOutput, serverArgs, serverCommand, servesOurModel } from "./llama.ts";
import {
	type Config, compactInstructions, type Decision, decide, describe, headers, logLine, MODES, type Mode, PRESETS,
	resolveConfig, SPISEV, type StoredConfig,
} from "./policy.ts";
import { COMPACT_V2 } from "./prompt.ts";
import { type Completion, SUMMARIZER, type SummaryError, type SummaryRequest, summarize, systemPromptV2 } from "./summarizer.ts";
import { agentReply, clipStateV2, requestV2 } from "./task.ts";
import { actedNote, DECLINED, failedNote, tokens } from "./notes.ts";
import { clip, cleanPrompt, messages, render, type TreeMessage, utf8Len } from "./text.ts";
import { rowsOf } from "./transcript.ts";
import * as tree from "./tree.ts";

// Pi's default compaction.keepRecentTokens (DEFAULT_COMPACTION_SETTINGS), read without importing Pi.
const PI_KEEP_RECENT_TOKENS = 20_000;

const SUMMARY_CONCURRENCY = 4;
const BUILD_WAIT_MS = 120_000;
// What the debug view keeps of a summary's input: a message can run to MAX_AGENT_BYTES.
const INPUT_BYTES = 1024;
// The saved tree's format: v2 lines (128 bytes, compact-v2.md) never mix with a v1 session's.
const TREE_VERSION = 2;
// The first prompt of a session usually comes while llama-server loads the model (a few seconds):
// wait for it a little rather than skip the decision. A download is never waited for.
const START_WAIT_MS = 10_000;
const CLEARED = "The conversation before this point was cleared: the next message starts an unrelated task.";

type ServerState = "starting" | "downloading" | "ready" | "stopped";
interface Server {
	state: ServerState;
	child: ChildProcess | null;
	// The download's progress, for /auto-compact.
	percent?: number;
}

// On globalThis, not in the factory: /new, /resume and /reload replace the extension runtime, and
// llama-server keeps serving the next one, as it does across Claude Code's /clear.
const SERVER_KEY = Symbol.for("pi-auto-compact.server");
const servers = globalThis as { [SERVER_KEY]?: Server };

function agentDir() {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return path.join(os.homedir(), ".pi", "agent");
	return dir === "~" ? os.homedir() : dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

function dataDir() {
	return process.env.AUTO_COMPACT_DATA_DIR || path.join(agentDir(), "auto-compact");
}

// Claude Code's $.store: the saved provider and mode, never a key.
function configPath() {
	return path.join(agentDir(), "auto-compact", "config.json");
}

function debug(text: string) {
	const file = process.env.AUTO_COMPACT_DEBUG_LOG;
	if (file) {
		try {
			appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
		} catch {
			// A debug log must never break a prompt.
		}
	}
}

// FNV-1a over the request: a stable key for a node, whatever position it has in the transcript.
export function hash(text: string) {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Waits for `work` at most `ms`, without a timer left to hold a -p run open.
async function bounded(work: Promise<unknown>, ms: number) {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

class Missing extends Error {}

type View = [tree.Node, string, "raw" | "joined" | "summary" | undefined, { name: string | null; text: string }[] | undefined][];

interface Plan {
	decision: Decision;
	instructions: string;
	// Chosen in the suggest dialog rather than taken in auto mode.
	asked?: boolean;
}

function painter(theme: Theme): Paint {
	return (tone, text) => {
		switch (tone) {
			case "heading":
				return theme.bold(theme.fg("accent", text));
			case "bold":
				return theme.bold(text);
			case "subtle":
				return theme.fg("muted", text);
			case "success":
			case "warning":
			case "error":
			case "accent":
			case "dim":
			case "text":
				return theme.fg(tone, text);
		}
	};
}

export interface Deps {
	summarizeMessages: typeof generateSummaryWithUsage;
}

export function autoCompact(pi: ExtensionAPI, deps: Deps) {
	let systemPrompt: string | null = null;
	let nodes: Record<string, string> | null = null; // summary line by hash of its request, for this session
	let nodesPath: string | null = null;
	let building: Promise<void> | null = null;
	let lastDecision: (Decision & { outcome: string }) | null = null;
	let lastError: string | null = null;
	let clearProblem: string | null = null;
	// A line for the prompt being sent, posted under it once Pi has drawn it.
	let note: { text: string; type: "info" | "warning" } | null = null;
	const alerted = new Set<string>();
	let trace: Trace | null = null;
	let paneOpen = false;
	// The compaction this extension asked for, told apart from /compact and Pi's own by its instructions.
	let acting: Plan | null = null;
	// Server progress comes after the event that started it, so it goes to the latest context.
	let current: ExtensionContext | null = null;

	const ui = (fn: (ctx: ExtensionContext) => void) => {
		if (!current) return;
		try {
			fn(current);
		} catch {
			// A context replaced by /new or /resume.
		}
	};

	// Once per kind of problem: a provider that keeps failing must not notify on every prompt. One
	// found while deciding on a prompt waits to go under it, as the line for an action does.
	const alert = (kind: string, text: string, level: "warning" | "error" = "warning", underPrompt = false) => {
		if (kind && alerted.has(kind)) return;
		if (kind) alerted.add(kind);
		if (underPrompt) note = { text, type: "warning" };
		else ui((ctx) => ctx.ui.notify(text, level));
	};

	const drawPane = () => {
		if (!paneOpen) return;
		ui((ctx) => {
			if (ctx.mode === "tui") {
				ctx.ui.setWidget(WIDGET, (_tui, theme) => ({
					render: (width: number) => [fit(theme.fg("dim", TITLE), width), ...drawDebug(trace, width - 1, painter(theme))],
					invalidate() {},
				}), { placement: "belowEditor" });
			} else ctx.ui.setWidget(WIDGET, drawDebug(trace, 100, (_tone, text) => text));
		});
	};

	const record = (fn: (t: Trace | null) => Trace | null) => {
		trace = fn(trace);
		drawPane();
	};

	async function storedConfig(): Promise<StoredConfig> {
		try {
			const saved = JSON.parse(await readFile(configPath(), "utf8"));
			return saved && typeof saved === "object" ? saved : {};
		} catch {
			return {};
		}
	}

	async function loadConfig() {
		const env = process.env;
		return resolveConfig({
			provider: env.AUTO_COMPACT_PROVIDER,
			endpoint: env.AUTO_COMPACT_ENDPOINT,
			model: env.AUTO_COMPACT_MODEL,
			auth: env.AUTO_COMPACT_AUTH,
			apiKey: env.AUTO_COMPACT_API_KEY,
			mode: env.AUTO_COMPACT_MODE,
			minConfidence: env.AUTO_COMPACT_MIN_CONFIDENCE,
			suggestConfidence: env.AUTO_COMPACT_SUGGEST_CONFIDENCE,
			timeoutMs: env.AUTO_COMPACT_TIMEOUT_MS,
			llamaServer: env.AUTO_COMPACT_LLAMA_SERVER,
		}, await storedConfig());
	}

	async function saveConfig(patch: StoredConfig) {
		try {
			await mkdir(path.dirname(configPath()), { recursive: true });
			await writeFile(configPath(), JSON.stringify({ ...(await storedConfig()), ...patch }, null, "\t") + "\n");
			return true;
		} catch {
			return false;
		}
	}

	const system = () => (systemPrompt ??= systemPromptV2(COMPACT_V2, tree.MEMORY_LIMIT));

	const summarizerSettings = () => ({ ...SUMMARIZER, model: process.env.AUTO_COMPACT_SUMMARIZER_MODEL || SUMMARIZER.model });

	// `provider/id`, or a bare id looked up in the session's provider, then Claude Code's: the pinned
	// Haiku through the person's own Claude login, as $.model.complete does. No wider search, so
	// summaries never move to another provider (and its billing) on their own.
	function summarizerModel(ctx: ExtensionContext, wanted: string) {
		const registry = ctx.modelRegistry;
		const slash = wanted.indexOf("/");
		if (slash > 0) {
			const model = registry.find(wanted.slice(0, slash), wanted.slice(slash + 1));
			return model && registry.hasConfiguredAuth(model) ? model : undefined;
		}
		for (const provider of new Set([ctx.model?.provider, "claude-code"])) {
			const model = provider && registry.find(provider, wanted);
			if (model && registry.hasConfiguredAuth(model)) return model;
		}
		return undefined;
	}

	async function complete(ctx: ExtensionContext, request: SummaryRequest): Promise<Completion> {
		const model = summarizerModel(ctx, request.model);
		if (!model) return { isAnswered: false, reason: "no model " + request.model + " with credentials in Pi" };
		const reply = await ctx.modelRegistry.streamSimple(model, {
			systemPrompt: request.system,
			messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
		}, { maxTokens: request.maxTokens, reasoning: request.effort as "low" }).result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			const error = reply.errorMessage ?? "";
			const limited = /\b429\b|rate.?limit|usage limit/i.test(error);
			return { isAnswered: false, reason: reply.stopReason === "error" ? "api-error" : "aborted", ...(limited && { status: 429 }), error };
		}
		return { isAnswered: true, text: reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") };
	}

	// The session's summary lines, saved per session id (not in Pi's session file: it is memory, not context).
	async function loadNodes(ctx: ExtensionContext) {
		const file = path.join(dataDir(), "trees", ctx.sessionManager.getSessionId() + ".json");
		if (nodes && nodesPath === file) return nodes;
		nodesPath = file;
		try {
			const saved = JSON.parse(await readFile(file, "utf8"));
			nodes = saved.version === TREE_VERSION ? saved.nodes ?? {} : {};
		} catch {
			nodes = {};
		}
		return nodes!;
	}

	async function saveNodes() {
		if (!nodesPath || !nodes) return;
		try {
			await mkdir(path.dirname(nodesPath), { recursive: true });
			await writeFile(nodesPath, JSON.stringify({ version: TREE_VERSION, summarizer: summarizerSettings().model, nodes }));
		} catch (error) {
			debug("[auto-compact] could not save the tree: " + (error as Error).message);
		}
	}

	// The text of every line of the memory at msgs.length (tree.memoryView), with where it came from:
	// `raw` (the message, under tree.MEMORY_LIMIT), `joined` (both halves, under it together) or `summary`
	// (the summarizer, from the inputs given: the message, or both halves by name).
	// With `allowCalls`, missing summaries are built, up to SUMMARY_CONCURRENCY at once; without, a missing one throws.
	async function treeTexts(ctx: ExtensionContext, msgs: TreeMessage[], { allowCalls }: { allowCalls: boolean }): Promise<View> {
		const store = await loadNodes(ctx);
		const sys = allowCalls ? system() : "";
		const settings = summarizerSettings();
		const memo = new Map<string, Promise<string>>();
		const sources = new Map<string, "raw" | "joined" | "summary">();
		const inputs = new Map<string, { name: string | null; text: string }[]>();
		let active = 0;
		const waiting: (() => void)[] = [];
		const slot = async () => {
			if (active < SUMMARY_CONCURRENCY) return void active++;
			await new Promise<void>((resolve) => waiting.push(resolve));
			active++;
		};
		const release = () => {
			active--;
			waiting.shift()?.();
		};
		const text = (node: tree.Node): Promise<string> => {
			const k = tree.key(node);
			if (!memo.has(k)) memo.set(k, build(node));
			return memo.get(k)!;
		};
		const build = async (node: tree.Node) => {
			const source = node[0] === 0 ? render(msgs[node[1]]!) : await Promise.all(tree.children(node).map(text));
			const free = tree.noCallText(node, source, tree.MEMORY_LIMIT);
			sources.set(tree.key(node), free === null ? "summary" : node[0] === 0 ? "raw" : "joined");
			if (free !== null) return free;
			inputs.set(tree.key(node), node[0] === 0
				? [{ name: null, text: source as string }]
				: tree.children(node).map((child, i) => ({ name: tree.name(child), text: source[i]! })));
			const context = await Promise.all(tree.memoryContext(node).map(async (n) => [n, await text(n)] as [tree.Node, string]));
			const prompt = node[0] === 0
				? tree.leafPrompt(node[1], source as string, context)
				: tree.mergePrompt(...(tree.children(node) as [tree.Node, tree.Node]), source[0]!, source[1]!, context);
			const id = hash(settings.model + "\n" + prompt);
			if (store[id]) return store[id]!;
			if (!allowCalls) throw new Missing(tree.name(node));
			await slot();
			try {
				const { line } = await summarize((r) => complete(ctx, r), prompt, sys, settings,
					{ limit: tree.MEMORY_LIMIT, clean: tree.cleanLineV2 });
				store[id] = line;
				return line;
			} finally {
				release();
			}
		};
		const lines = tree.memoryView(msgs.length);
		const order = tree.neededMemory([lines]);
		const results = await Promise.allSettled(order.map(text));
		const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
		if (failed) throw failed.reason;
		return Promise.all(lines.map(async (n) => [n, await text(n), sources.get(tree.key(n)), inputs.get(tree.key(n))] as View[number]));
	}

	const sessionMessages = (ctx: ExtensionContext) => messages(rowsOf(ctx.sessionManager.buildSessionProjection().messages));

	// The v2 state: the memory through the agent's last reply, that reply as it was written, the message.
	const stateOf = (view: View, msgs: TreeMessage[], message: string) =>
		clipStateV2(tree.viewText(view), agentReply(msgs[msgs.length - 1]), message);

	async function buildTree(ctx: ExtensionContext) {
		const msgs = sessionMessages(ctx);
		try {
			await treeTexts(ctx, msgs, { allowCalls: true });
			lastError = null;
		} catch (error) {
			lastError = (error as Error).message;
			debug("[auto-compact] summaries: " + lastError);
			if ((error as SummaryError).isLimit) {
				alert("limit", "auto-compact: Claude usage limit, summaries paused. Until they catch up, every prompt keeps the context.");
			} else alert("summaries", "auto-compact: summaries failed (" + lastError + "). Until they catch up, every prompt keeps the context.");
		} finally {
			await saveNodes();
		}
	}

	async function llamaBuild(binary: string) {
		try {
			const { stdout, stderr } = await pi.exec(binary, ["--version"], { timeout: 10_000 });
			return parseBuild(stdout + stderr);
		} catch {
			return null;
		}
	}

	async function findServer(config: Config) {
		for (const binary of config.llamaServer ? [config.llamaServer] : SPISEV.servers) {
			const build = await llamaBuild(binary);
			if (build !== null) return { binary, build };
		}
		return { binary: config.llamaServer ?? SPISEV.servers[0]!, build: null };
	}

	async function isServing(config: Config) {
		try {
			const r = await fetch("http://127.0.0.1:" + config.port + "/v1/models", { signal: AbortSignal.timeout(2000) });
			return r.ok && servesOurModel(await r.text());
		} catch {
			return false;
		}
	}

	// Starts llama-server for the rest of the Pi process unless our model is already served; never waits.
	async function startSpisev(config: Config): Promise<ServerState> {
		const running = servers[SERVER_KEY];
		if (running && running.state !== "stopped") return running.state;
		if (await isServing(config)) {
			servers[SERVER_KEY] = { state: "ready", child: null };
			return "ready";
		}
		const { binary } = await findServer(config);
		const argv = serverArgs(config, binary);
		const server: Server = { state: "starting", child: null };
		servers[SERVER_KEY] = server;
		const failed = (message: string) => {
			debug("[auto-compact] llama-server failed to start: " + message);
			alert("server", "auto-compact: llama-server failed to start (" + message + "); every prompt keeps the context. " +
				"Set AUTO_COMPACT_DEBUG_LOG to a file to see more.", "error");
		};
		try {
			const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
			server.child = child;
			const read = (chunk: Buffer) => {
				const seen = parseServerOutput(chunk.toString());
				if (seen.ready && server.state !== "ready") {
					server.state = "ready";
				} else if (seen.percent !== undefined && server.state !== "ready") {
					server.state = "downloading";
					server.percent = seen.percent;
				}
			};
			child.stdout?.on("data", read);
			child.stderr?.on("data", read);
			child.on("error", (error) => failed(error.message));
			child.on("exit", (code) => {
				if (server.state !== "ready") failed("exited with code " + code);
				server.state = "stopped";
			});
			// A Pi that exits without its shutdown event must not leave llama-server behind.
			process.once("exit", () => child.kill());
		} catch (error) {
			failed((error as Error).message);
			server.state = "stopped";
		}
		return server.state;
	}

	async function spisevReady(config: Config) {
		let state = await startSpisev(config);
		for (let waited = 0; state === "starting" && waited < START_WAIT_MS; waited += 250) {
			await sleep(250);
			const server = servers[SERVER_KEY];
			state = server?.state ?? "stopped";
			if (state === "starting" && (await isServing(config))) state = server!.state = "ready";
		}
		return state;
	}

	async function askProvider(config: Config, state: ReturnType<typeof stateOf>) {
		const model = config.provider === "spisev" ? SPISEV.alias : config.model!;
		let response: Response;
		try {
			response = await fetch(config.endpoint!, {
				method: "POST", headers: headers(config), body: JSON.stringify(requestV2(state, model)),
				signal: AbortSignal.timeout(config.timeoutMs),
			});
		} catch (error) {
			if ((error as Error).name === "TimeoutError") throw new Error("timed out after " + config.timeoutMs + "ms");
			throw error;
		}
		const text = await response.text();
		if (!response.ok) throw new Error("HTTP " + response.status + " " + text.slice(0, 200));
		return JSON.parse(text);
	}

	// Everything before the next message is known once a turn ends: llama-server reads it now, while
	// the person reads and types, and keeps it in its prompt cache, so the decision has only the new
	// message left to read. Local only: a cloud provider would bill each of these requests.
	async function prefill(ctx: ExtensionContext, config: Config) {
		if (config.provider !== "spisev" || (await startSpisev(config)) !== "ready") return;
		try {
			const msgs = sessionMessages(ctx);
			if (msgs.length < 2) return;
			const view = await treeTexts(ctx, msgs, { allowCalls: false });
			await askProvider(config, stateOf(view, msgs, ""));
		} catch (error) {
			debug("[auto-compact] prefill: " + (error as Error).message);
		}
	}

	// Pi's own summarizer, over the whole context: like Claude Code's /compact, nothing is kept
	// verbatim, unlike Pi's default compaction, which keeps the last keepRecentTokens.
	async function summarizeContext(ctx: ExtensionContext, instructions: string, signal: AbortSignal) {
		const model = ctx.model;
		if (!model) throw new Error("no model selected");
		return deps.summarizeMessages(ctx.sessionManager.buildSessionProjection().messages, model, undefined, undefined,
			undefined, signal, instructions, undefined, undefined,
			(m, context, options) => ctx.modelRegistry.streamSimple(m, context, options));
	}

	// Pi compacts under the input hook, so the prompt goes on afterwards unchanged, attachments
	// included: nothing is held back and sent again, as Claude Code needs.
	async function perform(ctx: ExtensionContext, plan: Plan) {
		acting = plan;
		try {
			return await new Promise<CompactionResult | undefined>((resolve, reject) =>
				ctx.compact({ customInstructions: plan.instructions, onComplete: resolve, onError: reject }));
		} finally {
			acting = null;
		}
	}

	async function offer(ctx: ExtensionContext, decision: Decision) {
		if (!ctx.hasUI) return false; // no one to ask (a -p run): nothing happens without the press
		const verb = decision.action === "clear" ? "Clear the context first" : "Compact the context first";
		const usage = ctx.getContextUsage();
		const question = "auto-compact: this prompt looks " + decision.category!.replace("_", " ") + " (" +
			Math.round(decision.confidence! * 100) + "%). " + verb + "?" +
			(usage?.tokens ? " The context holds " + tokens(usage.tokens) + " tokens (" + Math.round(usage.percent ?? 0) + "%)." : "");
		try {
			return (await ctx.ui.select(question, [verb, "Send as is"])) === verb;
		} catch {
			return false;
		}
	}

	async function onPrompt(ctx: ExtensionContext, event: InputEvent) {
		const config = await loadConfig();
		if (config.mode === "off") return;
		if (!config.provider || config.missing.length || config.problems.length) {
			alert("setup", config.provider
				? "auto-compact: " + [...config.missing.map((m) => "set " + m), ...config.problems].join("; ")
				: "auto-compact: run /auto-compact setup to choose a provider", "warning", true);
			return;
		}
		if (building) await bounded(building, 2000);
		const msgs = sessionMessages(ctx);
		const prompt = cleanPrompt(event.text) ?? event.text;
		const seen: Trace = { at: Date.now(), message: prompt, memory: null, lines: null, messages: msgs.length,
			decision: null, latencyMs: null, outcome: "" };
		const skip = (outcome: string) => record(() => ({ ...seen, outcome }));
		if (msgs.length < 2) return skip("skipped (fewer than 2 messages)");
		// Pi compacts only what lies beyond its last keepRecentTokens, and refuses a session that
		// fits in them ("Nothing to compact"): no use asking the classifier then.
		const keep = (pi.getSettings() as { compaction?: { keepRecentTokens?: number } }).compaction?.keepRecentTokens ?? PI_KEEP_RECENT_TOKENS;
		const used = ctx.getContextUsage()?.tokens;
		if (used == null || used <= keep) return skip("skipped (" + (used ?? "unknown") + " tokens, within the " + keep + " Pi always keeps)");
		let view: View;
		try {
			view = await treeTexts(ctx, msgs, { allowCalls: false });
		} catch (error) {
			if (!(error instanceof Missing)) throw error;
			debug("[auto-compact] summaries catching up (" + error.message + " not built) → keep");
			return skip("skipped (summaries catching up: " + error.message + " not built)");
		}
		if (config.provider === "spisev" && (await spisevReady(config)) !== "ready") {
			const state = servers[SERVER_KEY]?.state ?? "stopped";
			debug("[auto-compact] Spisev " + state + " → keep");
			return skip("skipped (Spisev " + state + ")");
		}
		const viewText = tree.viewText(view);
		const state = stateOf(view, msgs, prompt);
		seen.message = state.latest_user_message;
		seen.memory = state.memory;
		seen.lines = view.map(([node, text, source, from]) => ({
			name: tree.name(node), source: source ?? "raw", bytes: utf8Len(text),
			from: from ? from.map((input) => ({ ...input, text: clip(input.text, INPUT_BYTES) })) : null,
		}));
		let decision: Decision;
		const asked = Date.now();
		try {
			decision = decide(await askProvider(config, state), config);
		} catch (error) {
			lastError = (error as Error).message;
			debug("[auto-compact] provider: " + lastError + " → keep");
			alert("provider:" + lastError, "auto-compact: the decision model failed (" + lastError + "); the context is kept.", "warning", true);
			seen.latencyMs = Date.now() - asked;
			return skip("keep (provider: " + lastError + ")");
		}
		seen.latencyMs = Date.now() - asked;
		seen.decision = {
			category: decision.category, confidence: decision.confidence, action: decision.action,
			reason: decision.reason, probabilities: decision.probabilities ?? {},
		};
		const outcome = decision.action === "keep" ? "keep" : decision.reason === "suggest" ? "suggested" : "keep (" + decision.reason + ")";
		skip(decision.suggest ? "waiting for your answer" : decision.act ? "acting" : outcome);
		const accepted = decision.suggest && (await offer(ctx, decision));
		lastDecision = { ...decision, outcome };
		if (decision.act || accepted) {
			const instructions = decision.action === "clear" ? CLEARED : compactInstructions(decision, viewText, prompt);
			return { decision, instructions, asked: accepted };
		}
		// Only a dialog the person answered: with no one to ask (-p), nothing was offered. Under the
		// prompt, as there is no compaction block to go under. Above it, auto-effort's line, posted
		// before Pi's next frame, would show in its place: Pi's dim notices all draw the latest text.
		if (decision.suggest && ctx.hasUI) note = { text: DECLINED, type: "info" };
		skip(outcome);
		debug(logLine(decision, outcome));
	}

	async function act(ctx: ExtensionContext, plan: Plan) {
		const { decision } = plan;
		const verb = decision.action === "clear" ? "clear" : "compact";
		debug(logLine(decision, verb));
		record((t) => t && { ...t, outcome: verb === "clear" ? "clearing" : "compacting" });
		let outcome: string;
		try {
			await perform(ctx, plan);
			outcome = verb === "clear" ? "cleared" : "compacted";
			// Right under Pi's own compaction block (`Compacted from 48,200 tokens`), which it explains,
			// and so above the prompt, apart from auto-effort's line under it.
			ui((c) => c.ui.notify(actedNote(decision, plan.asked ?? false), "info"));
		} catch (error) {
			const message = (error as Error).message;
			if (decision.action === "clear") clearProblem = message;
			outcome = "keep (could not " + verb + ": " + message + ")";
			// No compaction block to go under; a warning is never replaced by the next notice.
			note = { text: failedNote(decision, message), type: "warning" };
		}
		lastDecision = { ...decision, outcome };
		record((t) => t && { ...t, outcome });
		debug("[auto-compact] " + outcome + ", sending the prompt");
	}

	async function setup(ctx: ExtensionContext): Promise<string> {
		if (!ctx.hasUI) return "Setup needs Pi's interactive UI.";
		const choice = await ctx.ui.select("Which decision model should spot task boundaries?",
			["Spisev (local)", ...Object.keys(PRESETS), "Other"]);
		if (!choice) return "Setup cancelled; nothing changed.";
		if (choice === "Spisev (local)") {
			const config = resolveConfig({ provider: "spisev", llamaServer: process.env.AUTO_COMPACT_LLAMA_SERVER, model: process.env.AUTO_COMPACT_MODEL }, {});
			const { binary, build } = await findServer(config);
			if (build === null || build < SPISEV.minBuild) {
				return "llama.cpp build " + SPISEV.minBuild + " or later is needed (llama-server or llama on your PATH, " +
					"or AUTO_COMPACT_LLAMA_SERVER). Install it from https://github.com/ggml-org/llama.cpp/releases and run /auto-compact setup again.";
			}
			if (!(await isServing(config)) && !/\.gguf$/i.test(config.model!)) {
				const go = await ctx.ui.select("Download " + config.model + " (" + SPISEV.sizeLabel + ") and run it with llama.cpp?",
					["Download and start", "Cancel"]);
				if (go !== "Download and start") return "Setup cancelled; nothing changed.";
			}
			await saveConfig({ provider: "spisev", endpoint: config.endpoint, model: config.model, llamaServer: binary });
			await startSpisev({ ...config, llamaServer: binary });
			return "Saved: Spisev (spisev-alpha), served by " + serverCommand(binary).join(" ") + " (build " + build + ") at " +
				config.endpoint + ". llama-server runs while Pi does. Nothing leaves this machine.";
		}
		const preset = PRESETS[choice];
		if (!preset) return "Use AUTO_COMPACT_ENDPOINT and AUTO_COMPACT_MODEL for any System One endpoint.";
		await saveConfig({ provider: "systemone", ...preset });
		return "Saved: " + choice + " at " + preset.endpoint + ", model " + preset.model + ". " +
			(process.env.AUTO_COMPACT_API_KEY ? "AUTO_COMPACT_API_KEY is set." : "Now set AUTO_COMPACT_API_KEY in your environment; the extension never stores it.") +
			" Only the clipped state (summary lines, the agent's last reply and the new message) is sent.";
	}

	async function status(ctx: ExtensionContext) {
		const config = await loadConfig();
		const lines = ["auto-compact mode: " + config.mode + (config.mode === "auto" ? " (acts at ≥ " + config.minConfidence + ")" : config.mode === "suggest" ? " (asks at ≥ " + config.suggestConfidence + ")" : "")];
		if (config.provider === "spisev") {
			const server = servers[SERVER_KEY];
			const percent = server?.state === "downloading" && server.percent !== undefined ? " " + server.percent + "%" : "";
			lines.push("Provider: Spisev (spisev-alpha) " + config.model + " at " + config.endpoint + " (" + (server?.state ?? "stopped") + percent + ")");
		}
		else if (config.provider) lines.push("Provider: " + config.endpoint + " · model " + config.model + " · key " + (config.apiKey ? "set" : "unset"));
		else lines.push("Provider: none, run /auto-compact setup");
		for (const p of [...config.missing.map((m) => "set " + m), ...config.problems]) lines.push("Problem: " + p);
		let state: string;
		try {
			const msgs = sessionMessages(ctx);
			await treeTexts(ctx, msgs, { allowCalls: false });
			state = msgs.length + " messages, " + Object.keys(await loadNodes(ctx)).length + " summaries, up to date";
		} catch (error) {
			state = "catching up (" + (error as Error).message + ")";
		}
		lines.push("Tree: " + state + " · summarizer " + summarizerSettings().model);
		lines.push("Last decision: " + (lastDecision ? describe(lastDecision, /ed$/.test(lastDecision.outcome)) + " → " + lastDecision.outcome : "none yet"));
		if (clearProblem) lines.push("Clear falls back to keeping the context: " + clearProblem);
		if (lastError) lines.push("Last error: " + lastError);
		return lines.join("\n");
	}

	pi.registerCommand("auto-compact", {
		description: "Show or set up the task-boundary classifier that offers to compact",
		getArgumentCompletions: (prefix) => {
			const all = ["setup", "debug", "mode off", "mode suggest", "mode auto"];
			const items = all.filter((v) => v.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			current = ctx;
			const [arg, value] = args.trim().toLowerCase().split(/\s+/);
			let text: string;
			if (arg === "setup") text = await setup(ctx);
			else if (arg === "debug") {
				paneOpen = !paneOpen;
				if (paneOpen) drawPane();
				else ctx.ui.setWidget(WIDGET, undefined);
				text = paneOpen ? "Debug view opened; /auto-compact debug again closes it." : "Debug view closed.";
			} else if (arg === "mode") {
				if (!MODES.includes(value as Mode)) text = "Usage: /auto-compact mode off|suggest|auto";
				else {
					const saved = await saveConfig({ mode: value });
					text = "auto-compact mode: " + value + (saved ? " (saved for later sessions)." : " (this session only).");
				}
			} else if (arg) text = "Usage: /auto-compact [setup|debug|mode off|suggest|auto]";
			else text = await status(ctx);
			ctx.ui.notify(text, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		const config = await loadConfig();
		drawPane();
		if (config.mode !== "off" && config.provider === "spisev" && !config.problems.length) await startSpisev(config);
	});

	pi.on("input", async (event, ctx) => {
		current = ctx;
		// A delivery into a running turn is no new request; slash commands (skills, templates) aren't either.
		if (event.streamingBehavior !== undefined) return;
		note = null;
		if (!event.text.trim() || event.text.trimStart().startsWith("/")) return;
		try {
			const plan = await onPrompt(ctx, event);
			if (plan) await act(ctx, plan);
		} catch (error) {
			debug("[auto-compact] " + (error as Error).message + " → keep");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const plan = acting;
		if (!plan || event.reason !== "manual" || event.customInstructions !== plan.instructions) return;
		const { action: wanted, category, confidence } = plan.decision;
		const details = { autoCompact: { action: wanted, category, confidence } };
		// appendCompaction() keeps entries from firstKeptEntryId ?? its own id: a self-retaining
		// compaction (the documented meaning of null in boundary drafts) keeps nothing before it.
		const keepNothing = null as unknown as string;
		const tokensBefore = event.preparation.tokensBefore;
		if (wanted === "clear") return { compaction: { summary: CLEARED, firstKeptEntryId: keepNothing, tokensBefore, details } };
		const { text, usage } = await summarizeContext(ctx, plan.instructions, event.signal);
		if (!text.trim()) return { cancel: true };
		return { compaction: { summary: text, firstKeptEntryId: keepNothing, tokensBefore, usage, details } };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		current = ctx;
		const config = await loadConfig();
		if (config.mode === "off" || !config.provider) return;
		const run = buildTree(ctx).finally(() => {
			if (building === run) building = null;
		});
		building = run;
		void run.then(() => prefill(ctx, config));
		// A -p run exits once this returns: let it save the tree first. Interactively, a prompt sent
		// meanwhile would wait for this handler, so the build goes on in the background.
		if (ctx.mode === "print" || ctx.mode === "json") await bounded(run, BUILD_WAIT_MS);
	});

	// Pi draws the user message on message_start, after the extensions' handlers, so the line waits
	// for message_end to land right under it rather than above it.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user" || !note) return;
		const { text, type } = note;
		note = null;
		try {
			ctx.ui.notify(text, type);
		} catch {
			// A replaced runtime's UI.
		}
	});

	pi.on("session_shutdown", async (event) => {
		await saveNodes();
		nodes = null; // /new starts another session id, with a tree of its own
		current = null;
		if (event.reason === "quit") {
			servers[SERVER_KEY]?.child?.kill();
			delete servers[SERVER_KEY];
		}
	});
}
