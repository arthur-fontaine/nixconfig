// Bash commands named in plain words: a long command's collapsed row reads
// `Bash(Lists the largest session files)` instead of the command, which shows when the row
// opens (syntax-highlighting draws it). As pi-harness's pi-thinking-summary, with token cost
// kept low: only commands too long or tangled to read at a glance, Claude Haiku through the
// subscription, the command alone sent (no conversation), one request at a time, and every
// title kept on disk by command, so none is asked for twice, across sessions too.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { request, SYSTEM, TitleCache, titleOf, wantsTitle } from "./titles.ts";

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-5-5";
// Far above a title's 150 characters (about 40 tokens), so the reply is never cut short.
const MAX_TOKENS = 400;
const TIMEOUT_MS = 20_000;
// After a failure, no request for this long (the provider down, the quota out).
const PAUSE_MS = 60_000;

// What syntax-highlighting reads: the title of a command, and who to tell when one arrives.
export interface BashTitles {
	get(command: string): string | undefined;
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
	const registry: BashTitles = (shared[KEY] ??= { get: () => undefined, listeners: new Set() });
	registry.get = (command) => {
		const title = cache.get(command);
		// A title cut by the old limit is asked for again as its row shows: once per command and
		// process (`asked`), and only for rows drawn again.
		if (!title && cache.stale(command)) enqueue(command);
		return title;
	};

	const queue: string[] = [];
	const asked = new Set<string>();
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

	async function ask(command: string): Promise<string | null> {
		const model = ctx?.modelRegistry.find(PROVIDER, MODEL);
		if (!ctx || !model || !ctx.modelRegistry.hasConfiguredAuth(model)) { log(`no model: ${PROVIDER}/${MODEL}`); return null; }
		const reply = await ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: request(command) }], timestamp: Date.now() }] },
				{ maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
			)
			.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
		if (reply.stopReason === "length") log(`reply cut at ${MAX_TOKENS} tokens`);
		return titleOf(reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
	}

	function enqueue(command: string) {
		if (asked.has(command)) return;
		if (asked.size > 2000) asked.clear();
		asked.add(command);
		queue.push(command);
		void drain();
	}

	async function drain() {
		if (busy) return;
		busy = true;
		try {
			// Rows of a resumed session can be drawn before the session starts: they wait for it.
			while (ctx && queue.length && Date.now() >= pausedUntil) {
				const command = queue.shift()!;
				if (cache.get(command)) continue;
				try {
					// A reply that isn't a title is dropped, not asked again: a token spent once.
					const title = await ask(command);
					log(`title ${JSON.stringify(title)} for ${JSON.stringify(command.slice(0, 80))}`);
					if (!title) continue;
					cache.set(command, title);
					save();
					for (const tell of registry.listeners) tell();
				} catch (error) {
					log(`failed: ${(error as Error).message}`);
					// Asked again after the pause, by the next call that drains the queue.
					queue.unshift(command);
					pausedUntil = Date.now() + PAUSE_MS;
				}
			}
		} finally {
			busy = false;
		}
	}

	pi.on("session_start", async (_event, current) => {
		ctx = current;
		void drain();
	});

	// Asked as the call starts, so the title is there by the time its output is read.
	pi.on("tool_call", async (event, current) => {
		ctx = current;
		log(`tool_call ${event.toolName}`);
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !wantsTitle(command) || cache.get(command)) return;
		enqueue(command);
	});
}
