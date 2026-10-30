// auto-effort for Pi: picks the thinking level of each prompt with a System One
// decision model (Nisev on llama.cpp, or a cloud Jev/Clef endpoint). A port of the
// Claude Code mod arthur-fontaine/cc-mod-auto-effort; see README.md.
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBuild, parseServerOutput, serverArgs, serverCommand, servesOurModel } from "./nisev.ts";
import {
	buildRequest,
	type Config,
	type Decision,
	decide,
	describe,
	isLevel,
	JEV_PRESETS,
	LEVELS,
	type Level,
	NISEV,
	resolveConfig,
	type StoredConfig,
} from "./policy.ts";
import { mainSessionOnly } from "./main-session.ts";

const STATUS_KEY = "auto-effort";
const NISEV_CHOICE = "Nisev (local)";
const OTHER = "Other…";

type NisevState = "starting" | "downloading" | "ready" | "stopped";

interface Server {
	state: NisevState;
	kill(): void;
}

// Survives the extension's reloads within one Pi process.
export interface Holder {
	server?: Server;
	starting?: Promise<NisevState>;
	// The UI of the newest runtime, for the server's progress, which outlives the runtime that started it.
	view?: { ui: ExtensionContext["ui"]; tui: boolean };
}

// How a footer label reads: in force (accent), informational (dim), or a fallback worth a look.
type Tone = "active" | "quiet" | "warn" | "error";
const COLORS = { active: "accent", quiet: "dim", warn: "warning", error: "error" } as const;

export interface Store {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
}

// Everything outside Pi the extension reaches, so tests can stub it.
export interface Deps {
	env(): Record<string, string | undefined>;
	fetch: typeof fetch;
	// Rejects when argv can't run.
	run(argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
	// `done` settles when the process ends, and rejects when it couldn't start.
	spawn(argv: string[], onOutput: (text: string) => void): { kill(): void; done: Promise<void> };
	store: Store;
	holder: Holder;
	log(message: string): void;
}

function agentDir() {
	const dir = process.env.PI_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".pi", "agent");
}

// What `/auto-effort setup` saves and whether the picker is on, kept across sessions.
function fileStore(file: string): Store {
	const load = async () => {
		try {
			const data = JSON.parse(await readFile(file, "utf8"));
			return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	return {
		async get(key) {
			return (await load())[key];
		},
		async set(key, value) {
			const data = await load();
			data[key] = value;
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
		},
	};
}

function realDeps(): Deps {
	const g = globalThis as { [key: symbol]: Holder | undefined };
	const key = Symbol.for("pi-auto-effort.server");
	const holder = (g[key] ??= {});
	if (!g[Symbol.for("pi-auto-effort.exit")]) {
		g[Symbol.for("pi-auto-effort.exit")] = {};
		// Session shutdown stops the server; this catches exits that skip it.
		process.once("exit", () => holder.server?.kill());
	}
	return {
		env: () => process.env,
		fetch: (...args) => fetch(...args),
		run: (argv, timeoutMs) =>
			new Promise((resolve, reject) => {
				execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs }, (error, stdout, stderr) => {
					// A failing exit still prints the version; only a binary that didn't run is an error.
					if (error && (error as NodeJS.ErrnoException).code === "ENOENT") reject(error);
					else if (error && !stdout && !stderr) reject(error);
					else resolve({ stdout: String(stdout), stderr: String(stderr) });
				});
			}),
		spawn(argv, onOutput) {
			const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
			// The server must never keep Pi running, as it would after `pi -p`.
			child.unref();
			for (const stream of [child.stdout, child.stderr]) {
				stream.setEncoding("utf8");
				stream.on("data", onOutput);
				(stream as unknown as { unref?: () => void }).unref?.();
			}
			const done = new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", () => resolve());
			});
			return {
				kill: () => {
					if (child.exitCode === null && child.signalCode === null) child.kill();
				},
				done,
			};
		},
		store: fileStore(path.join(agentDir(), "auto-effort.json")),
		holder,
		log(message) {
			const file = process.env.PI_AUTO_EFFORT_DEBUG;
			if (file) appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
		},
	};
}

function textOf(content: unknown) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((c: { type?: string; text?: string }) => (c?.type === "text" && c.text ? [c.text] : []))
		.join("\n");
}

