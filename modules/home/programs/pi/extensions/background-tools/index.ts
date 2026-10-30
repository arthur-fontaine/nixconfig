// Background tools for Pi: Ctrl+B detaches a running bash call from its turn
// without stopping the command, and the model can ask for the same up front
// with bash's `background: true`. bash_output and bash_kill follow and stop
// detached calls; each one's final result replaces its placeholder.
import { Type } from "@earendil-works/pi-ai";
import {
	type AgentBeforeSettleEvent,
	type BoundaryResult,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type CallEvents, DetachableCall, type Outcome } from "./call.ts";
import {
	completionNotice,
	type DetachedRecord,
	type Entry,
	interruptedRecord,
	lastLines,
	pendingEdits,
	placeholdersOn,
	projectRecords,
	RECORD_TYPE,
	recordsOn,
	report,
	stateLine,
	textOf,
	unknownCall,
} from "./records.ts";
import { detachedRenderer, type View } from "./render.ts";

const TOOL = "bash";
const STATUS_KEY = "background-tools";
// Other extensions can follow detached calls here, since Pi emits no tool
// events for them once their placeholder is returned.
const CHANNEL = "background-tools";
const NOTICE_TYPE = "background-tools";
const KILL_TAIL_LINES = 20;

export type BackgroundToolEvent =
	| { type: "detach"; toolCallId: string; toolName: string; startedAt: number }
	| { type: "update"; toolCallId: string; result: Outcome["result"] }
	| { type: "end"; toolCallId: string; result: Outcome["result"]; isError: boolean; stopped: boolean };

const callId = Type.String({ description: "Tool call ID of the background call" });

