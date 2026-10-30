// You should know for Pi: a side agent that watches the session while Pi
// works and flags, above the editor, the one thing the person should know but
// might miss. A port of Claude Code 2.1.314's cc-plugin-you-should-know; see
// SPEC.md for what it does and README.md for where the port differs.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Band, type BandState } from "./band.ts";
import {
	ASKED_MS,
	type Check,
	type CheckOutcome,
	checksWith,
	DEFAULT_TAG,
	isAlreadyOffered,
	isCheckStep,
	isDebugOn,
	LOOKS_TO_SKIP_MAX,
	looksToSkipAfter,
	parseExplanation,
	parseProposedLine,
	respondDraft,
} from "./parse.ts";
import { type ExplainDirection, explainPrompt, proposePrompt } from "./prompts.ts";
import { type Stored, Store, withAnswered, withKnown, withSeen } from "./store.ts";
import {
	aboutKeyOf,
	type Action,
	atTurnStart,
	type Choice,
	choicesOf,
	ENTRY_TYPE,
	isOpenView,
	OFF_BOX_BUSY,
	OFF_COMMAND,
	RESPOND_BOX_BUSY,
	type Row,
	revived,
	rowOf,
	type View,
} from "./view.ts";

const WIDGET_KEY = "you-should-know";
// Claude Code focuses its band with ctrl+x tab; Pi binds ctrl+x to copying.
const FOCUS_KEY = "alt+k";
const DEBUG_ENV = "PI_YOU_SHOULD_KNOW_DEBUG";

type ForkReply = { kind: "answered"; text: string } | { kind: "nothing-to-fork" | "empty-reply" | "api-error" | "aborted" };

const UNANSWERED: Record<Exclude<ForkReply["kind"], "answered">, CheckOutcome> = {
	"nothing-to-fork": "none",
	"empty-reply": "none",
	"api-error": "api_error",
	aborted: "aborted",
};

const DIRECTIONS: readonly string[] = ["simpler_words", "less_detail", "more_detail"] satisfies ExplainDirection[];
const isDirection = (action: Action): action is ExplainDirection => DIRECTIONS.includes(action);

