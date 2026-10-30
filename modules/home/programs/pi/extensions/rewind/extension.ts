// The Pi wiring: backups around edit and write, /rewind and /restore, Esc+Esc,
// and the summaries. Pi's runtime pieces come in through `deps` (index.ts).
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { hookEditor } from "./escape.ts";
import { isRepository } from "./git.ts";
import {
	filesPhrase,
	type Prompt,
	prompts,
	restoreOptions,
	restoreTargets,
	type Rewound,
	rewindOptions,
	rewindTargets,
	rewoundPrompts,
	timeAgo,
	turnPairs,
} from "./listing.ts";
import { bashChanges, type Change, changes, EDIT_TOOLS, type Entry, fileChangesOf, resolvePath, type Sources, writtenByRecord } from "./plan.ts";
import { apply, type Plan, plan, Reader, readState, sameState, turnStats } from "./restore.ts";
import { type FileRecord, prune, type Record, Store } from "./store.ts";
import {
	CODE_UNCHANGED,
	description,
	type Direction,
	ERRORS,
	type Option,
	RESTORE,
	REWIND,
	restoreDescription,
	SUMMARIZED,
	SUMMARY_SYSTEM,
	summaryPrompt,
	summaryText,
	unrestorable,
	WARNING_IN_REPO,
	WARNING_NO_REPO,
} from "./text.ts";
import { type Confirm, counts, Dialog, type Outcome, type Paint, type Row, type Screens, type Ui } from "./view.ts";

export type Deps = {
	agentDir(): string;
	newEditor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager): EditorComponent;
	// Pi's serializeConversation(convertToLlm(messages)).
	serialize(messages: unknown[]): string;
	truncate(text: string, width: number): string;
	wrap(text: string, width: number): string[];
	parseKey(data: string): string | undefined;
	decodePrintable(data: string): string | undefined;
};

// Subagents run as sessions in this same process, with their own instance of
// this extension; they file their changes into their parent's store.
type Parent = { store: Store; prompt(): string | undefined; runningCall(): string | undefined };
const PARENTS_KEY = Symbol.for("pi-rewind.parents");
const parents: Map<string, Parent> = ((globalThis as { [PARENTS_KEY]?: Map<string, Parent> })[PARENTS_KEY] ??= new Map());

const HOOKED_FACTORY = Symbol.for("pi-rewind.factory");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export function isSubagentSession(ctx: ExtensionContext): boolean {
	return !ctx.hasUI && (Boolean(ctx.sessionManager.getHeader()?.parentSession) || !ctx.sessionManager.getSessionFile());
}

// The user message the agent is answering: the last one on the branch.
export function currentPrompt(branch: readonly Entry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) if (branch[i]!.type === "message" && branch[i]!.message?.role === "user") return branch[i]!.id;
	return undefined;
}

type Done =
	| { action: "none" }
	| { action: "conversation"; prompt: Prompt; files: FileRecord[] }
	| { action: "summarize"; prompt: Prompt; summary: string; usage?: unknown }
	| { action: "compact"; prompt: Prompt; context?: string }
	| { action: "restore"; prompt: Rewound; files: FileRecord[] };

