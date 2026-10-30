// session-name for Pi: Claude Code's /rename, plus names that follow the task. An unnamed session
// is named after its first run; while it stays in automatic mode, a quiet re-check after later
// runs renames it only when the task has clearly changed. The names are pi-intercom addresses
// (`@name message`), so they are short kebab-case, unique among live sessions, and kept stable.
// See README.md.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHECK_CHARS,
	type Checkpoint,
	condense,
	decide,
	ENTRY_TYPE,
	type EntryLike,
	type Mode,
	type ModeEntry,
	NAMING_CHARS,
	nameKey,
	parseReply,
	POLICY,
	type Policy,
	progress,
	recentExchange,
	restoreMode,
	shouldCheck,
	toAddress,
	uniqueName,
} from "./naming.ts";
import { CHECK_SYSTEM, checkUser, RENAME_SYSTEM, renameUser } from "./prompts.ts";

// Only the Claude subscription: the built-in anthropic provider's stored login is stale.
export const PROVIDER = "claude-code";
export const MODEL = "claude-haiku-5-5";
// A JSON object with a few words in it; claude -p takes 2-3 s.
const MAX_TOKENS = 256;
const TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 2_000;

const INTERCOM_REGISTER = "intercom:extension-register";
const INTERCOM_READY = "intercom:extension-registry-ready";
const INTERCOM_NAMESPACE = "session-name";

interface LiveSession {
	id: string;
	name?: string;
	pid: number;
	runtimeFallbackAlias?: boolean;
}

type Completion = { ok: true; text: string } | { ok: false; reason: string };

export interface Deps {
	now(): number;
	// Returns a cancel function. The timer must never keep `pi -p` running.
	schedule(run: () => void, ms: number): () => void;
	policy: Policy;
	log(message: string): void;
}

function realDeps(): Deps {
	return {
		now: () => Date.now(),
		schedule(run, ms) {
			const timer = setTimeout(run, ms);
			timer.unref();
			return () => clearTimeout(timer);
		},
		policy: POLICY,
		log(message) {
			const file = process.env.PI_SESSION_NAME_DEBUG;
			if (file) {
				try {
					appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
				} catch {
					// A debug log must never break a run.
				}
			}
		},
	};
}