export default function (pi: ExtensionAPI) {
	// Running calls that can be or have been detached, by tool call id.
	const calls = new Map<string, DetachableCall>();
	// Final results on the current branch.
	let records = new Map<string, DetachedRecord>();
	// Records already written into the session as context edits (or found to need none).
	const synced = new Set<string>();
	// Top-level model calls in the TUI, between tool_call and their execution.
	const eligible = new Set<string>();
	const repaints = new Map<string, () => void>();
	// Bumped on each branch change; a call ending on another branch than the one
	// it was detached on doesn't wake the model there.
	let branchGeneration = 0;
	const detachedOn = new WeakMap<DetachableCall, number>();
	let ctx: ExtensionContext | undefined;
	let stopInput: (() => void) | undefined;

	const emit = (event: BackgroundToolEvent) => pi.events.emit(CHANNEL, event);
	const detachedCalls = () => [...calls.values()].filter((call) => call.detached && call.running);
	const branch = () => (ctx?.sessionManager.getBranch() ?? []) as unknown as Entry[];

	function showStatus() {
		if (ctx?.mode !== "tui") return;
		const count = detachedCalls().length;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(STATUS_KEY, count ? theme.fg("muted", `${count} command${count === 1 ? "" : "s"} in background`) : undefined);
	}

	function remember(record: DetachedRecord) {
		pi.appendEntry(RECORD_TYPE, record);
		records.set(record.toolCallId, record);
		synced.delete(record.toolCallId);
	}

	const events: CallEvents = {
		detached(call) {
			detachedOn.set(call, branchGeneration);
			emit({ type: "detach", toolCallId: call.toolCallId, toolName: call.toolName, startedAt: call.startedAt });
			showStatus();
		},
		updated(call) {
			if (call.latest) emit({ type: "update", toolCallId: call.toolCallId, result: call.latest });
			repaints.get(call.toolCallId)?.();
		},
		ended(call, outcome) {
			calls.delete(call.toolCallId);
			const record: DetachedRecord = {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				startedAt: call.startedAt,
				endedAt: Date.now(),
				ending: call.stopped ? "stopped" : outcome.isError ? "failed" : "completed",
				content: outcome.result.content,
				details: outcome.result.details,
			};
			remember(record);
			emit({ type: "end", toolCallId: call.toolCallId, result: outcome.result, isError: outcome.isError, stopped: call.stopped });
			repaints.get(call.toolCallId)?.();
			repaints.delete(call.toolCallId);
			showStatus();
			if (call.stopped || detachedOn.get(call) !== branchGeneration) return;
			pi.sendMessage(
				{ customType: NOTICE_TYPE, content: completionNotice(record), display: false, details: { toolCallId: call.toolCallId, ending: record.ending } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	};

	// The built-in bash, rebuilt like Pi builds it, because settings can't be
	// read while extensions load.
	const template = createBashToolDefinition(process.cwd());
	const builtins = new Map<string, typeof template>();
	function builtinBash(cwd: string) {
		const settings = pi.getSettings();
		const key = JSON.stringify([settings.shellCommandPrefix, settings.shellPath]);
		let bash = builtins.get(key);
		if (!bash) {
			bash = createBashToolDefinition(cwd, { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath });
			builtins.set(key, bash);
		}
		return bash;
	}

	pi.registerTool({
		...template,
		parameters: Type.Object({
			...template.parameters.properties,
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run detached from the start: the call returns at once, the command keeps running, and its final output is delivered when it ends.",
				}),
			),
		}),
		promptGuidelines: [
			...(template.promptGuidelines ?? []),
			"Use bash with background: true for commands that keep running or take minutes (servers, watchers, long builds); follow them with bash_output and stop them with bash_kill.",
		],
		async execute(toolCallId, { background, ...input }, signal, onUpdate, toolCtx) {
			const bash = builtinBash(toolCtx.cwd);
			const run = (runSignal: AbortSignal | undefined, runUpdate: typeof onUpdate) => bash.execute(toolCallId, input, runSignal, runUpdate, toolCtx);
			if (!eligible.delete(toolCallId) || toolCtx.mode !== "tui") return run(signal, onUpdate);
			const call = new DetachableCall(toolCallId, TOOL, events);
			calls.set(toolCallId, call);
			const result = call.run(run, signal, onUpdate as ((partial: Outcome["result"]) => void) | undefined);
			if (background) call.detach();
			try {
				return (await result) as Awaited<ReturnType<typeof run>>;
			} finally {
				if (!call.detached) calls.delete(toolCallId);
			}
		},
	});

	function view(id: string): View | undefined {
		const call = calls.get(id);
		if (call?.detached) return { running: call.running, result: call.latest, elapsedMs: call.elapsedMs };
		const record = records.get(id);
		if (record) return { running: false, ending: record.ending, result: { content: record.content, details: record.details }, elapsedMs: record.endedAt - record.startedAt };
		return undefined;
	}

	const runningIds = () => detachedCalls().map((call) => call.toolCallId);

	pi.registerTool({
		name: "bash_output",
		label: "Background output",
		description: "Show what a detached bash call has printed so far, or its final output once it has ended.",
		promptSnippet: "Read the output so far of a bash call running in the background",
		parameters: Type.Object({
			id: callId,
			lines: Type.Optional(Type.Integer({ minimum: 1, description: "Return only the last N lines" })),
		}),
		async execute(_toolCallId, { id, lines }) {
			const state = view(id);
			if (!state) throw new Error(unknownCall(id, runningIds()));
			return report(stateLine(id, state), lastLines(textOf(state.result?.content), lines));
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "Stop background call",
		description: "Stop a detached bash call and return the last lines it printed.",
		promptSnippet: "Stop a bash call running in the background",
		parameters: Type.Object({ id: callId }),
		async execute(_toolCallId, { id }) {
			const call = calls.get(id);
			const outcome = call?.detached ? await call.stop() : undefined;
			if (!outcome) {
				const ended = records.get(id);
				throw new Error(ended ? stateLine(id, view(id)!) : unknownCall(id, runningIds()));
			}
			return report(`Stopped ${id}.`, lastLines(textOf(outcome.result.content), KILL_TAIL_LINES));
		},
	});

	pi.registerToolRenderer(
		detachedRenderer(TOOL, view, (id, repaint) => {
			repaints.set(id, repaint);
		}),
	);

	pi.on("tool_call", (event, eventCtx) => {
		if (event.toolName === TOOL && !event.parentToolCallId && eventCtx.mode === "tui") eligible.add(event.toolCallId);
	});

	pi.on("tool_execution_end", (event) => {
		eligible.delete(event.toolCallId);
	});

	// Model requests see final results before their context edits land.
	pi.on("context", (event) => {
		if (records.size === 0) return;
		const messages = projectRecords(event.messages, records);
		return messages && { messages };
	});

	// Context edits make the final results part of the session itself, for
	// compaction and for sessions opened without this extension.
	const writeEdits = (event: TurnEndEvent | AgentBeforeSettleEvent): BoundaryResult | undefined => {
		if ([...records.keys()].every((id) => synced.has(id))) return;
		const drafts = pendingEdits(branch(), records);
		for (const id of records.keys()) synced.add(id);
		if (drafts.length === 0) return;
		return { entries: [...event.entries, ...drafts] };
	};
	pi.on("turn_end", writeEdits);
	pi.on("agent_before_settle", writeEdits);

	// Placeholders whose call is gone (Pi quit or reloaded while it ran) get a
	// final result saying so.
	function loadBranch() {
		records = recordsOn(branch());
		synced.clear();
		for (const [id, { startedAt }] of placeholdersOn(branch())) {
			if (!records.has(id) && !calls.has(id)) remember(interruptedRecord(id, TOOL, startedAt, startedAt));
		}
	}

	pi.on("session_start", (_event, next) => {
		ctx = next;
		branchGeneration++;
		loadBranch();
		stopInput?.();
		stopInput = undefined;
		if (next.mode !== "tui") return;
		stopInput = next.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+b")) return undefined;
			const detached = [...calls.values()].filter((call) => call.detach()).length;
			// Ctrl+B also moves the editor's cursor left; only a detach takes the key.
			if (detached === 0) return undefined;
			next.ui.notify(`Moved ${detached} running tool call${detached === 1 ? "" : "s"} to the background`, "info");
			return { consume: true };
		});
		showStatus();
	});

	pi.on("session_tree", (_event, next) => {
		ctx = next;
		branchGeneration++;
		loadBranch();
	});

	pi.on("session_shutdown", () => {
		stopInput?.();
		stopInput = undefined;
		for (const call of calls.values()) call.close();
		calls.clear();
		eligible.clear();
		repaints.clear();
		if (ctx?.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx = undefined;
	});
}
