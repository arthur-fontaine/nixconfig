// Auto mode for Pi: Claude Code's `permissions.defaultMode: "auto"`. Plainly safe tool calls
// run; every other one is judged by a classifier model that reads the conversation, and
// the risky ones are blocked with the reason. /auto-mode turns it off and on.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	loadProjectContextFiles,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { classify, type Complete, type Stop, type Verdict } from "./classifier.ts";
import { allowed, blocked, type Denials, fresh, limitPrompt, overLimit } from "./denials.ts";
import { fastPath } from "./fastpath.ts";
import * as msg from "./messages.ts";
import { destroysWork, parsePorcelain } from "./meta.ts";
import { buildSystemPrompt, claudeMdMessage, loadTemplates, type Rules, thresholdsFor, userIdentity } from "./prompt.ts";
import { callLine, claudeName, defang, type Entry, indent, metaLine, project, transcriptLines } from "./transcript.ts";

const STATUS_KEY = "auto-mode";
// Only the Claude subscription: the classifier never moves to another provider's billing.
const PROVIDER = "claude-code";
// tengu_auto_mode_config.modelByMainModel sends every current main model to Sonnet 5.
const DEFAULT_MODEL = "claude-sonnet-5";

const run = promisify(execFile);

// Set PI_AUTO_MODE_DEBUG to a file path to log each verdict there, as Claude Code's --debug does.
function debug(record: Record<string, unknown>) {
	const file = process.env.PI_AUTO_MODE_DEBUG;
	if (file) appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

// Like Claude Code, rules come from the person's own settings only, never a project's.
function userRules(): Rules {
	try {
		const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
		const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);
		const a = settings?.autoMode ?? {};
		return { allow: list(a.allow), soft_deny: list(a.soft_deny), hard_deny: list(a.hard_deny), environment: list(a.environment) };
	} catch {
		return {};
	}
}

function claudeMd(cwd: string): string | undefined {
	try {
		const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
		const text = files.map((f) => `Contents of ${f.path}:\n\n${f.content}`).join("\n\n");
		return text.trim() ? claudeMdMessage(defang(indent(text), ["user_claude_md"])) : undefined;
	} catch {
		return undefined;
	}
}

async function gitStatusLine(command: string, cwd: string): Promise<string> {
	if (!destroysWork(command)) return "";
	try {
		const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, timeout: 5000 });
		return metaLine({ gitStatus: parsePorcelain(stdout) });
	} catch {
		return "";
	}
}

