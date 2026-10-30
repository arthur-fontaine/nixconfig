// A stand-in Pi: a session tree, the events this extension listens to, the
// command context (navigateTree, compact, custom UI) and the editor.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Deps, rewind } from "../extension.ts";
import type { Entry, Message } from "../plan.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scratch(prefix: string) {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } }).trim();

// A working-tree snapshot the way bash-changes takes one, through a temp index.
export function snapshot(root: string): string {
	const index = join(tmpdir(), `rewind-test-index-${randomUUID()}`);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	execFileSync("git", ["add", "-A"], { cwd: root, env });
	const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
	execFileSync("rm", ["-f", index]);
	return tree;
}

const KEYS: Record<string, string> = { "\x1b[A": "up", "\x1b[B": "down", "\r": "enter", "\x1b": "escape", "\x7f": "backspace" };

export const deps = (agentDir: string): Deps => ({
	agentDir: () => agentDir,
	newEditor: () => {
		throw new Error("no editor in tests");
	},
	serialize: (messages) => JSON.stringify(messages),
	truncate: (text, width) => (text.length > width ? text.slice(0, width) : text),
	wrap: (text, width) => text.match(new RegExp(`.{1,${width}}`, "gu")) ?? [""],
	parseKey: (data) => KEYS[data] ?? (data.length === 1 && data >= " " ? data : undefined),
	decodePrintable: () => undefined,
});

type Handler = (event: unknown, ctx: unknown) => unknown;

export class Session {
	entries: Entry[] = [];
	leaf: string | null = null;
	readonly file: string;
	readonly id = randomUUID();
	readonly parentSession?: string;
	#count = 0;

	constructor(file: string, parentSession?: string) {
		this.file = file;
		this.parentSession = parentSession;
	}

	append(entry: Omit<Entry, "id" | "parentId"> & { id?: string }): Entry {
		const full = { ...entry, id: entry.id ?? `e${++this.#count}`, parentId: this.leaf } as Entry;
		this.entries.push(full);
		this.leaf = full.id;
		return full;
	}

	getEntry = (id: string) => this.entries.find((entry) => entry.id === id);
	getBranch = (from: string | null = this.leaf) => {
		const out: Entry[] = [];
		let at = from;
		while (at) {
			const entry = this.getEntry(at)!;
			out.unshift(entry);
			at = entry.parentId ?? null;
		}
		return out;
	};

	manager() {
		return {
			getBranch: (id?: string) => this.getBranch(id ?? this.leaf),
			getEntries: () => this.entries,
			getEntry: this.getEntry,
			getLeafId: () => this.leaf,
			getHeader: () => ({ type: "session", id: this.id, timestamp: "", cwd: "", ...(this.parentSession ? { parentSession: this.parentSession } : {}) }),
			getSessionFile: () => this.file,
			getSessionId: () => this.id,
			buildSessionProjection: () => ({
				entries: this.getBranch().map((entry) => ({ sourceEntry: entry, messages: entry.message ? [entry.message] : [] })),
			}),
		};
	}
}

export type Screen = { render(width: number): string[]; handleInput(data: string): void };

export class Harness {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	notes: { text: string; type?: string }[] = [];
	editorText = "";
	screen: Screen | undefined;
	summaryReply = "<analysis>a</analysis><summary>The summary.</summary>";
	modelPrompts: string[] = [];
	compactions: { summary: string; firstKeptEntryId: string }[] = [];
	readonly session: Session;
	readonly cwd: string;
	readonly hasUI: boolean;

