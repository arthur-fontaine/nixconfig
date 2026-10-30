// Draws the band above Pi's editor, laid out like Claude Code's AbovePrompt
// rows: a star column, the tag and the line, then the numbered choices.
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Card, checkLineOf, type Check, noteTopic, parseExplanation, proseMarkdown, type Tag } from "./parse.ts";
import { ABOUT_COPY, type Choice, FAILED_TEXT, type View } from "./view.ts";

const STAR = "✦";
const STAR_CELLS = 2;
const CHOICE_GAP = 3;
const CARD_INSET = 2;

export interface BandState {
	view: View | undefined;
	tag: Tag;
	choices: Choice[];
	isAboutOpen: boolean;
	focus: number | null;
	focusKey: string;
	checks: Check[];
}

function starred(theme: Theme, body: string, width: number) {
	const lines = wrapTextWithAnsi(body, Math.max(width - STAR_CELLS, 1));
	return lines.map((line, i) => `${i === 0 ? `${theme.fg("accent", STAR)} ` : "  "}${line}`);
}

function choicesRow(theme: Theme, choices: Choice[], focus: number | null, width: number, lead = "") {
	const items = choices.map((c, i) => {
		const text = `${c.hotkey}: ${c.label}`;
		if (focus === i) return theme.inverse(text);
		return c.isDim ? theme.fg("dim", text) : text;
	});
	const rows: string[] = [];
	let row = lead;
	let hasItem = false;
	for (const item of items) {
		const piece = (hasItem ? " ".repeat(CHOICE_GAP) : "") + item;
		if (hasItem && visibleWidth(row + piece) > width) {
			rows.push(row);
			row = `  ${item}`;
		} else {
			row += piece;
		}
		hasItem = true;
	}
	rows.push(row);
	return rows.map((r) => truncateToWidth(r, width));
}

function card(theme: Theme, c: Card, width: number) {
	const inner = Math.max(width - CARD_INSET, 1);
	const markdown = (text: string) => (text === "" ? [] : new Markdown(text.trimEnd(), 0, 0, getMarkdownTheme()).render(inner));
	const sketch = c.sketch.map((line) => theme.fg("mdCodeBlock", truncateToWidth(line === "" ? " " : line, inner)));
	return [...markdown(proseMarkdown(c.lead, c.title)), ...sketch, ...markdown(proseMarkdown(c.caption, ""))].map((l) => " ".repeat(CARD_INSET) + l);
}

function viewLines(theme: Theme, s: BandState, width: number): string[] {
	const { view } = s;
	const dimTag = (text: string) => theme.fg("dim", `${text} \xB7 `);
	const hint = s.focus === null && s.choices.length > 0 ? `  ${theme.fg("dim", `(${s.focusKey} to choose)`)}` : "";
	switch (view?.kind) {
		case undefined:
		case "off":
			return [];
		case "explaining":
			return ["", `${theme.fg("accent", STAR)} ${theme.fg("dim", "One moment…")}`];
		case "failed":
			return ["", ...choicesRow(theme, s.choices, s.focus, width, `${theme.fg("accent", STAR)} ${FAILED_TEXT[view.reason]} ${theme.fg("dim", "\xB7")} `)];
		case "asked":
			return ["", ...choicesRow(theme, s.choices, s.focus, width, `${theme.fg("accent", STAR)} ${theme.fg("dim", "Dismissed.")}${" ".repeat(CHOICE_GAP)}`)];
		case "offer": {
			const body = s.isAboutOpen
				? theme.fg("dim", ABOUT_COPY.join(" ").replaceAll("**", "").replaceAll("`", ""))
				: `${dimTag(s.tag)}${view.line}`;
			return ["", ...starred(theme, body + hint, width), ...choicesRow(theme, s.choices, s.focus, width, "  ")];
		}
		case "explained": {
			const cards = parseExplanation(view.text);
			return [
				"",
				...starred(theme, `${dimTag(s.tag)}${noteTopic(view.line)}${hint}`, width),
				...cards.flatMap((c) => ["", ...card(theme, c, width)]),
				"",
				...choicesRow(theme, s.choices, s.focus, width, "  "),
			];
		}
	}
}

export function bandLines(theme: Theme, s: BandState, width: number): string[] {
	const debug = s.checks.map((c) => truncateToWidth(`${theme.fg("accent", STAR)} ${theme.fg("dim", checkLineOf(c))}`, width));
	const lines = viewLines(theme, s, width);
	return debug.length > 0 ? ["", ...debug, ...lines] : lines;
}

export class Band implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly state: () => BandState,
	) {}

	render(width: number): string[] {
		return bandLines(this.theme, this.state(), width).map((l) => truncateToWidth(l, width));
	}

	invalidate() {}
}
