// The band's states and the choices each one offers, as in Claude Code's
// `ui.render` hook. Pure, so the rules can be tested without Pi.
import { CLEAR_AFTER_PROMPTS, DEFAULT_TAG, type Tag } from "./parse.ts";
import type { ExplainDirection } from "./prompts.ts";

export type View =
	| { kind: "offer"; line: string; explanation?: string; shownAt: number; promptsSurvived?: number; isOffArmed?: boolean }
	| { kind: "explaining"; line: string; iteration: number }
	| { kind: "explained"; line: string; text: string; iteration: number; shownAt: number; promptsSurvived?: number }
	| { kind: "asked"; line: string; shownAt: number; iteration?: number }
	| { kind: "failed"; reason: "explain" | "turn_off" }
	| { kind: "off"; line: string; shownAt: number };

/** What a session shows, persisted with `pi.appendEntry`. */
export interface Row {
	view?: View;
	tag?: Tag;
}

export const ENTRY_TYPE = "you-should-know";
export const OFF_COMMAND = "/you-should-know off";

export const isOpenView = (view: View | undefined): view is Extract<View, { kind: "offer" | "explained" }> =>
	view?.kind === "offer" || view?.kind === "explained";

const VIEW_KINDS = new Set(["offer", "explaining", "explained", "asked", "failed", "off"]);

export function rowOf(value: unknown): Row | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { view, tag } = value as Record<string, unknown>;
	const isView = view === undefined || (typeof view === "object" && view !== null && VIEW_KINDS.has((view as { kind?: string }).kind ?? ""));
	if (!isView) return undefined;
	return { view: view as View | undefined, tag: tag === "Heads up" ? "Heads up" : tag === undefined ? undefined : DEFAULT_TAG };
}

/**
 * The row a resumed or reloaded session starts from. An explanation in flight
 * died with its process, and so did the asked row's 20-second timer.
 */
export function revived(row: Row | undefined): Row {
	if (!row) return {};
	const kind = row.view?.kind;
	return kind === "explaining" || kind === "asked" ? { ...row, view: undefined } : row;
}

/**
 * Claude Code's turn start (`turn.step` index 0): the asked row goes, and an
 * offer the person typed `prompts` prompts past survives one prompt; on the
 * second it counts as ignored. An explanation stays until answered.
 */
export function atTurnStart(view: View | undefined, prompts: number): { view: View | undefined; ignored: boolean } {
	if (view?.kind === "asked") return { view: undefined, ignored: false };
	if (!isOpenView(view) || prompts === 0) return { view, ignored: false };
	const survived = (view.promptsSurvived ?? 0) + prompts;
	if (view.kind === "explained") return { view: { ...view, promptsSurvived: survived }, ignored: false };
	if (survived < CLEAR_AFTER_PROMPTS) return { view: { ...view, promptsSurvived: survived, isOffArmed: false }, ignored: false };
	return { view: undefined, ignored: true };
}

export const aboutKeyOf = (view: { line: string; shownAt?: number }) => `${view.shownAt ?? "unstamped"} ${view.line}`;

export type Action =
	| "explain"
	| "knew"
	| "about"
	| "off"
	| "later"
	| "helpful"
	| "not_relevant"
	| "not_understood"
	| "turn_off"
	| "asked_dismiss"
	| "got_it"
	| "respond"
	| ExplainDirection
	| "explained_dismiss"
	| "ok";

export interface Choice {
	hotkey: string;
	label: string;
	action: Action;
	isDim?: boolean;
}

export const DIRECTION_LABELS: Record<ExplainDirection, string> = {
	simpler_words: "Simpler words",
	less_detail: "Less detail",
	more_detail: "More detail",
};

export function choicesOf(view: View | undefined, options: { isAboutOpen: boolean }): Choice[] {
	switch (view?.kind) {
		case "offer":
			return [
				{ hotkey: "1", label: "Learn more", action: "explain" },
				{ hotkey: "2", label: "Knew this already", action: "knew" },
				{ hotkey: "3", label: options.isAboutOpen ? "Return to topic" : "What is this", action: "about", isDim: true },
				{ hotkey: "4", label: view.isOffArmed ? "Press again to disable" : "Disable", action: "off", isDim: true },
				{ hotkey: "0", label: "Dismiss", action: "later" },
			];
		case "asked":
			return view.iteration !== undefined
				? [
						{ hotkey: "1", label: "That was helpful", action: "helpful" },
						{ hotkey: "2", label: "Didn’t understand", action: "not_understood" },
						{ hotkey: "0", label: "Dismiss", action: "asked_dismiss" },
					]
				: [
						{ hotkey: "1", label: "That was helpful", action: "helpful" },
						{ hotkey: "2", label: "Not relevant", action: "not_relevant" },
						{ hotkey: "3", label: "Couldn’t understand", action: "not_understood" },
						{ hotkey: "4", label: "Turn off suggestions", action: "turn_off" },
						{ hotkey: "0", label: "Dismiss", action: "asked_dismiss" },
					];
		case "explained":
			// 3 to 5 are not in Claude Code 2.1.314's band; see SPEC.md.
			return [
				{ hotkey: "1", label: "Understood", action: "got_it" },
				{ hotkey: "2", label: "Chat in main session", action: "respond" },
				{ hotkey: "3", label: DIRECTION_LABELS.simpler_words, action: "simpler_words", isDim: true },
				{ hotkey: "4", label: DIRECTION_LABELS.less_detail, action: "less_detail", isDim: true },
				{ hotkey: "5", label: DIRECTION_LABELS.more_detail, action: "more_detail", isDim: true },
				{ hotkey: "0", label: "Dismiss", action: "explained_dismiss" },
			];
		case "failed":
			return [{ hotkey: "0", label: "OK", action: "ok" }];
		default:
			return [];
	}
}

export const FAILED_TEXT: Record<Extract<View, { kind: "failed" }>["reason"], string> = {
	explain: "Couldn’t write that explanation",
	turn_off: "Couldn’t turn suggestions off here. Use /you-should-know off.",
};

export const OFF_BOX_BUSY = "Your prompt box has text in it. Send or clear it, then press again to turn suggestions off.";
export const RESPOND_BOX_BUSY = "Your prompt box has text in it. Send or clear it, then press 2 again.";

/** "What is this": Claude Code's terminal copy, with Pi's off command. */
export const ABOUT_COPY = [
	"A side agent is watching your back while Pi works.",
	"When something comes up that you should know but might miss, this plugin flags it for you.",
	"**Learn more** to get a deeper explanation and chat about it.",
	`Disable on this machine with \`${OFF_COMMAND}\`.`,
];
