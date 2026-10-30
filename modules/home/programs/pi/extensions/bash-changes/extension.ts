// The Pi wiring, with Pi's rendering helpers passed in (see index.ts).
import type { AgentToolResult, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ChangesView, DEFAULT_VIEW, fileChangesOf, type Paint, type RenderDeps, type ViewSettings } from "./render.ts";
import { type FileChanges, Snapshots, type Window } from "./snapshot.ts";

export type Settings = { detect: boolean; view: ViewSettings };

const count = (value: unknown, fallback: number) => (typeof value === "number" && value >= 0 ? value : fallback);

export function settingsFrom(raw: unknown): Settings {
	const own = (raw as { bashChanges?: Record<string, unknown> } | undefined)?.bashChanges ?? {};
	return {
		detect: own.detect !== false,
		view: {
			openFiles: count(own.openFiles, DEFAULT_VIEW.openFiles),
			newFilesOpen: own.newFilesOpen === true,
			previewLines: count(own.previewLines, DEFAULT_VIEW.previewLines),
			listFiles: count(own.listFiles, DEFAULT_VIEW.listFiles),
		},
	};
}

// background-tools hands Pi a placeholder result when it detaches a bash call
// and reports the real end on this channel; Pi runs no tool_result for it.
const BACKGROUND_CHANNEL = "background-tools";
const ENTRY_TYPE = "bash-changes";

type Pending = { window: Promise<Window | undefined>; overlapping: boolean; detached: boolean };
type BackgroundEvent = { type?: string; toolCallId?: string };
type Entry = { type?: string; customType?: string; data?: { toolCallId?: unknown; fileChanges?: unknown } };

const isPlaceholder = (details: unknown) => {
	const background = (details as { background?: unknown } | undefined)?.background;
	return typeof background === "object" && background !== null;
};

export type ChangesSource = {
	view(): ViewSettings;
	// Changes recorded outside the result's details, for detached calls.
	saved(toolCallId: string): FileChanges | undefined;
	// The row of a call whose changes are still to come, to repaint when they do.
	watch(toolCallId: string, repaint: () => void): void;
};