export default function (pi: ExtensionAPI) {
	const store = new Store(path.join(getAgentDir(), "you-should-know", "state.json"));
	const isDebug = isDebugOn(process.env[DEBUG_ENV]);

	let ctx: ExtensionContext | undefined;
	let row: Row = {};
	let aborter = new AbortController();
	let isEnded = false;
	let isShuttingDown = false;

	// Claude Code's turn is one prompt's run; its steps are Pi's turns.
	let turnId = randomUUID();
	let offeredTurn: string | undefined;
	let askedTurn: string | undefined;
	let promptsSinceTurnStart = 0;
	// The last prompt came from another extension (Remote Control): nobody is
	// looking at the terminal's band, like Claude Code's bridge prompts.
	let isRemote = false;

	let isChecking = false;
	let isExplaining = false;
	let isResponding = false;
	let checked = 0;
	let checks: Check[] = [];

	let askedTimer: NodeJS.Timeout | undefined;
	let aboutOpen: string | undefined;
	let focus: number | null = null;
	let isWidgetShown = false;
	let requestRender: (() => void) | undefined;
	let stopListening: (() => void) | undefined;

	// ---- state ----

	function bandState(): BandState {
		const view = row.view;
		const isAboutOpen = view?.kind === "offer" && aboutOpen === aboutKeyOf(view);
		return {
			view,
			tag: row.tag ?? DEFAULT_TAG,
			choices: choicesOf(view, { isAboutOpen }),
			isAboutOpen,
			focus,
			focusKey: FOCUS_KEY,
			checks: isDebug ? checks : [],
		};
	}

	function setRow(next: Row) {
		row = next;
		pi.appendEntry(ENTRY_TYPE, row);
		refresh();
	}

	const setView = (view: View | undefined) => setRow({ ...row, view });

	function refresh() {
		const c = ctx;
		if (!c || c.mode !== "tui" || isShuttingDown) return;
		const state = bandState();
		if (focus !== null && focus >= state.choices.length) focus = state.choices.length > 0 ? state.choices.length - 1 : null;
		const hasContent = (state.view !== undefined && state.view.kind !== "off") || state.checks.length > 0;
		if (!hasContent) {
			if (isWidgetShown) c.ui.setWidget(WIDGET_KEY, undefined);
			isWidgetShown = false;
			requestRender = undefined;
			return;
		}
		if (isWidgetShown && requestRender) {
			requestRender();
			return;
		}
		c.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			requestRender = () => tui.requestRender();
			return new Band(theme, bandState);
		});
		isWidgetShown = true;
	}

	const answered = () => store.update(withAnswered);
	const know = (line: string) => store.update((s) => withKnown(s, line));

	function lastRow(c: ExtensionContext): Row | undefined {
		const branch = c.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return rowOf(entry.data);
		}
		return undefined;
	}

	// ---- the side agent ----

	// Claude Code forks the main conversation; here the side request is the
	// session's own model context with the prompt appended as a user message.
	async function fork(prompt: string): Promise<ForkReply> {
		const c = ctx;
		const model = c?.model;
		if (!c || !model) return { kind: "nothing-to-fork" };
		const messages: Message[] = convertToLlm(c.sessionManager.buildSessionProjection().messages);
		if (!messages.some((m) => m.role !== "system")) return { kind: "nothing-to-fork" };
		messages.push({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
		try {
			const reply = await c.modelRegistry.streamSimple(model, { messages }, { signal: aborter.signal }).result();
			if (reply.stopReason === "aborted") return { kind: "aborted" };
			if (reply.stopReason === "error") return { kind: "api-error" };
			const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
			return text.trim() === "" ? { kind: "empty-reply" } : { kind: "answered", text };
		} catch {
			return aborter.signal.aborted ? { kind: "aborted" } : { kind: "api-error" };
		}
	}

	function maybeCheck(step: number, isForced = false) {
		const c = ctx;
		if (!c || c.mode !== "tui") return;
		const stored = store.read();
		if (!stored.enabled || (isRemote && !isForced)) return;
		if (offeredTurn === turnId || row.view !== undefined || isChecking) return;
		const skip = Math.min(LOOKS_TO_SKIP_MAX, stored.looksToSkip);
		if (skip > 0 && !isForced) {
			store.update((s) => ({ ...s, looksToSkip: skip - 1 }));
			return;
		}
		isChecking = true;
		void check(step).finally(() => {
			isChecking = false;
		});
	}

	async function check(step: number) {
		const thisTurn = turnId;
		askedTurn = thisTurn;
		const stored = store.read();
		const startedAt = Date.now();
		let outcome: CheckOutcome;
		try {
			const reply = await fork(proposePrompt(stored.seen, stored.known));
			outcome = reply.kind === "answered" ? offer(reply.text, stored, thisTurn) : UNANSWERED[reply.kind];
		} catch {
			outcome = "error";
		}
		if (isDebug && !isEnded) {
			checked++;
			checks = checksWith(checks, { number: checked, step, outcome, latencyMs: Date.now() - startedAt, at: Date.now() });
			refresh();
		}
	}

	function offer(reply: string, stored: Stored, thisTurn: string): CheckOutcome {
		const proposal = parseProposedLine(reply);
		if (proposal.kind !== "line") return proposal.kind === "none" ? "none" : "parse_failed";
		if (isAlreadyOffered(proposal.line, stored.seen, stored.known)) return "deduped";
		if (askedTurn !== thisTurn || isEnded || isShuttingDown || !store.read().enabled) return "stale";
		store.update((s) => withSeen(s, proposal.line));
		offeredTurn = thisTurn;
		promptsSinceTurnStart = 0;
		setRow({ tag: proposal.tag, view: { kind: "offer", line: proposal.line, explanation: proposal.explanation, shownAt: Date.now() } });
		return "shown";
	}

	async function explain(line: string, iteration: number, again?: { direction: ExplainDirection; previous: string }) {
		isExplaining = true;
		try {
			setView({ kind: "explaining", line, iteration });
			const reply = await fork(explainPrompt(line, again));
			if (isEnded || isShuttingDown || row.view?.kind !== "explaining") return;
			const text = reply.kind === "answered" ? reply.text.trim() : "";
			const shown = text !== "" && parseExplanation(text).length > 0 ? { text, iteration } : again ? { text: again.previous, iteration: iteration - 1 } : undefined;
			if (!shown) return setView({ kind: "failed", reason: "explain" });
			promptsSinceTurnStart = 0;
			setView({ kind: "explained", line, text: shown.text, iteration: shown.iteration, shownAt: Date.now() });
		} finally {
			isExplaining = false;
		}
	}

	// ---- answers ----

	function startAskedTimer(view: Extract<View, { kind: "asked" }>) {
		clearTimeout(askedTimer);
		askedTimer = setTimeout(() => {
			if (row.view?.kind === "asked" && row.view.shownAt === view.shownAt) setView(undefined);
		}, ASKED_MS);
	}

	function ask(line: string, iteration?: number) {
		const view: View = { kind: "asked", line, shownAt: Date.now(), ...(iteration !== undefined && { iteration }) };
		setView(view);
		startAskedTimer(view);
	}

	function turnOff(line: string) {
		const c = ctx;
		if (!c) return;
		if (c.ui.getEditorText().trim() !== "") {
			c.ui.notify(OFF_BOX_BUSY, "info");
			return;
		}
		setView({ kind: "off", line, shownAt: Date.now() });
		answered();
		c.ui.setEditorText(OFF_COMMAND);
	}

	function respond(view: Extract<View, { kind: "explained" }>) {
		const c = ctx;
		if (!c || isResponding) return;
		isResponding = true;
		try {
			if (c.ui.getEditorText().trim() !== "") {
				c.ui.notify(RESPOND_BOX_BUSY, "info");
				return;
			}
			c.ui.setEditorText(`${respondDraft(view.line, parseExplanation(view.text), row.tag ?? DEFAULT_TAG)}\n\n`);
			answered();
			know(view.line);
			setView(undefined);
		} finally {
			isResponding = false;
		}
	}

	function act(action: Action) {
		const view = row.view;
		if (!view) return;
		if (view.kind === "asked") clearTimeout(askedTimer);
		switch (action) {
			case "explain":
				if (view.kind !== "offer" || isExplaining) return;
				answered();
				// The proposal usually carries its explanation already: no second request.
				if (view.explanation !== undefined && parseExplanation(view.explanation).length > 0) {
					promptsSinceTurnStart = 0;
					return setView({ kind: "explained", line: view.line, text: view.explanation, iteration: 1, shownAt: Date.now() });
				}
				return void explain(view.line, 1);
			case "knew":
			case "helpful":
			case "got_it":
				if (!("line" in view)) return;
				answered();
				know(view.line);
				return setView(undefined);
			case "about":
				if (view.kind !== "offer") return;
				aboutOpen = aboutOpen === aboutKeyOf(view) ? undefined : aboutKeyOf(view);
				return refresh();
			case "off":
				if (view.kind !== "offer") return;
				if (view.isOffArmed) return turnOff(view.line);
				return setView({ ...view, isOffArmed: true });
			case "later":
				if (view.kind !== "offer") return;
				answered();
				return ask(view.line);
			case "not_relevant":
			case "not_understood":
				answered();
				return setView(undefined);
			case "turn_off":
				if (view.kind === "asked") turnOff(view.line);
				return;
			// Claude Code counts this one as the 20 seconds running out.
			case "asked_dismiss":
			case "ok":
				return setView(undefined);
			case "respond":
				if (view.kind === "explained") respond(view);
				return;
			case "explained_dismiss":
				if (view.kind !== "explained") return;
				answered();
				return ask(view.line, view.iteration);
			default:
				if (view.kind !== "explained" || !isDirection(action) || isExplaining) return;
				answered();
				return void explain(view.line, view.iteration + 1, { direction: action, previous: view.text });
		}
	}

	function press(choice: Choice) {
		// These two leave the same row up, so the focus stays on it.
		const keepsFocus = choice.action === "about" || (choice.action === "off" && row.view?.kind === "offer" && !row.view.isOffArmed);
		if (!keepsFocus) focus = null;
		act(choice.action);
		refresh();
	}

	function onKey(data: string) {
		if (focus === null) return undefined;
		const { choices } = bandState();
		if (choices.length === 0) {
			focus = null;
			refresh();
			return undefined;
		}
		const byHotkey = choices.find((c) => c.hotkey === data);
		if (byHotkey) {
			press(byHotkey);
		} else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			focus = (focus + 1) % choices.length;
		} else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			focus = (focus - 1 + choices.length) % choices.length;
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			press(choices[focus]!);
		} else if (matchesKey(data, "escape")) {
			focus = null;
		} else {
			// Typing goes back to the editor, as leaving Claude Code's band does.
			focus = null;
			refresh();
			return undefined;
		}
		refresh();
		return { consume: true };
	}

	function clearOffLine() {
		if (row.view?.kind === "off") setView(undefined);
	}

	// ---- Pi events ----

	pi.on("session_start", (_event, c) => {
		ctx = c;
		isEnded = false;
		isShuttingDown = false;
		aborter = new AbortController();
		const restored = lastRow(c);
		row = revived(restored);
		if (restored?.view !== row.view) pi.appendEntry(ENTRY_TYPE, row);
		if (c.mode === "tui") stopListening = c.ui.onTerminalInput(onKey);
		refresh();
	});

	pi.on("session_shutdown", (event) => {
		// A reload keeps the session: the new runtime picks the row back up.
		if (event.reason !== "reload") {
			isEnded = true;
			isShuttingDown = true;
			if (isOpenView(row.view) || row.view?.kind === "off") setView(undefined);
		}
		isShuttingDown = true;
		aborter.abort();
		clearTimeout(askedTimer);
		stopListening?.();
		stopListening = undefined;
	});

	pi.on("input", (event, c) => {
		ctx = c;
		isRemote = event.source === "extension";
		clearOffLine();
		promptsSinceTurnStart++;
	});

	pi.on("agent_start", (_event, c) => {
		ctx = c;
		turnId = randomUUID();
		const before = row.view;
		const { view, ignored } = atTurnStart(before, promptsSinceTurnStart);
		promptsSinceTurnStart = 0;
		if (before?.kind === "asked") clearTimeout(askedTimer);
		if (view !== before) setView(view);
		if (ignored) {
			store.update((s) => {
				const typedPastInARow = s.typedPastInARow + 1;
				return { ...s, typedPastInARow, looksToSkip: looksToSkipAfter(typedPastInARow) };
			});
		}
	});

	// Claude Code checks as step 6, 12, 18… of a turn starts; in Pi that is
	// the end of a turn whose tool results send the agent back to the model.
	pi.on("turn_end", (event, c) => {
		ctx = c;
		const step = event.turnIndex + 1;
		if (event.toolResults.length > 0 && isCheckStep(step)) maybeCheck(step);
	});

	pi.registerShortcut(FOCUS_KEY, {
		description: "You should know: choose from the suggestion above the editor",
		handler: (c) => {
			ctx = c;
			if (bandState().choices.length === 0) return;
			focus = 0;
			refresh();
		},
	});

	pi.registerCommand("you-should-know", {
		description: "You should know: choose from the suggestion, or on | off | status | check",
		handler: async (args, c) => {
			ctx = c;
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				store.update((s) => ({ ...s, enabled: false }));
				if (row.view) setView(undefined);
				c.ui.notify("You should know is off on this machine. /you-should-know on turns it back on.", "info");
			} else if (arg === "on") {
				store.update((s) => ({ ...s, enabled: true }));
				c.ui.notify("You should know is on.", "info");
			} else if (arg === "status") {
				const s = store.read();
				c.ui.notify(`You should know is ${s.enabled ? "on" : "off"} · ${s.seen.length} offered · ${s.known.length} known · ${store.file}`, "info");
			} else if (arg === "check") {
				if (row.view) return c.ui.notify("A suggestion is already showing.", "info");
				maybeCheck(0, true);
				c.ui.notify(isChecking ? "Checking the session…" : "Can't check now.", "info");
			} else {
				const { choices } = bandState();
				if (choices.length === 0 || !c.hasUI) return c.ui.notify(`Nothing to choose. Usage: /you-should-know [on|off|status|check]`, "info");
				const picked = await c.ui.select(row.view && "line" in row.view ? row.view.line : "You should know", choices.map((ch) => `${ch.hotkey}: ${ch.label}`));
				const choice = choices.find((ch) => `${ch.hotkey}: ${ch.label}` === picked);
				if (choice) press(choice);
			}
		},
	});
}
