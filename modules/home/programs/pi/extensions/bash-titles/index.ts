// Bash commands and codemode scripts named in plain words: a long command's collapsed row reads
// `Bash(Lists the largest session files)` instead of the command, a script's
// `Codemode(Counts lines of every text file)`, and the command or script shows when the row
// opens (syntax-highlighting draws it). As pi-harness's pi-thinking-summary, with token cost
// kept low: only commands too long or tangled to read at a glance and scripts making several
// tool calls, Claude Haiku through the subscription, the command or script alone sent (no
// conversation), one request at a time, and every title kept on disk by command or script, so
// none is asked for twice, across sessions too.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { request, RunningScripts, SCRIPT_SYSTEM, scriptKey, scriptRequest, SYSTEM, TitleCache, titleOf, wantsScriptTitle, wantsTitle } from "./titles.ts";

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-5-5";
// Far above a title's 150 characters (about 40 tokens), so the reply is never cut short.
const MAX_TOKENS = 400;
const TIMEOUT_MS = 20_000;
// After a failure, no request for this long (the provider down, the quota out).
const PAUSE_MS = 60_000;

// What syntax-highlighting reads: the title of a command or a codemode script, and who to tell
// when one arrives.
export interface BashTitles {
	get(command: string): string | undefined;
	script(code: string): string | undefined;
	listeners: Set<() => void>;
}
const KEY = Symbol.for("pi-extension-bash-titles");
const shared = globalThis as unknown as { [KEY]?: BashTitles };

// BASH_TITLES_LOG=<file>: what the extension did, for checking it.
const log = (line: string) => {
	const to = process.env.BASH_TITLES_LOG;
	if (to) try { writeFileSync(to, `${new Date().toISOString()} ${line}\n`, { flag: "a" }); } catch {}
};

export default function (pi: ExtensionAPI) {
	const file = path.join(getAgentDir(), "bash-titles.json");
	let cache = new TitleCache();
	try {
		cache = new TitleCache(JSON.parse(readFileSync(file, "utf8")));
	} catch {}
	const registry: BashTitles = (shared[KEY] ??= { get: () => undefined, script: () => undefined, listeners: new Set() });
	registry.get = (command) => {
		const title = cache.get(command);
		// A title cut by the old limit is asked for again as its row shows: once per command and
		// process (`asked`), and only for rows drawn again.
		if (!title && cache.stale(command)) enqueue({ key: command, text: command, script: false });
		return title;
	};
	registry.script = (code) => cache.get(scriptKey(code));

	// `key` is what the title is cached under: the command, or the script's scriptKey.
	type Item = { key: string; text: string; script: boolean };
	const queue: Item[] = [];
	const asked = new Set<string>();
	const running = new RunningScripts();
	let busy = false;
	let pausedUntil = 0;
	let ctx: ExtensionContext | undefined;

	const save = () => {
		try {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(`${file}.${process.pid}`, JSON.stringify(cache));
			renameSync(`${file}.${process.pid}`, file);
		} catch {}
	};

	async function ask({ text, script }: Item): Promise<string | null> {
		const model = ctx?.modelRegistry.find(PROVIDER, MODEL);
		if (!ctx || !model || !ctx.modelRegistry.hasConfiguredAuth(model)) { log(`no model: ${PROVIDER}/${MODEL}`); return null; }
		const reply = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: script ? SCRIPT_SYSTEM : SYSTEM,
					messages: [{ role: "user", content: [{ type: "text", text: script ? scriptRequest(text) : request(text) }], timestamp: Date.now() }],
				},
				{ maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
			)
			.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
		if (reply.stopReason === "length") log(`reply cut at ${MAX_TOKENS} tokens`);
		return titleOf(reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
	}

	function enqueue(item: Item) {
		if (asked.has(item.key)) return;
		if (asked.size > 2000) asked.clear();
		asked.add(item.key);
		queue.push(item);
		void drain();
	}

	async function drain() {
		if (busy) return;
		busy = true;
		try {
			// Rows of a resumed session can be drawn before the session starts: they wait for it.
			while (ctx && queue.length && Date.now() >= pausedUntil) {
				const item = queue.shift()!;
				if (cache.get(item.key)) continue;
				try {
					// A reply that isn't a title is dropped, not asked again: a token spent once.
					const title = await ask(item);
					log(`title ${JSON.stringify(title)} for ${JSON.stringify(item.text.slice(0, 80))}`);
					if (!title) continue;
					cache.set(item.key, title);
					save();
					for (const tell of registry.listeners) tell();
				} catch (error) {
					log(`failed: ${(error as Error).message}`);
					// Asked again after the pause, by the next call that drains the queue.
					queue.unshift(item);
					pausedUntil = Date.now() + PAUSE_MS;
				}
			}
		} finally {
			busy = false;
		}
	}

	// A script that called no tool would stay "Codemode(…)": syntax-highlighting doesn't show a
	// line that only sets a variable.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "codemode") return;
		const unnamed = running.finished(event.toolCallId);
		if (unnamed && !cache.get(scriptKey(unnamed))) enqueue({ key: scriptKey(unnamed), text: unnamed, script: true });
	});

	pi.on("session_start", async (_event, current) => {
		ctx = current;
		void drain();
	});

	// Asked as the call starts, so the title is there by the time its output is read.
	pi.on("tool_call", async (event, current) => {
		ctx = current;
		log(`tool_call ${event.toolName}`);
		if (event.toolName === "codemode") {
			const code = (event.input as { code?: unknown }).code;
			if (typeof code !== "string") return;
			running.started(event.toolCallId, code);
			if (!wantsScriptTitle(code) || cache.get(scriptKey(code))) return;
			enqueue({ key: scriptKey(code), text: code, script: true });
			return;
		}
		// A script that looked like one call (a loop) and makes several is named too.
		const looped = running.called(event.toolCallId);
		if (looped && !cache.get(scriptKey(looped))) enqueue({ key: scriptKey(looped), text: looped, script: true });
		// A codemode script's bash calls too: they are listed under its row by their titles.
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !wantsTitle(command) || cache.get(command)) return;
		enqueue({ key: command, text: command, script: false });
	});
}