export function sessionName(pi: ExtensionAPI, deps: Deps) {
	let mode: Mode = "auto";
	// Bumped by a session switch and by every /rename, so an older model reply is dropped.
	let epoch = 0;
	let busy = false;
	let checkpoint: Checkpoint = { prompts: 0, chars: 0, at: 0, keeps: 0 };
	let cancelTimer: (() => void) | undefined;
	// Names this extension set whose session_info_changed hasn't arrived yet.
	const ours: string[] = [];
	let intercom: { listSessions(): Promise<LiveSession[]> } | undefined;

	function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" = "info") {
		try {
			ctx.ui.notify(text, type);
		} catch {
			// A replaced session's UI.
		}
	}

	function branch(ctx: ExtensionContext) {
		return ctx.sessionManager.getBranch() as unknown as EntryLike[];
	}

	function apply(name: string, next: Mode) {
		mode = next;
		if (pi.getSessionName() !== name) {
			ours.push(name);
			pi.setSessionName(name);
		}
		pi.appendEntry<ModeEntry>(ENTRY_TYPE, { mode: next, name });
		deps.log(`${next} name: ${name}`);
	}

	function stopTimer() {
		cancelTimer?.();
		cancelTimer = undefined;
	}

	async function complete(ctx: ExtensionContext, system: string, user: string): Promise<Completion> {
		const model = ctx.modelRegistry.find(PROVIDER, MODEL);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: `${PROVIDER}/${MODEL} is not available in Pi` };
		try {
			const reply = await ctx.modelRegistry
				.streamSimple(
					model,
					{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
					{ maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
				)
				.result();
			if (reply.stopReason === "error" || reply.stopReason === "aborted") return { ok: false, reason: reply.errorMessage || reply.stopReason };
			return { ok: true, text: reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") };
		} catch (error) {
			return { ok: false, reason: (error as Error).message };
		}
	}

	// The names other live intercom sessions go by; none when intercom isn't loaded or connected.
	async function takenNames(): Promise<string[]> {
		if (!intercom) return [];
		let timer: NodeJS.Timeout | undefined;
		try {
			const sessions = await Promise.race([
				intercom.listSessions(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("timed out")), LIST_TIMEOUT_MS);
					timer.unref();
				}),
			]);
			const self = process.env.PI_INTERCOM_SESSION_ID;
			return sessions.flatMap((s) => (s.name && !s.runtimeFallbackAlias && s.pid !== process.pid && s.id !== self ? [s.name] : []));
		} catch (error) {
			deps.log(`intercom sessions unavailable: ${(error as Error).message}`);
			return [];
		} finally {
			clearTimeout(timer);
		}
	}

	async function generate(ctx: ExtensionContext, entries: EntryLike[]): Promise<{ name: string } | { problem: string }> {
		const conversation = condense(entries, NAMING_CHARS);
		if (!conversation) return { problem: "no conversation context yet" };
		const result = await complete(ctx, RENAME_SYSTEM, renameUser(conversation));
		if (!result.ok) return { problem: result.reason };
		const reply = parseReply(result.text);
		const name = reply?.action === "rename" ? toAddress(reply.name) : "";
		return name ? { name } : { problem: "the model gave no usable name" };
	}

	function mark(entries: EntryLike[], keeps: number) {
		checkpoint = { ...progress(entries), at: deps.now(), keeps };
	}

	async function nameFirst(ctx: ExtensionContext) {
		const at = epoch;
		const entries = branch(ctx);
		const generated = await generate(ctx, entries);
		if ("problem" in generated) return deps.log(`first name skipped: ${generated.problem}`);
		const name = uniqueName(generated.name, await takenNames());
		if (at !== epoch || mode !== "auto" || pi.getSessionName()) return;
		apply(name, "auto");
		mark(entries, 0);
		notify(ctx, `Session named: ${name}`);
	}

	async function recheck(ctx: ExtensionContext) {
		const current = pi.getSessionName();
		if (!current) return nameFirst(ctx);
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const entries = branch(ctx);
		const now = progress(entries);
		const verdict = shouldCheck(checkpoint, now, deps.now(), deps.policy);
		if (verdict === "rebase") return void (checkpoint = { ...now, at: deps.now(), keeps: checkpoint.keeps });
		if (verdict === "wait") return;
		if (recentExchange(entries, deps.now(), deps.policy.exchangeQuietMs)) return deps.log("re-check deferred: recent intercom exchange");
		const at = epoch;
		const leaf = ctx.sessionManager.getLeafId();
		const result = await complete(ctx, CHECK_SYSTEM, checkUser(current, condense(entries, CHECK_CHARS)));
		if (at !== epoch || mode !== "auto" || pi.getSessionName() !== current) return;
		if (!result.ok) {
			// Wait a full interval before trying again rather than retrying after every run.
			checkpoint = { ...checkpoint, at: deps.now() };
			return deps.log(`re-check failed: ${result.reason}`);
		}
		const decision = decide(current, parseReply(result.text));
		deps.log(`re-check of ${current}: ${decision.kind === "keep" ? "keep" : `rename to ${decision.name}`}`);
		if (decision.kind === "keep") return mark(entries, checkpoint.keeps + 1);
		// The person started something new while the model answered: judge again after that run.
		if (ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle()) return;
		const name = uniqueName(decision.name, await takenNames());
		if (at !== epoch || mode !== "auto" || pi.getSessionName() !== current) return;
		apply(name, "auto");
		mark(entries, 0);
		notify(ctx, `Session renamed to: ${name} (was ${current})`);
	}

	async function run(work: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await work();
		} catch (error) {
			// A context from a replaced session throws; its naming is over.
			deps.log(`naming failed: ${(error as Error).message}`);
		} finally {
			busy = false;
		}
	}

	function registerWithIntercom() {
		if (intercom) return;
		try {
			pi.events.emit(INTERCOM_REGISTER, {
				namespace: INTERCOM_NAMESPACE,
				ownerEligible: false,
				onEvent() {},
				onReady(channel: { listSessions(): Promise<LiveSession[]> }) {
					intercom = channel;
				},
			});
		} catch (error) {
			deps.log(`intercom registration failed: ${(error as Error).message}`);
		}
	}

	// Intercom may load before or after this extension: register now, and again when it says it's ready.
	registerWithIntercom();
	pi.events.on(INTERCOM_READY, registerWithIntercom);

	pi.registerCommand("rename", {
		description: "Rename the current conversation",
		handler: async (args, ctx) => {
			const typed = args.trim();
			epoch++;
			if (typed) {
				const name = toAddress(typed);
				if (!name) return notify(ctx, "That name has no letters or digits. Usage: /rename <name>", "warning");
				const unique = uniqueName(name, await takenNames());
				apply(unique, "manual");
				const held = nameKey(unique) !== nameKey(name) ? ` ("${name}" is held by another live session on this machine)` : "";
				return notify(ctx, `Session renamed to: ${unique}${held}`);
			}
			const at = epoch;
			const entries = branch(ctx);
			const generated = await generate(ctx, entries);
			if ("problem" in generated) return notify(ctx, `Could not generate a name: ${generated.problem}. Usage: /rename <name>`, "warning");
			const name = uniqueName(generated.name, await takenNames());
			if (at !== epoch) return;
			// A generated name puts the session back under automatic naming.
			apply(name, "auto");
			mark(entries, 0);
			notify(ctx, `Session renamed to: ${name}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		epoch++;
		stopTimer();
		ours.length = 0;
		mode = restoreMode(ctx.sessionManager.getEntries() as unknown as EntryLike[], pi.getSessionName());
		// A resumed session is judged on what happens from now on.
		mark(branch(ctx), 0);
	});

	pi.on("session_info_changed", async (event) => {
		const i = event.name === undefined ? -1 : ours.indexOf(event.name);
		if (i >= 0) {
			ours.splice(0, i + 1);
			return;
		}
		// Pi's /name, intercom's /alias or another extension: a name given by hand stays.
		epoch++;
		stopTimer();
		mode = event.name ? "manual" : "auto";
		pi.appendEntry<ModeEntry>(ENTRY_TYPE, event.name ? { mode, name: event.name } : { mode });
		deps.log(`name set outside session-name: ${event.name ?? "(cleared)"}`);
	});

	pi.on("input", async () => stopTimer());
	pi.on("agent_start", async () => stopTimer());

	pi.on("agent_settled", async (event, ctx) => {
		stopTimer();
		// Print and JSON runs end with their prompt; only sessions someone works in get names.
		if (event.aborted || !ctx.hasUI || mode !== "auto" || ctx.hasPendingMessages()) return;
		if (!pi.getSessionName()) return run(() => nameFirst(ctx));
		cancelTimer = deps.schedule(() => {
			cancelTimer = undefined;
			void run(() => recheck(ctx));
		}, deps.policy.debounceMs);
	});

	pi.on("session_shutdown", async () => {
		epoch++;
		stopTimer();
	});
}

export default function (pi: ExtensionAPI) {
	sessionName(pi, realDeps());
}