export function autoEffort(pi: ExtensionAPI, deps: Deps) {
	const { holder } = deps;
	let enabled = true;
	let lastDecision: (Decision & { ms: number }) | null = null;
	let lastProblem: { text: string; at: Date } | null = null;
	// The footer label of the latest decision, dimmed once its run is over.
	let lastLabel: { text: string; tone: Tone } | null = null;
	let warnedMissing = false;
	// Set once a request reached Nisev, so a prompt doesn't probe the port every time.
	let nisevConfirmed = false;
	// Decision for the idle prompt whose run hasn't started yet. Every idle input replaces it,
	// so a prompt another extension consumed never passes its decision on.
	let pending: Decision | null = null;
	// Decisions for follow-ups queued during a run, applied when Pi delivers them.
	let followUps: { text: string; decision: Decision | null }[] = [];
	// The thinking level this extension set for the current run, and the session's own to restore.
	let override: { baseline: Level; applied: string } | null = null;
	// Levels this extension set whose thinking_level_select hasn't arrived yet.
	const ours: string[] = [];

	function view(ctx: ExtensionContext) {
		holder.view = { ui: ctx.ui, tui: ctx.mode === "tui" };
	}

	// One short label in the footer's shared extension line; RPC clients get it uncolored.
	function show(text: string | undefined, tone: Tone = "quiet") {
		const v = holder.view;
		try {
			// Pi joins the extensions' footer entries with a space; a dim bar keeps them apart.
			v?.ui.setStatus(STATUS_KEY, text && v.tui ? v.ui.theme.fg("dim", "│ ") + v.ui.theme.fg(COLORS[tone], text) : text);
		} catch {
			// A replaced runtime's UI.
		}
	}

	function notify(text: string, type: "info" | "warning" | "error" = "warning") {
		try {
			holder.view?.ui.notify(text, type);
		} catch {
			// A replaced runtime's UI.
		}
	}

	function problem(text: string) {
		lastProblem = { text, at: new Date() };
		deps.log(text);
	}

	function sessionLevel() {
		return override ? override.baseline : pi.getThinkingLevel();
	}

	// `effort ▲ high · multi-step 80%`: the level against the session's, then why.
	function label(decision: Decision): { text: string; tone: Tone } {
		const pct = typeof decision.confidence === "number" ? `${Math.round(decision.confidence * 100)}%` : "";
		const why = [decision.category?.replace("_", "-"), pct].filter(Boolean).join(" ");
		if (decision.effort) {
			const from = LEVELS.indexOf(sessionLevel() as Level);
			const to = LEVELS.indexOf(decision.effort);
			const arrow = from < 0 || from === to ? "=" : to > from ? "▲" : "▼";
			const capped = decision.choice && decision.choice !== decision.effort ? ` · picked ${decision.choice}` : "";
			return { text: `effort ${arrow} ${decision.effort}${capped}${why && ` · ${why}`}`, tone: "active" };
		}
		if (decision.reason === "default") return { text: `effort = default${why && ` · ${why}`}`, tone: "quiet" };
		if (decision.reason === "low confidence") return { text: `effort = default · unsure ${decision.choice} ${pct}`, tone: "quiet" };
		const expected = decision.reason === "model takes no effort" || decision.reason === "Nisev starting" || decision.reason === "Nisev downloading";
		return { text: `effort = default · ${decision.reason}`, tone: expected ? "quiet" : "warn" };
	}

	// The decision no longer sets the level: keep it in view, dimmed, as the last one.
	function fade() {
		if (lastLabel?.tone === "active") showDecision({ text: `last ${lastLabel.text}`, tone: "quiet" });
	}

	function showDecision(next: { text: string; tone: Tone } | null) {
		lastLabel = next;
		if (next) show(next.text, next.tone);
	}

	function nisevState(): NisevState {
		const server = holder.server;
		return server && server.state !== "stopped" ? server.state : nisevConfirmed ? "ready" : "stopped";
	}

	async function llamaServerBuild(binary: string) {
		try {
			const { stdout, stderr } = await deps.run([binary, "--version"], 10_000);
			return parseBuild(stdout + stderr);
		} catch {
			return null; // Not installed.
		}
	}

	// The configured binary, else the first of llama-server and llama that runs.
	async function findServer(config: Config) {
		for (const binary of config.llamaServer ? [config.llamaServer] : NISEV.servers) {
			const build = await llamaServerBuild(binary);
			if (build !== null) return { binary, build };
		}
		return { binary: config.llamaServer ?? NISEV.servers[0]!, build: null };
	}

	async function isServing(config: Config) {
		try {
			const response = await deps.fetch(`http://127.0.0.1:${config.port}/v1/models`, { signal: AbortSignal.timeout(config.timeoutMs) });
			return response.ok && servesOurModel(await response.text());
		} catch {
			return false;
		}
	}

	// Starts llama-server for the rest of the Pi process unless our model is already served on
	// the port; never waits for it to load. The first start downloads the model (-hf), reported
	// in the footer. The session's warm-up and its first prompt can both get here: they share one start.
	function startNisev(config: Config): Promise<NisevState> {
		holder.starting ??= launchNisev(config).finally(() => {
			holder.starting = undefined;
		});
		return holder.starting;
	}

	async function launchNisev(config: Config): Promise<NisevState> {
		if (holder.server && holder.server.state !== "stopped") return holder.server.state;
		if (await isServing(config)) {
			nisevConfirmed = true;
			return "ready";
		}
		const current: Server = { state: "starting", kill() {} };
		holder.server = current;
		const { binary } = await findServer(config);
		// llama.cpp may print nothing while it downloads, so say up front that the first start can take minutes.
		show(`Nisev starting · first start downloads ${NISEV.sizeLabel}`);
		const stopped = () => {
			current.state = "stopped";
			nisevConfirmed = false;
		};
		try {
			const child = deps.spawn(serverArgs(config, binary), (text) => {
				const seen = parseServerOutput(text);
				if (seen.ready && current.state !== "ready") {
					current.state = "ready";
					nisevConfirmed = true;
					show("Nisev ready");
				} else if (seen.percent !== undefined && current.state !== "ready") {
					current.state = "downloading";
					show(`Nisev downloading · ${seen.percent}%`);
				}
				deps.log(text.trimEnd());
			});
			current.kill = child.kill;
			child.done.then(stopped, (error: Error) => {
				failed(error);
				stopped();
			});
		} catch (error) {
			failed(error as Error);
			stopped();
		}
		return current.state;
	}

	function failed(error: Error) {
		problem(`llama-server failed to start: ${error.message}`);
		show("Nisev failed to start", "error");
		notify(`auto-effort: llama-server failed to start: ${error.message}`, "error");
	}

	async function storedConfig(): Promise<StoredConfig> {
		try {
			const saved = await deps.store.get("config");
			return saved && typeof saved === "object" ? (saved as StoredConfig) : {};
		} catch {
			return {};
		}
	}

	async function loadConfig() {
		const env = deps.env();
		return resolveConfig(
			{
				provider: env.AUTO_EFFORT_PROVIDER,
				apiKey: env.AUTO_EFFORT_API_KEY,
				endpoint: env.AUTO_EFFORT_ENDPOINT,
				model: env.AUTO_EFFORT_MODEL,
				minConfidence: env.AUTO_EFFORT_MIN_CONFIDENCE,
				timeoutMs: env.AUTO_EFFORT_TIMEOUT_MS,
				minEffort: env.AUTO_EFFORT_MIN_EFFORT,
				maxEffort: env.AUTO_EFFORT_MAX_EFFORT,
				includeContext: env.AUTO_EFFORT_INCLUDE_CONTEXT,
				llamaServer: env.AUTO_EFFORT_LLAMA_SERVER,
			},
			await storedConfig(),
		);
	}

	function previousReply(ctx: ExtensionContext) {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i]!;
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const text = textOf(entry.message.content);
				if (text) return text;
			}
		} catch {
			// No transcript to read; classify the prompt alone.
		}
		return undefined;
	}

	// The same System One call for every provider: a hosted Jev, or llama-server on this machine.
	async function askSystemOne(config: Config, body: unknown) {
		let response: Response;
		try {
			response = await deps.fetch(config.endpoint!, {
				method: "POST",
				headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				// A slow classifier must never hold up the prompt.
				signal: AbortSignal.timeout(config.timeoutMs),
			});
		} catch (error) {
			if ((error as Error).name === "TimeoutError") throw new Error(`timed out after ${config.timeoutMs}ms`);
			throw error;
		}
		const text = await response.text();
		if (response.status === 404 && config.provider === "nisev") {
			throw new Error(`llama-server has no /v1/systemone; it needs build ${NISEV.minBuild} or later`);
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
		return JSON.parse(text);
	}

	async function classify(ctx: ExtensionContext, prompt: string): Promise<Decision | null> {
		const config = await loadConfig();
		if (!config.provider) {
			if (!warnedMissing) {
				warnedMissing = true;
				notify(`auto-effort: run /auto-effort setup, or set ${config.missing.join(", ")}`);
			}
			return null;
		}
		if (config.missing.length || config.problems.length) {
			if (!warnedMissing) {
				warnedMissing = true;
				notify(
					config.problems.length
						? `auto-effort: Nisev is selected, but ${config.problems.join("; ")}. Unset them to use its defaults.`
						: `auto-effort: set ${config.missing.join(", ")}`,
				);
			}
			return null;
		}
		if (config.provider === "nisev" && nisevState() !== "ready") {
			// Start it for the next prompts; this one keeps the session's effort.
			const state = await startNisev(config);
			if (state !== "ready") return { effort: null, reason: `Nisev ${state}` };
		}
		const model = ctx.model?.id;
		const body = buildRequest({ prompt, previousReply: previousReply(ctx), model }, config);
		try {
			const decision = decide(await askSystemOne(config, body), config, model);
			if (config.provider === "nisev") nisevConfirmed = true;
			return decision;
		} catch (error) {
			problem(`effort request failed: ${(error as Error).message}`);
			if (config.provider === "nisev") nisevConfirmed = false;
			return { effort: null, reason: config.provider === "nisev" ? "Nisev unavailable" : "endpoint unavailable" };
		}
	}

	// Pi has no per-request effort, so a decision sets the session's thinking level for its run
	// and agent_settled puts the session's own back.
	function setLevel(level: string) {
		const before = pi.getThinkingLevel();
		pi.setThinkingLevel(level as Level);
		const after = pi.getThinkingLevel();
		if (after !== before) ours.push(after);
	}

	function restore() {
		if (!override) return;
		const { baseline, applied } = override;
		override = null;
		if (pi.getThinkingLevel() === applied) setLevel(baseline);
	}

	function apply(decision: Decision | null, ctx: ExtensionContext) {
		const effort = enabled ? decision?.effort : null;
		if (!effort) return restore();
		const baseline = override ? override.baseline : pi.getThinkingLevel();
		// A model without reasoning takes no effort; thinking set to off or minimal is a choice
		// outside the effort scale, left alone like a hand-set budget in Claude Code.
		if (!ctx.model?.reasoning || !isLevel(baseline)) {
			showDecision({ text: `effort = ${baseline} · ${ctx.model?.reasoning ? `thinking is ${baseline}` : "model doesn't think"}`, tone: "quiet" });
			return restore();
		}
		deps.log(`effort ${pi.getThinkingLevel()} → ${effort}`);
		setLevel(effort);
		override = { baseline, applied: pi.getThinkingLevel() };
	}

	async function saveConfig(config: StoredConfig) {
		try {
			await deps.store.set("config", config);
			return true;
		} catch {
			return false;
		}
	}

	// A choice from the list, or typed in after "Other…"; undefined when dismissed or with no UI.
	async function ask(ctx: ExtensionContext, question: string, options: string[], placeholder: string) {
		if (!ctx.hasUI) return undefined;
		const choice = await ctx.ui.select(question, [...options, OTHER]);
		if (choice !== OTHER) return choice;
		return (await ctx.ui.input(question, placeholder))?.trim() || undefined;
	}

	async function setupJev(endpoint: string, model: string) {
		const saved = await saveConfig({ provider: "jev", endpoint, model });
		const key = deps.env().AUTO_EFFORT_API_KEY;
		return [
			saved ? `Saved: ${endpoint}, model ${model}.` : "Could not save the setting for later sessions.",
			key
				? "AUTO_EFFORT_API_KEY is set, so the next prompt uses it."
				: "Now set AUTO_EFFORT_API_KEY to the key for that endpoint in the environment Pi starts in. " +
					"The key is never stored by the extension.",
			"AUTO_EFFORT_* environment variables, when set, take precedence over this setup.",
		].join("\n");
	}

	async function setupNisev(ctx: ExtensionContext) {
		const config = resolveConfig({ provider: "nisev", llamaServer: deps.env().AUTO_EFFORT_LLAMA_SERVER }, await storedConfig());
		const { binary, build } = await findServer(config);
		if (build === null) {
			return (
				`llama.cpp was not found. Install build ${NISEV.minBuild} or later, from ` +
				"https://github.com/ggml-org/llama.cpp/releases, so that llama-server or llama is on your PATH, or " +
				"set AUTO_EFFORT_LLAMA_SERVER to its path. Then run /auto-effort setup again."
			);
		}
		if (build < NISEV.minBuild) {
			return (
				`${binary} is build ${build}; decision models need build ${NISEV.minBuild} or later. ` +
				"Update it from https://github.com/ggml-org/llama.cpp/releases and run /auto-effort setup again."
			);
		}
		config.llamaServer = binary;
		const serving = await isServing(config);
		if (!serving) {
			const go = ctx.hasUI && (await ctx.ui.confirm("Download", `Download ${config.model} (${NISEV.sizeLabel}) and run it with llama.cpp?`));
			if (!go) return "Setup cancelled; nothing changed.";
		}
		await saveConfig({ provider: "nisev", model: config.model, endpoint: config.endpoint, llamaServer: config.llamaServer });
		await startNisev(config);
		return [
			`Saved: Nisev, served by ${serverCommand(binary).join(" ")} (build ${build}) at ${config.endpoint}.`,
			serving
				? "It is already running."
				: "The first start downloads the model; the footer shows the progress. Until it is ready, " +
					"prompts keep the session's thinking level.",
			"llama-server runs while Pi does; the next Pi starts it again from the cache.",
			"AUTO_EFFORT_* environment variables, when set, take precedence over this setup.",
		].join("\n");
	}

	async function setup(ctx: ExtensionContext) {
		const choice = await ask(
			ctx,
			"Which classifier should pick the effort of each prompt?",
			[NISEV_CHOICE, ...Object.keys(JEV_PRESETS)],
			"https://example.com/v1/systemone",
		);
		if (choice === undefined) return "Setup cancelled; nothing changed.";
		if (choice === NISEV_CHOICE) return setupNisev(ctx);
		const preset = JEV_PRESETS[choice];
		if (preset) return setupJev(preset.endpoint, preset.model);
		// "Other": any System One endpoint.
		if (!/^https?:\/\/\S+$/.test(choice)) {
			return "Under Other, enter the URL of a System One endpoint, such as https://example.com/v1/systemone.";
		}
		const model = await ask(ctx, "Which model name does that endpoint expect?", ["jev-latest", "jev-1.13"], "jev-latest");
		if (model === undefined) return "Setup cancelled; nothing changed.";
		return setupJev(choice, model);
	}

	async function status() {
		const config = await loadConfig();
		const lines = [`Effort picker: ${enabled ? "on" : "off"}`];
		if (config.provider === "nisev") {
			lines.push(`Provider: Nisev ${config.model} · llama.cpp at ${config.endpoint} (${nisevState()})`);
			for (const problem of config.problems) lines.push(`Problem: ${problem}`);
		} else {
			lines.push(`Provider: ${config.provider ? "System One endpoint" : "not set, run /auto-effort setup"}`);
			lines.push(`Endpoint: ${config.endpoint ?? "unset"} · model ${config.model ?? "unset"}`);
			lines.push(`API key: ${config.apiKey ? "set" : "unset"}`);
			if (config.missing.length) lines.push(`Missing: ${config.missing.join(", ")}`);
		}
		lines.push(
			`Range: ${config.minEffort}–${config.maxEffort} of ${LEVELS.join(", ")} · min confidence ${config.minConfidence}`,
			`Last decision: ${lastDecision ? describe(lastDecision) : "none yet"}`,
		);
		if (lastDecision) {
			const kind = lastDecision.category ? `${lastDecision.category.replace("_", "-")} work, ` : "";
			const why = lastDecision.effort ? "" : ` (${lastDecision.reason})`;
			lines.push(`  ${kind}decided in ${lastDecision.ms} ms${why}`);
		}
		const current = pi.getThinkingLevel();
		lines.push(`Thinking level: ${sessionLevel()}${override && current !== sessionLevel() ? `, ${current} for the running prompt` : ""}`);
		if (lastProblem) lines.push(`Last problem: ${lastProblem.text} (${lastProblem.at.toLocaleTimeString()})`);
		return lines.join("\n");
	}

	async function command(args: string, ctx: ExtensionContext) {
		const arg = args.trim().toLowerCase();
		if (arg === "setup") return setup(ctx);
		if (arg === "on" || arg === "off") {
			enabled = arg === "on";
			try {
				await deps.store.set("enabled", enabled);
			} catch {
				// Applies to this Pi only.
			}
			if (!enabled) restore();
			show(enabled ? undefined : "effort picker off");
			return `Effort picker turned ${arg}.`;
		}
		if (arg && arg !== "status") return "Usage: /auto-effort [setup|on|off|status]";
		return status();
	}

	pi.registerCommand("auto-effort", {
		description: "Set up, show or toggle the effort picker",
		getArgumentCompletions: (prefix) => {
			const items = ["setup", "on", "off", "status"].filter((a) => a.startsWith(prefix.trim().toLowerCase()));
			return items.length ? items.map((a) => ({ value: a, label: a })) : null;
		},
		handler: async (args, ctx) => {
			view(ctx);
			ctx.ui.notify(await command(args, ctx), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		view(ctx);
		try {
			const saved = await deps.store.get("enabled");
			if (typeof saved === "boolean") enabled = saved;
		} catch {
			// Keep the default.
		}
		if (!enabled) show("effort picker off");
		// Warm Nisev up before the first prompt needs it.
		const config = await loadConfig();
		if (enabled && config.provider === "nisev" && !config.problems.length) void startNisev(config);
	});

	pi.on("input", async (event, ctx) => {
		view(ctx);
		if (!event.streamingBehavior) pending = null;
		// A steer joins the running work, which keeps its decision; a follow-up gets its own.
		if (!enabled || event.streamingBehavior === "steer" || !event.text.trim()) return;
		const started = Date.now();
		// Only a slow classifier is worth a "deciding" label; Nisev answers in tens of ms.
		const slow = setTimeout(() => show("effort …"), 250);
		const decision = await classify(ctx, event.text).finally(() => clearTimeout(slow));
		if (decision) lastDecision = { ...decision, ms: Date.now() - started };
		// A follow-up's label waits for its delivery, so the footer describes the work running now.
		if (decision && event.streamingBehavior !== "followUp") showDecision(label(decision));
		else show(lastLabel?.text, lastLabel?.tone);
		if (event.streamingBehavior === "followUp") followUps.push({ text: event.text, decision });
		else pending = decision;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// A run started by an extension's custom message isn't a prompt: the session's level stands.
		const decision = event.messageType === "user" ? pending : null;
		pending = null;
		apply(decision, ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user" || !followUps.length) return;
		const text = textOf(event.message.content);
		// Pi delivers a follow-up as typed, unless a prompt template or skill expanded it.
		let i = followUps.findIndex((f) => f.text === text);
		if (i < 0 && followUps[0]!.text.startsWith("/")) i = 0;
		if (i < 0) return; // A steer.
		const [followUp] = followUps.splice(i, 1);
		if (followUp!.decision) showDecision(label(followUp!.decision));
		apply(followUp!.decision, ctx);
	});

	pi.on("thinking_level_select", async (event) => {
		const i = ours.indexOf(event.level);
		if (i >= 0) {
			ours.splice(0, i + 1);
			return;
		}
		// Chosen by hand, or by a model switch, during the run: that stands, as /effort does in Claude Code.
		if (override) {
			override = null;
			fade();
		}
	});

	pi.on("agent_settled", async () => {
		followUps = [];
		restore();
		fade();
	});

	pi.on("session_shutdown", async (event) => {
		restore();
		if (event.reason === "quit") {
			holder.server?.kill();
			holder.server = undefined;
		}
	});
}

export default function (pi: ExtensionAPI) {
	autoEffort(mainSessionOnly(pi), realDeps());
}