function summary(tool: string, input: Record<string, unknown>): string {
	const projected = project(tool, input);
	const text = typeof projected === "string" ? projected : JSON.stringify(projected);
	return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export default function (pi: ExtensionAPI) {
	loadTemplates(__dirname);
	let enabled = true;
	let denials: Denials = fresh();
	let checking = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let system: { key: string; text: string } | undefined;

	function render(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const text = !enabled ? undefined : checking > 0 ? "auto mode: checking" : "auto mode";
		const styled = text && ctx.mode === "tui" ? ctx.ui.theme.fg("dim", "│ ") + ctx.ui.theme.fg(checking > 0 ? "dim" : "accent", text) : text;
		ctx.ui.setStatus(STATUS_KEY, styled);
	}

	function systemPrompt(severity: boolean): string {
		const rules = userRules();
		const identity = userIdentity(process.env);
		const key = JSON.stringify([rules, identity, severity]);
		if (system?.key !== key) system = { key, text: buildSystemPrompt({ rules, identity, severity }) };
		return system.text;
	}

	// Claude Code turns API thinking off for the classifier. Models that refuse that get
	// the low-effort thinking pi-claude-code can send instead, with the 2048 extra output
	// tokens Claude Code gives such models; learned from the first refusal, then kept.
	const thinkingRequired = new Set<string>();

	function complete(ctx: ExtensionContext, model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>): Complete {
		return async (r) => {
			const messages = [...r.leading, r.transcript].map((text) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }));
			const send = () => {
				const thinking = thinkingRequired.has(model.id);
				const options = { maxTokens: r.maxTokens + (thinking ? 2048 : 0), signal: r.signal, ...(thinking && { reasoning: "minimal" as const }) };
				return ctx.modelRegistry.streamSimple(model, { systemPrompt: r.system, messages }, options).result();
			};
			let reply = await send();
			if (reply.stopReason === "error" && !thinkingRequired.has(model.id) && /turn thinking off/i.test(reply.errorMessage ?? "")) {
				thinkingRequired.add(model.id);
				reply = await send();
			}
			const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
			const known: Stop[] = ["stop", "length", "toolUse", "aborted"];
			const stop = known.find((s) => s === reply.stopReason) ?? "error";
			return { text, stop, ...(reply.errorMessage !== undefined && { error: reply.errorMessage }) };
		};
	}

	async function judge(
		event: { toolCallId: string; parentToolCallId?: string; toolName: string },
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<{ verdict: Verdict; model: string }> {
		const id = process.env.CLAUDE_CODE_AUTO_MODE_MODEL || DEFAULT_MODEL;
		const model = ctx.modelRegistry.find(PROVIDER, id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return { verdict: { kind: "unavailable", reason: `No ${PROVIDER}/${id} model with credentials in Pi`, status: "" }, model: id };
		}
		const action = callLine(event.toolName, input);
		if (!action) return { verdict: { kind: "allow", reason: "Tool declares no classifier-relevant input", stage: "fast" }, model: id };
		const entries = ctx.sessionManager.buildContextEntries() as unknown as Entry[];
		const history = transcriptLines(entries, { ...event, input }).join("");
		const meta = event.toolName === "bash" && typeof input.command === "string" ? await gitStatusLine(input.command, ctx.cwd) : "";
		const transcript = `<transcript>\n${history}${meta}${action}</transcript>\n`;
		const thresholds = thresholdsFor(model.id);
		const prompt = systemPrompt(thresholds !== null);
		const leading = [claudeMd(ctx.cwd)].filter((m): m is string => m !== undefined);
		const estimate = Math.round((prompt.length + leading.join("").length + transcript.length) / 4);
		const verdict = await classify(complete(ctx, model), {
			system: prompt,
			leading,
			transcript,
			thresholds,
			tokens: Math.max(estimate, ctx.getContextUsage()?.tokens ?? 0),
			signal: ctx.signal ?? new AbortController().signal,
		});
		return { verdict, model: model.id };
	}

	async function askPerson(ctx: ExtensionContext, title: string, text: string, tool: string, input: Record<string, unknown>) {
		const approved = await ctx.ui.confirm(title, `${text}\n\n${claudeName(tool)}: ${summary(tool, input)}\n\nAllow it?`);
		if (!approved) return { block: true, reason: msg.REJECTED };
		denials = allowed(denials);
		return undefined;
	}

	async function review(
		event: { toolCallId: string; parentToolCallId?: string; toolName: string },
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		checking++;
		render(ctx);
		let outcome: { verdict: Verdict; model: string };
		const started = Date.now();
		try {
			outcome = await judge(event, input, ctx);
			debug({ tool: event.toolName, toolCallId: event.toolCallId, ms: Date.now() - started, model: outcome.model, verdict: outcome.verdict });
		} finally {
			checking--;
			render(ctx);
		}
		const { verdict, model } = outcome;
		const tool = claudeName(event.toolName);
		const notify = (text: string) => ctx.hasUI && ctx.ui.notify(text, "warning");
		switch (verdict.kind) {
			case "allow":
				denials = allowed(denials);
				return undefined;
			case "block":
			case "parse_failure": {
				denials = blocked(denials);
				if (overLimit(denials)) {
					const { text, next } = limitPrompt(denials, verdict.reason);
					denials = next;
					if (!ctx.hasUI) return { block: true, reason: msg.LIMIT_HEADLESS, terminate: true };
					return askPerson(ctx, "Auto mode", text, event.toolName, input);
				}
				notify(`Auto mode blocked ${tool}: ${verdict.reason}`);
				return {
					block: true,
					reason: verdict.kind === "block" ? msg.blockedMessage(verdict.reason) : msg.noVerdictMessage(verdict.reason, false),
				};
			}
			case "refusal":
				notify(`Auto mode could not evaluate ${tool}`);
				return { block: true, reason: msg.noVerdictMessage(verdict.reason, true) };
			case "too_long":
				if (!ctx.hasUI) return { block: true, reason: msg.TOO_LONG_HEADLESS, terminate: true };
				return askPerson(ctx, "Auto mode", msg.TOO_LONG_PROMPT, event.toolName, input);
			case "unavailable":
			case "aborted":
				notify(`Auto mode could not check ${tool}: ${verdict.reason}`);
				return { block: true, reason: msg.unavailableMessage(model, tool, verdict.kind === "unavailable" ? verdict.status : "") };
		}
	}

	pi.registerCommand("auto-mode", {
		description: "Turn auto mode on or off (on, off, or no argument to toggle)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			denials = fresh();
			render(ctx);
			ctx.ui.notify(enabled ? "Auto mode on: risky tool calls are checked by the classifier" : "Auto mode off: tool calls run without checks", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		denials = fresh();
		checking = 0;
		render(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		const input = event.input as Record<string, unknown>;
		const fast = fastPath(event.toolName, input, ctx.cwd);
		if (fast) debug({ tool: event.toolName, toolCallId: event.toolCallId, fastPath: fast.kind === "allow" ? fast.why : fast.kind });
		if (fast?.kind === "interactive") return undefined;
		if (fast) {
			denials = allowed(denials);
			return undefined;
		}
		// One check at a time, as Claude Code queues them: the denial counts stay in order.
		const next = queue.then(() => review(event, input, ctx));
		queue = next.catch(() => undefined);
		return next;
	});
}