export function bashChanges(pi: ExtensionAPI, deps: RenderDeps, snapshots = new Snapshots()) {
	let settings = settingsFrom(undefined);
	// Calls of any tool between their start and end: changes they make land in an open window too.
	const running = new Set<string>();
	// Bash calls snapshotted before running and not yet closed.
	const pending = new Map<string, Pending>();
	// Changes of detached calls, saved as session entries since their result can't carry them.
	let saved = new Map<string, FileChanges>();
	const repaints = new Map<string, () => void>();

	const discard = (toolCallId: string) => {
		const call = pending.get(toolCallId);
		pending.delete(toolCallId);
		void call?.window.then((window) => window?.discard()).catch(() => undefined);
	};

	async function close(toolCallId: string): Promise<FileChanges | undefined> {
		const call = pending.get(toolCallId);
		if (!call) return undefined;
		pending.delete(toolCallId);
		const changes = await (await call.window)?.close().catch(() => undefined);
		return changes && { ...changes, ...(call.overlapping ? { overlapping: true as const } : {}) };
	}

	function restore(entries: Entry[]) {
		saved = new Map();
		for (const entry of entries) {
			const changes = entry.type === "custom" && entry.customType === ENTRY_TYPE ? fileChangesOf(entry.data) : undefined;
			if (changes && typeof entry.data?.toolCallId === "string") saved.set(entry.data.toolCallId, changes);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		settings = settingsFrom(pi.getSettings());
		restore(ctx.sessionManager.getBranch() as Entry[]);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx.sessionManager.getBranch() as Entry[]);
	});

	pi.on("session_shutdown", async () => {
		for (const id of [...pending.keys()]) discard(id);
		running.clear();
		repaints.clear();
		await snapshots.dispose();
	});

	pi.on("tool_execution_start", async (event) => {
		running.add(event.toolCallId);
		for (const [id, call] of pending) if (id !== event.toolCallId) call.overlapping = true;
	});

	pi.on("tool_execution_end", async (event) => {
		running.delete(event.toolCallId);
		// tool_result always comes first, so a window still here belongs to a call
		// that never ran (blocked by another tool_call handler, invalid, aborted),
		// unless the call went on in the background.
		if (!pending.get(event.toolCallId)?.detached) discard(event.toolCallId);
	});

	pi.on("tool_call", async (event, ctx) => {
		// Nested calls (codemode scripts) never reach the transcript, so nothing would show their changes.
		if (event.toolName !== "bash" || event.parentToolCallId || !settings.detect) return;
		const overlapping = [...running, ...pending.keys()].some((id) => id !== event.toolCallId);
		// A tool_call handler that throws blocks the call; a failed snapshot only loses the record.
		const window = snapshots.open(ctx.cwd).catch(() => undefined);
		pending.set(event.toolCallId, { window, overlapping, detached: false });
		await window;
	});

	pi.on("tool_result", async (event) => {
		const call = pending.get(event.toolCallId);
		if (!call) return;
		if (call.detached || isPlaceholder(event.details)) {
			call.detached = true;
			return;
		}
		const changes = await close(event.toolCallId);
		if (!changes) return;
		const details = event.details as unknown;
		// Details another tool owns in another shape are left alone rather than replaced.
		if (details !== undefined && (typeof details !== "object" || details === null || Array.isArray(details))) return;
		return { details: { ...(details as object | undefined), fileChanges: changes } };
	});

	pi.events.on(BACKGROUND_CHANNEL, (data) => {
		const { type, toolCallId } = data as BackgroundEvent;
		const call = toolCallId === undefined ? undefined : pending.get(toolCallId);
		if (!call || !toolCallId) return;
		if (type === "detach") call.detached = true;
		// A detached call can end before Pi has even taken its placeholder.
		if (type !== "end" || !call.detached) return;
		void close(toolCallId).then((changes) => {
			if (!changes) return;
			pi.appendEntry(ENTRY_TYPE, { toolCallId, fileChanges: changes });
			saved.set(toolCallId, changes);
			repaints.get(toolCallId)?.();
			repaints.delete(toolCallId);
		});
	});

	const source: ChangesSource = {
		view: () => settings.view,
		saved: (toolCallId) => saved.get(toolCallId),
		watch: (toolCallId, repaint) => {
			if (pending.get(toolCallId)?.detached) repaints.set(toolCallId, repaint);
		},
	};
	pi.registerToolRenderer((toolName, next) => (toolName === "bash" ? withChanges(next(), source, deps) : next()));
}

// Draws the inner renderers' result (Pi's bash, or another extension's) and adds the changes below it.
export function withChanges(inner: ToolRenderers | undefined, source: ChangesSource, deps: RenderDeps): ToolRenderers {
	return {
		...inner,
		renderResult(result, options, theme, context) {
			const own = context.lastComponent instanceof ChangesView ? context.lastComponent : undefined;
			const innerContext = own ? { ...context, lastComponent: own.base } : context;
			const base = inner?.renderResult ? inner.renderResult(result, options, theme, innerContext) : textResult(result, theme, deps);
			source.watch(context.toolCallId, context.invalidate);
			const changes = options.isPartial ? undefined : (fileChangesOf(result.details) ?? source.saved(context.toolCallId));
			if (!changes) return base;
			if (own) {
				own.update(base, changes, options.expanded, source.view(), theme);
				return own;
			}
			return new ChangesView(base, changes, options.expanded, source.view(), theme, deps);
		},
	};
}

// Only for a bash tool registered without a result renderer.
function textResult(result: AgentToolResult<unknown>, theme: Paint, deps: RenderDeps): Component {
	const text = result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
	const lines = text ? text.split("\n").map((line) => theme.fg("toolOutput", line)) : [];
	return { render: (width) => (lines.length ? ["", ...lines.flatMap((line) => deps.wrap(line, Math.max(1, width)))] : []), invalidate() {} };
}