	constructor(session: Session, cwd: string, agentDir: string, hasUI = true) {
		this.session = session;
		this.cwd = cwd;
		this.hasUI = hasUI;
		const pi = {
			on: (event: string, handler: Handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]),
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => this.commands.set(name, options.handler),
			sendUserMessage: (text: string) => void this.run(text.slice(1)),
		} as unknown as ExtensionAPI;
		rewind(pi, deps(agentDir));
	}

	async emit(event: string, payload: unknown = {}) {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) result = (await handler(payload, this.ctx())) ?? result;
		return result;
	}

	ctx() {
		const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
		return {
			mode: this.hasUI ? "tui" : "print",
			hasUI: this.hasUI,
			cwd: this.cwd,
			model: { id: "test-model" },
			sessionManager: this.session.manager(),
			isIdle: () => true,
			hasPendingMessages: () => false,
			abort() {},
			waitForIdle: async () => {},
			modelRegistry: {
				streamSimple: (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => {
					this.modelPrompts.push(context.messages[0]!.content[0]!.text);
					return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: this.summaryReply }], usage: {} }) };
				},
			},
			ui: {
				theme,
				notify: (text: string, type?: string) => this.notes.push({ text, type }),
				getEditorText: () => this.editorText,
				setEditorText: (text: string) => {
					this.editorText = text;
				},
				getEditorComponent: () => undefined,
				setEditorComponent() {},
				custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Screen) =>
					new Promise((resolve) => {
						const tui = { terminal: { rows: 40 }, requestRender() {} };
						this.screen = factory(tui, theme, {}, (value) => {
							this.screen = undefined;
							resolve(value);
						});
					}),
			},
			navigateTree: async (targetId: string, options: { summarize?: boolean } = {}) => {
				const target = this.session.getEntry(targetId)!;
				const oldLeaf = this.session.leaf;
				const tree = (await this.emit("session_before_tree", { preparation: { targetId, oldLeafId: oldLeaf, userWantsSummary: Boolean(options.summarize) } })) as
					| { summary?: { summary: string } }
					| undefined;
				const isUser = target.type === "message" && target.message?.role === "user";
				this.session.leaf = isUser ? (target.parentId ?? null) : targetId;
				if (options.summarize && tree?.summary) this.session.append({ type: "branch_summary", data: tree.summary.summary });
				if (isUser && !this.editorText.trim()) this.editorText = (target.message!.content as { text: string }[])[0]!.text;
				await this.emit("session_tree", {});
				return { cancelled: false };
			},
			compact: (options: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
				void (async () => {
					try {
						const result = (await this.emit("session_before_compact", {
							customInstructions: options.customInstructions,
							preparation: { tokensBefore: 100 },
							signal: new AbortController().signal,
						})) as { compaction: { summary: string; firstKeptEntryId: string } };
						this.compactions.push(result.compaction);
						options.onComplete?.(result.compaction);
					} catch (error) {
						options.onError?.(error as Error);
					}
				})();
			},
		};
	}

	// Runs a command and returns once its screen (if any) is up.
	run(name: string): Promise<void> {
		const done = this.commands.get(name)!("", this.ctx());
		this.pending = done;
		return done;
	}
	pending: Promise<void> | undefined;

	async open(name: string) {
		void this.run(name);
		for (let i = 0; i < 500 && !this.screen; i++) await sleep(10);
		assert(this.screen, `/${name} shows no screen`);
		await (this.screen as { loaded?: Promise<void> }).loaded;
		await this.settle();
	}

	async press(...keys: string[]) {
		for (const key of keys) {
			this.screen!.handleInput(key);
			await this.settle();
		}
	}

	// Until the screen stays the same for a while: plans and row stats read git and files.
	async settle() {
		let last = this.text();
		for (let stable = 0, i = 0; stable < 15 && i < 500; i++) {
			await sleep(10);
			const now = this.text();
			stable = now === last ? stable + 1 : 0;
			last = now;
		}
	}

	text() {
		return this.screen?.render(160).join("\n") ?? "";
	}

	// The agent's side of a prompt.
	prompt(text: string) {
		return this.session.append({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() - 20_000 } });
	}

	reply(content: Message["content"]) {
		return this.session.append({ type: "message", message: { role: "assistant", content } });
	}

	result(toolCallId: string, details?: unknown, isError = false) {
		return this.session.append({ type: "message", message: { role: "toolResult", toolCallId, content: [], details, isError } });
	}
}

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

export async function cleanup(paths: string[]) {
	for (const path of paths) await rm(path, { recursive: true, force: true });
}