export function rewind(pi: ExtensionAPI, deps: Deps) {
	let store: Store | undefined;
	let subagent = false;
	let parent: Parent | undefined;
	let latest: ExtensionContext | undefined;
	let sessionFile: string | undefined;
	let dialogOpen = false;
	const running = new Map<string, string>();
	let pendingTree: { target: string; summary: string; usage?: unknown } | undefined;
	let pendingCompact: { marker: string; prompt: Prompt; context?: string } | undefined;

	const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown as Entry[];

	pi.on("session_start", async (_event, ctx) => {
		latest = ctx;
		subagent = isSubagentSession(ctx);
		if (subagent) {
			const file = ctx.sessionManager.getHeader()?.parentSession;
			parent = file ? parents.get(file) : undefined;
			return;
		}
		sessionFile = ctx.sessionManager.getSessionFile();
		const root = join(deps.agentDir(), "rewind");
		const dir = sessionFile ? join(root, ctx.sessionManager.getSessionId()) : join(tmpdir(), `pi-rewind-${ctx.sessionManager.getSessionId()}`);
		store = new Store(dir, sessionFile);
		void prune(root, dir).catch(() => undefined);
		if (sessionFile) {
			const own = store;
			parents.set(sessionFile, {
				store: own,
				prompt: () => (latest ? currentPrompt(branch(latest)) : undefined),
				// The call a subagent runs under: the parent's running call that isn't a file tool.
				runningCall: () => [...running].find(([, name]) => name !== "bash" && !EDIT_TOOLS.has(name))?.[0],
			});
		}
		if (ctx.mode === "tui") setTimeout(() => installHook(ctx), 0);
	});

	pi.on("session_tree", async (_event, ctx) => {
		latest = ctx;
		// input-autocomplete installs a fresh editor after /tree; hook that one too.
		if (!subagent && ctx.mode === "tui") setTimeout(() => installHook(ctx), 0);
	});

	pi.on("session_shutdown", async () => {
		if (sessionFile && parents.get(sessionFile)?.store === store) parents.delete(sessionFile);
		if (store && !sessionFile) await store.remove().catch(() => undefined);
		store = undefined;
		parent = undefined;
		running.clear();
	});

	pi.on("tool_execution_start", async (event) => {
		running.set(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", async (event) => {
		running.delete(event.toolCallId);
	});

	// Where a call's backups go: this session's store, or the parent's under its prompt and call.
	function target(ctx: ExtensionContext, toolCallId: string): { store: Store; id: string; message: string } | undefined {
		if (subagent) {
			const message = parent?.prompt();
			return parent && message ? { store: parent.store, id: `${parent.runningCall() ?? "subagent"}/sub-${toolCallId}`, message } : undefined;
		}
		const message = currentPrompt(branch(ctx));
		return store && message ? { store, id: toolCallId, message } : undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!EDIT_TOOLS.has(event.toolName)) return;
		const path = (event.input as { path?: unknown }).path;
		const to = target(ctx, event.toolCallId);
		if (!to || typeof path !== "string") return;
		// A failed backup only loses the restore of this file; the call goes on.
		await to.store.backUp(to.id, to.message, resolvePath(path, ctx.cwd)).catch(() => undefined);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!EDIT_TOOLS.has(event.toolName) || event.isError) return;
		const path = (event.input as { path?: unknown }).path;
		const to = target(ctx, event.toolCallId);
		if (!to || typeof path !== "string") return;
		await to.store.backUp(to.id, to.message, resolvePath(path, ctx.cwd), "after").catch(() => undefined);
	});

	// A subagent's bash changes are in its own session: copy them to the parent's store.
	pi.on("message_end", async (event, ctx) => {
		if (!subagent) return;
		const message = event.message as { role?: string; toolCallId?: string; details?: unknown };
		if (message.role !== "toolResult" || !message.toolCallId) return;
		const fileChanges = fileChangesOf((message.details as { fileChanges?: unknown } | undefined)?.fileChanges);
		const to = fileChanges && target(ctx, message.toolCallId);
		if (to && fileChanges) await to.store.addBash(to.id, to.message, fileChanges).catch(() => undefined);
	});

	pi.on("session_before_tree", async (event) => {
		const pending = pendingTree;
		if (!pending || event.preparation.targetId !== pending.target) return;
		pendingTree = undefined;
		return { summary: { summary: pending.summary, ...(pending.usage ? { usage: pending.usage as never } : {}) } };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const pending = pendingCompact;
		if (!pending || event.customInstructions !== pending.marker) return;
		pendingCompact = undefined;
		const messages = projectedBefore(ctx, pending.prompt.id);
		if (messages === undefined) throw new Error(ERRORS.notInContext);
		if (messages.length === 0) throw new Error(ERRORS.nothingBefore);
		const { text, usage } = await summarize(ctx, messages, "up_to", pending.context, event.signal);
		return { compaction: { summary: text, firstKeptEntryId: pending.prompt.id, tokensBefore: event.preparation.tokensBefore, usage: usage as never } };
	});

	function installHook(ctx: ExtensionContext) {
		const factory = ctx.ui.getEditorComponent();
		if ((factory as { [HOOKED_FACTORY]?: true } | undefined)?.[HOOKED_FACTORY]) return;
		const wrapped = ((tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => {
			const editor = factory ? factory(tui, theme, keys) : deps.newEditor(tui, theme, keys);
			hookEditor(editor as unknown as Parameters<typeof hookEditor>[0], {
				ready: () => {
					const now = latest;
					return Boolean(now && !dialogOpen && now.isIdle() && !now.hasPendingMessages() && currentPrompt(branch(now)));
				},
				open: () => pi.sendUserMessage("/rewind", { expandPromptTemplates: true }),
			});
			return editor;
		}) as EditorFactory & { [HOOKED_FACTORY]?: true };
		wrapped[HOOKED_FACTORY] = true;
		ctx.ui.setEditorComponent(wrapped);
	}

	async function sources(ctx: ExtensionContext, s: Store): Promise<Sources> {
		return {
			backups: await s.backups(),
			bash: bashChanges(ctx.sessionManager.getEntries() as unknown as Entry[]),
			records: await s.records(),
		};
	}

	// The model-visible messages before (or from) a prompt; undefined when it is no longer in the context.
	function projected(ctx: ExtensionContext, id: string): { before: unknown[]; from: unknown[] } | undefined {
		const entries = ctx.sessionManager.buildSessionProjection().entries;
		const index = entries.findIndex((entry) => entry.sourceEntry.id === id);
		if (index < 0) return undefined;
		return { before: entries.slice(0, index).flatMap((entry) => entry.messages), from: entries.slice(index).flatMap((entry) => entry.messages) };
	}
	const projectedBefore = (ctx: ExtensionContext, id: string) => projected(ctx, id)?.before;

	async function summarize(ctx: ExtensionContext, messages: unknown[], direction: Direction, context: string | undefined, signal?: AbortSignal) {
		const model = ctx.model;
		if (!model) throw new Error("No model selected.");
		const prompt = `<conversation>\n${deps.serialize(messages)}\n</conversation>\n\n${summaryPrompt(direction, context)}`;
		const reply = await ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ signal },
			)
			.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
		const text = summaryText(reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""));
		if (!text) throw new Error("Failed to generate conversation summary - response did not contain valid text content");
		return { text, usage: reply.usage };
	}

	function paint(theme: Theme): Paint {
		return { fg: (token, text) => theme.fg(token, text), bold: (text) => theme.bold(text), italic: (text) => theme.italic(text) };
	}

	function ui(tui: TUI): Ui {
		return {
			truncate: deps.truncate,
			wrap: deps.wrap,
			key: deps.parseKey,
			// eslint-disable-next-line no-control-regex
			printable: (data) => (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : deps.decodePrintable(data)),
			rows: () => tui.terminal.rows,
			render: () => tui.requestRender(),
		};
	}

	function warnings(planned: Plan, inRepo: boolean): string[] {
		const out: string[] = [];
		const names = (paths: string[]) => filesPhrase(paths);
		if (planned.changes.length) out.push(inRepo ? WARNING_IN_REPO : WARNING_NO_REPO);
		if (planned.missing.length) out.push(unrestorable(names(planned.missing), "missing"));
		if (planned.untracked.length) out.push(unrestorable(names(planned.untracked), "untracked"));
		return out;
	}

	function codeLine(planned: Plan, option: Option): string | undefined {
		if (option === "summarize" || option === "summarize_up_to") return undefined;
		if ((option === "both" || option === "code") && planned.changes.length) {
			const added = planned.changes.reduce((sum, change) => sum + change.added, 0);
			const removed = planned.changes.reduce((sum, change) => sum + change.removed, 0);
			const p = latest!.ui.theme;
			const diff = counts(paint(p), added, removed);
			const dim = (text: string) => p.fg("dim", text);
			return dim("The code will be restored ") + (diff ? `${diff} ` : "") + dim(`in ${filesPhrase(planned.changes.map((change) => change.path))}.`);
		}
		return CODE_UNCHANGED;
	}

	async function restoreCode(planned: Plan, s: Store): Promise<{ files: FileRecord[]; error?: string }> {
		const { records, failed } = await apply(planned.changes, s);
		if (failed.length && !records.length) return { files: records, error: ERRORS.code(`could not write ${filesPhrase(failed)}`) };
		if (failed.length) latest?.ui.notify(ERRORS.skipped(failed.length), "warning");
		return { files: records };
	}

	async function addRecord(s: Store, record: Omit<Record, "id" | "at">) {
		await s.addRecord({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...record });
	}

	async function prepare(ctx: ExtensionCommandContext): Promise<Store | undefined> {
		if (ctx.mode !== "tui" || !store) {
			ctx.ui.notify("Rewind needs Pi's interactive mode.", "warning");
			return undefined;
		}
		// As Claude Code, a running turn stops first.
		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}
		return store;
	}

	async function show<R>(ctx: ExtensionCommandContext, screens: Omit<Screens<R>, "done">): Promise<R | undefined> {
		dialogOpen = true;
		try {
			return await ctx.ui.custom<R | undefined>((tui, theme, _keys, done) => new Dialog<R>({ ...screens, done }, paint(theme), ui(tui)));
		} finally {
			dialogOpen = false;
		}
	}

	pi.registerCommand("rewind", {
		description: "Restore the code and/or conversation to the point before a prompt",
		handler: async (_args, ctx) => {
			const s = await prepare(ctx);
			if (!s) return;
			const path = branch(ctx);
			const list = prompts(path);
			const all = changes(path, ctx.cwd, await sources(ctx, s));
			const reader = new Reader(s);
			const inRepo = await isRepository(ctx.cwd);
			const byId = new Map(list.map((prompt) => [prompt.id, prompt]));
			const plans = new Map<string, Plan>();
			const now = Date.now();
			const result = await show<Done>(ctx, {
				title: REWIND.title,
				subtitle: REWIND.subtitle,
				nothing: REWIND.nothing,
				currentFirst: false,
				rows: list.map((prompt) => ({ id: prompt.id, text: prompt.text, time: prompt.time })),
				stats: async (row) => turnStats(turnPairs(all, byId.get(row.id)!), reader),
				open: async (row): Promise<Outcome<Confirm>> => {
					const prompt = byId.get(row.id);
					if (!prompt) return { error: ERRORS.notFound };
					const planned = await plan(rewindTargets(all, prompt), reader);
					plans.set(row.id, planned);
					const options = rewindOptions(planned.changes.length > 0, Boolean(ctx.model));
					return {
						result: {
							sentence: REWIND.confirm,
							text: prompt.text,
							age: timeAgo(prompt.time, now),
							options,
							describe: (option) => [description(option), codeLine(planned, option)].filter((line): line is string => line !== undefined),
							warnings: warnings(planned, inRepo),
						},
					};
				},
				choose: async (row, option, context): Promise<Outcome<Done>> => {
					const prompt = byId.get(row.id)!;
					const planned = plans.get(row.id)!;
					if (option === "summarize") {
						const span = projected(ctx, prompt.id);
						if (!span) return { error: ERRORS.summarize(ERRORS.notInContext) };
						if (!span.from.length) return { error: ERRORS.summarize(ERRORS.nothingAfter) };
						try {
							const { text, usage } = await summarize(ctx, span.from, "from", context);
							return { result: { action: "summarize", prompt, summary: text, usage } };
						} catch (error) {
							return { error: ERRORS.summarize((error as Error).message) };
						}
					}
					if (option === "summarize_up_to") {
						const before = projectedBefore(ctx, prompt.id);
						if (!before) return { error: ERRORS.summarize(ERRORS.notInContext) };
						if (!before.length) return { error: ERRORS.summarize(ERRORS.nothingBefore) };
						return { result: { action: "compact", prompt, context } };
					}
					let files: FileRecord[] = [];
					if (option === "code" || option === "both") {
						const restored = await restoreCode(planned, s);
						if (restored.error) return { error: restored.error };
						files = restored.files;
					}
					if (option === "code") {
						const leaf = ctx.sessionManager.getLeafId();
						if (files.length) await addRecord(s, { kind: "rewind", message: prompt.id, fromLeaf: leaf, toLeaf: leaf, conversation: false, files });
						return { result: { action: "none" } };
					}
					return { result: { action: "conversation", prompt, files } };
				},
			});
			if (!result || result.action === "none") return;
			const fromLeaf = ctx.sessionManager.getLeafId();
			if (result.action === "compact") {
				const marker = `rewind:summarize-up-to:${result.prompt.id}`;
				pendingCompact = { marker, prompt: result.prompt, context: result.context };
				const outcome = await new Promise<string | undefined>((resolve) =>
					ctx.compact({ customInstructions: marker, onComplete: () => resolve(undefined), onError: (error) => resolve(error.message) }),
				);
				pendingCompact = undefined;
				// Pi reports a failed compaction itself ("Compaction failed: …").
				if (!outcome) ctx.ui.notify(SUMMARIZED, "info");
				return;
			}
			try {
				if (result.action === "summarize") {
					pendingTree = { target: result.prompt.id, summary: result.summary, usage: result.usage };
					const moved = await ctx.navigateTree(result.prompt.id, { summarize: true });
					pendingTree = undefined;
					if (moved.cancelled) return;
					await addRecord(s, { kind: "rewind", message: result.prompt.id, fromLeaf, toLeaf: ctx.sessionManager.getLeafId(), conversation: true, files: [] });
					ctx.ui.notify(SUMMARIZED, "info");
					return;
				}
				const moved = await ctx.navigateTree(result.prompt.id);
				// The code was restored already: keep its record even if the move was refused.
				const toLeaf = moved.cancelled ? fromLeaf : ctx.sessionManager.getLeafId();
				await addRecord(s, { kind: "rewind", message: result.prompt.id, fromLeaf, toLeaf, conversation: !moved.cancelled, files: result.action === "conversation" ? result.files : [] });
			} catch (error) {
				pendingTree = undefined;
				const message = (error as Error).message;
				const files = result.action === "conversation" ? result.files : [];
				if (files.length) await addRecord(s, { kind: "rewind", message: result.prompt.id, fromLeaf, toLeaf: fromLeaf, conversation: false, files });
				ctx.ui.notify(result.action === "summarize" ? ERRORS.summarize(message) : ERRORS.conversation(message), "error");
			}
		},
	});

	pi.registerCommand("restore", {
		description: "Bring back prompts that /rewind removed: the code and/or conversation up to the point after one",
		handler: async (_args, ctx) => {
			const s = await prepare(ctx);
			if (!s) return;
			const path = branch(ctx);
			const src = await sources(ctx, s);
			const current = changes(path, ctx.cwd, src);
			const list = rewoundPrompts(path, src.records, (id) => ctx.sessionManager.getBranch(id) as unknown as Entry[]);
			const reader = new Reader(s);
			const inRepo = await isRepository(ctx.cwd);
			const now = Date.now();
			const byId = new Map(list.map((prompt) => [prompt.id, prompt]));
			const pathChanges = new Map<Rewound["path"], Change[]>();
			const changesOf = (prompt: Rewound) => {
				let own = pathChanges.get(prompt.path);
				if (!own) {
					// A code-only rewind's own record is the end of the path it restores.
					const records = prompt.record ? src.records.filter((record) => record.at < prompt.record!.at) : src.records;
					own = changes(prompt.path, ctx.cwd, { ...src, records });
					pathChanges.set(prompt.path, own);
				}
				return own;
			};
			const groups = new Set(list.map((prompt) => prompt.tip ?? prompt.record?.id));
			const plans = new Map<string, Plan>();
			let lastGroup: string | undefined;
			const rows: Row[] = list.map((prompt) => {
				const group = prompt.tip ?? prompt.record?.id;
				const header = groups.size > 1 && group !== lastGroup ? RESTORE.branch(timeAgo(prompt.at, now)) : undefined;
				lastGroup = group;
				return { id: prompt.id, text: prompt.text, time: prompt.time, ...(header ? { group: header } : {}) };
			});
			const result = await show<Done>(ctx, {
				title: RESTORE.title,
				subtitle: RESTORE.subtitle,
				nothing: RESTORE.nothing,
				currentFirst: true,
				rows,
				stats: async (row) => {
					const prompt = byId.get(row.id)!;
					return turnStats(turnPairs(changesOf(prompt), prompt), reader);
				},
				open: async (row): Promise<Outcome<Confirm>> => {
					const prompt = byId.get(row.id);
					if (!prompt) return { error: ERRORS.notFound };
					const planned = await plan(restoreTargets(current, changesOf(prompt), prompt, src.records), reader);
					plans.set(row.id, planned);
					const edited: string[] = [];
					for (const change of planned.changes) {
						const written = writtenByRecord(current, change.path);
						const expected = written && (await reader.read(written));
						if (expected !== undefined && expected !== "missing" && expected !== "unknown" && !sameState(await readState(change.path), expected)) edited.push(change.path);
					}
					const inConversation = !prompt.tip;
					return {
						result: {
							sentence: inConversation ? RESTORE.confirmCodeOnly : RESTORE.confirm,
							text: prompt.text,
							age: timeAgo(prompt.time, now),
							options: restoreOptions(planned.changes.length > 0, inConversation),
							describe: (option) => [restoreDescription(option), codeLine(planned, option)].filter((line): line is string => line !== undefined),
							warnings: [...(edited.length ? [RESTORE.editedSince(filesPhrase(edited))] : []), ...warnings(planned, inRepo)],
						},
					};
				},
				choose: async (row, option): Promise<Outcome<Done>> => {
					const prompt = byId.get(row.id)!;
					const planned = plans.get(row.id)!;
					let files: FileRecord[] = [];
					if (option === "code" || option === "both") {
						const restored = await restoreCode(planned, s);
						if (restored.error) return { error: restored.error };
						files = restored.files;
					}
					if (option === "code") {
						const leaf = ctx.sessionManager.getLeafId();
						if (files.length) await addRecord(s, { kind: "restore", message: prompt.id, fromLeaf: leaf, toLeaf: leaf, conversation: false, files });
						return { result: { action: "none" } };
					}
					return { result: { action: "restore", prompt, files } };
				},
			});
			if (!result || result.action !== "restore") return;
			const prompt = result.prompt;
			const fromLeaf = ctx.sessionManager.getLeafId();
			const target = prompt.path[prompt.end]!;
			try {
				const moved = await ctx.navigateTree(target.id);
				const toLeaf = moved.cancelled ? fromLeaf : ctx.sessionManager.getLeafId();
				await addRecord(s, { kind: "restore", message: prompt.id, fromLeaf, toLeaf, conversation: !moved.cancelled, files: result.files });
				if (moved.cancelled) return;
				// The rewind left the first rewound prompt in the input; it is back in the conversation now.
				const first = prompt.path[prompt.common + 1];
				const draft = first?.type === "message" && first.message?.role === "user" ? first.message.content : undefined;
				const text = typeof draft === "string" ? draft : Array.isArray(draft) ? draft.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n") : undefined;
				if (text !== undefined && ctx.ui.getEditorText().trim() === text.trim()) ctx.ui.setEditorText("");
			} catch (error) {
				if (result.files.length) await addRecord(s, { kind: "restore", message: prompt.id, fromLeaf, toLeaf: fromLeaf, conversation: false, files: result.files });
				ctx.ui.notify(ERRORS.conversation((error as Error).message), "error");
			}
		},
	});
}
