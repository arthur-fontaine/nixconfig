// Pure text handling of the side agent's replies, ported function by function
// from cc-plugin-you-should-know (Claude Code 2.1.314). The original names are
// in SPEC.md.

export type Tag = "You should know" | "Heads up";

export type Proposal =
	| { kind: "none" }
	| { kind: "unparsable" }
	| { kind: "line"; line: string; tag: Tag; explanation: string | undefined };

export interface Card {
	title: string;
	lead: string;
	sketch: string[];
	caption: string;
}

export const DEFAULT_TAG: Tag = "You should know";
export const MAX_LINE_WIDTH = 240;
export const MAX_CAPTION_LENGTH = 4000;
export const MAX_CARDS = 4;
export const MAX_SKETCH_LINES = 12;
export const MAX_SKETCH_WIDTH = 120;
export const MAX_TITLE_WIDTH = 120;

const FENCE_LINE = /^```/;
const TITLE_LINE = /^(?:\*\*([^*]+)\*\*|#+\s*(.+))$/;
const LEARN_LABEL = /^learn\s*:\s*/i;
const EXPLAIN_LABEL = /^explain:\s*/i;
const HEADS_UP = /^\W*heads[\s-]*up\W*$/i;
const INLINE_TAG = /[.\s—–-]*\s\**tag\**\s*:\s*\**\s*(heads[\s-]*up|you should know)\W*$/i;
const TAG_LABEL = new RegExp(
	String.raw`^[\s>*_"'“”‘’` + "`" + String.raw`]*tag[\s*_"'“”‘’` + "`" + String.raw`]*(?::\s*|[-–—](?:\s+|$))`,
	"i",
);
const BULLET = /^[-*•]\s+/;

const WRAPPING_QUOTES = [
	['"', '"'],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
	["`", "`"],
] as const;
const CLOSERS = WRAPPING_QUOTES.map(([, close]) => close).join("");
const ENDS_A_SENTENCE = new RegExp(`[.!?…][${CLOSERS})\\]]*$`);
const ENDS_WITH_QUESTION = new RegExp(`\\?[${CLOSERS}]?$`);

const ansiSequence = () =>
	new RegExp(
		String.raw`[\u001B\u009B][[\]()#;?]*` +
			String.raw`(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*` +
			String.raw`|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?` +
			String.raw`(?:\u0007|\u001B\|\u009C))` +
			String.raw`|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
		"g",
	);

export const cleanOneLine = (text: string) =>
	text
		.replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, "")
		.replace(/\s+/g, " ")
		.trim();

export function sliceCodePointsHead(text: string, max: number) {
	if (max <= 0) return "";
	return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

export const stripControlSequences = (text: string) =>
	text
		.replace(/\p{Cs}/gu, "")
		.replace(ansiSequence(), "")
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");

export function truncateAtWordBoundary(text: string, max: number) {
	if (text.length <= max) return text;
	const head = sliceCodePointsHead(text, max - 1);
	const lastSpace = head.search(/\s\S*$/);
	const atWord = lastSpace !== -1 ? head.slice(0, lastSpace).trimEnd() : "";
	return `${atWord.length > max / 2 ? atWord : head.trimEnd()}…`;
}

const proseOf = (text: string) =>
	text
		.split("\n")
		.map(cleanOneLine)
		.filter((line) => line !== "")
		.join("\n");

const withoutTrailingPeriod = (text: string) => text.replace(/\.+$/, "");

export function unquoted(text: string) {
	const t = withoutTrailingPeriod(text.trim());
	const isWrapped =
		t.length >= 2 && WRAPPING_QUOTES.some(([open, close]) => t.startsWith(open) && t.endsWith(close) && !t.slice(1, -1).includes(close));
	return isWrapped ? withoutTrailingPeriod(t.slice(1, -1).trim()) : t;
}

export const isDeclined = (text: string) => text === "" || /^none\s*(?:[.!?()[\]:;,-]|$)/i.test(text);

const openingOf = (text: string) => unquoted(unquoted(text).replace(INLINE_TAG, ""));

export const tagOf = (text: string): Tag => (HEADS_UP.test(text) ? "Heads up" : DEFAULT_TAG);

const emptyCard = (): Card => ({ title: "", lead: "", sketch: [], caption: "" });

/** Splits an explanation into at most four cards: a bold or `#` title, prose, an optional fenced sketch, prose after it. */
export function parseExplanation(text: string): Card[] {
	const cards: Card[] = [];
	let card = emptyCard();
	let inFence = false;
	let hadFence = false;
	function flush() {
		card.lead = truncateAtWordBoundary(proseOf(card.lead), MAX_CAPTION_LENGTH);
		card.caption = truncateAtWordBoundary(proseOf(card.caption), MAX_CAPTION_LENGTH);
		if (card.title || card.lead || card.sketch.length > 0 || card.caption) cards.push(card);
		card = emptyCard();
	}
	for (const raw of text.split("\n")) {
		const line = stripControlSequences(raw).replace(/\s+$/, "");
		if (FENCE_LINE.test(line.trim())) {
			if (!inFence && hadFence) flush();
			inFence = !inFence;
			hadFence = true;
			continue;
		}
		if (inFence) {
			if (card.sketch.length < MAX_SKETCH_LINES) card.sketch = [...card.sketch, sliceCodePointsHead(line, MAX_SKETCH_WIDTH)];
			continue;
		}
		const title = TITLE_LINE.exec(line.trim());
		if (title) {
			flush();
			hadFence = false;
			card.title = sliceCodePointsHead(cleanOneLine(title[1] ?? title[2] ?? ""), MAX_TITLE_WIDTH);
			continue;
		}
		const field = card.sketch.length === 0 && !hadFence ? "lead" : "caption";
		card[field] += `\n${line}`;
	}
	flush();
	return cards.slice(0, MAX_CARDS);
}

/** Reads the side agent's `learn: / tag: / explain:` reply. */
export function parseProposedLine(reply: string): Proposal {
	const rawLines = reply.split("\n");
	const stripped = rawLines.map((l) => stripControlSequences(l).trimStart());
	const learnAt = stripped.findIndex((l) => LEARN_LABEL.test(l.replace(BULLET, "")));
	const explainAfter = stripped.slice(learnAt + 1).findIndex((l) => EXPLAIN_LABEL.test(l));
	const hasExplain = learnAt !== -1 && explainAfter !== -1;
	const explainAt = hasExplain ? learnAt + 1 + explainAfter : -1;
	const explanationText = [(stripped[explainAt] ?? "").replace(EXPLAIN_LABEL, ""), ...rawLines.slice(explainAt + 1)].join("\n").trim();
	const explanation = hasExplain ? explanationText || undefined : undefined;
	const head = (hasExplain ? rawLines.slice(0, explainAt) : rawLines).map((l) => cleanOneLine(stripControlSequences(l)).replace(BULLET, ""));
	const tagLine = head.find((l) => TAG_LABEL.test(l)) ?? "";
	const tag = tagOf(tagLine.replace(TAG_LABEL, ""));
	for (const [i, l] of head.entries()) {
		if (!LEARN_LABEL.test(l)) continue;
		let line = l.replace(LEARN_LABEL, "").trim();
		if (isDeclined(openingOf(line))) return { kind: "none" };
		// A learn line may wrap onto the next lines, up to a blank line or another label.
		for (const next of head.slice(i + 1)) {
			if (next === "" || LEARN_LABEL.test(next) || TAG_LABEL.test(next) || ENDS_WITH_QUESTION.test(line)) break;
			line += ` ${next}`;
		}
		const bare = unquoted(line);
		const inline = INLINE_TAG.exec(bare);
		const withoutTag = inline === null ? bare : unquoted(bare.slice(0, inline.index));
		const sentence = ENDS_A_SENTENCE.test(withoutTag) ? withoutTag : `${withoutTag}.`;
		const finalTag = tagLine === "" && inline !== null ? tagOf(inline[1] ?? "") : tag;
		if (sentence.length <= MAX_LINE_WIDTH) return { kind: "line", line: sentence, tag: finalTag, explanation };
	}
	return { kind: "unparsable" };
}

/** Dedupe key for offered lines: case and a trailing period don't count. */
export const lineKey = (line: string) => line.toLowerCase().replace(/\.$/, "");

export const isAlreadyOffered = (line: string, ...lists: readonly (readonly string[])[]) =>
	lists.some((list) => list.some((l) => lineKey(l) === lineKey(line)));

export const noteTopic = (line: unknown) => sliceCodePointsHead(cleanOneLine(stripControlSequences(typeof line === "string" ? line : "")), MAX_LINE_WIDTH);

export function cardText(card: Card) {
	const sketch = card.sketch.length > 0 ? ["```", ...card.sketch, "```"].join("\n") : "";
	return [card.title === "" ? "" : `**${card.title}**`, card.lead, sketch, card.caption].filter((part) => part !== "").join("\n");
}

const foldAtMentions = (text: string) => text.replace(/(^|[\s。、？！])@(?!\s)/g, "$1＠");
const foldReferencePlaceholders = (text: string) =>
	text.replace(
		new RegExp(String.raw`\[(Pasted text|Image|\.\.\.Truncated text|✦ Team setup guide) #(\d+)` + String.raw`(?: \+\d+ lines)?(\.)*\]`, "g"),
		(match) => `［${match.slice(1)}`,
	);
const splitDirectiveKeywords = (text: string) => text.replace(/(ultra)(code|plan|review|think)/gi, "$1-$2");
const withoutInvisible = (text: string) =>
	text
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
		.replace(
			new RegExp(
				String.raw`(?<!\p{Extended_Pictographic})` +
					String.raw`(?<![#*0-9](?=\uFE0F\u20E3))[\uFE0E\uFE0F]` +
					String.raw`|[^\P{Default_Ignorable_Code_Point}\uFE0E\uFE0F]` +
					String.raw`|[\u{1107F}\u{16FE4}]`,
				"gu",
			),
			"",
		);

// Claude Code's own prompt-box folds; kept as is: an `@` in the draft would
// otherwise open Pi's file picker too.
export const cleanForDraft = (text: string) => splitDirectiveKeywords(foldReferencePlaceholders(foldAtMentions(withoutInvisible(text))));

/** The note "Chat in main session" puts in the prompt box. */
export function respondDraft(line: string, cards: Card[], tag: Tag) {
	const quoted = [`${tag} \xB7 ${noteTopic(line)}`, ...cards.map(cardText)]
		.join("\n\n")
		.split("\n")
		.map((l) => (l === "" ? ">" : `> ${l}`))
		.join("\n");
	return cleanForDraft(`Here is a note offered by a side agent:\n\n${quoted}`);
}

// ---- Markdown for the explained cards ----
// Claude Code shows the side agent's prose almost literally: only **bold**
// and `code` stay markup, everything else is escaped.

const HARD_BREAK = "  \n";
const LIST_MARKER = /^(?:[-*+•]|(\d+)([.)]))\s+/;
const LEADING_NUMBER = /^(\d+)([.)])(?=\s|$)/;
const MARKUP = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|[\\`*_{}[<>#+\-=|~^$&:@]|(?<=[wW]{3})\./g;
const STRUCTURAL = /[\\`*_{}[<>#+\-=|~^$&:@]|(?<=[wW]{3})\./g;

const literal = (text: string) =>
	text
		.trimStart()
		.replace(MARKUP, (match, bold: string | undefined, code: string | undefined) => {
			if (code !== undefined) return match;
			if (bold !== undefined) return `**${bold.replace(STRUCTURAL, "\\$&")}**`;
			return `\\${match}`;
		})
		.replace(LEADING_NUMBER, "$1\\$2");

interface Shape {
	kind: "plain" | "bullet" | "ordered";
	text: string;
	canOpenInPlace: boolean;
	ordinal?: number;
}

function lineShape(line: string, previousOrdinal: number | undefined): Shape {
	const trimmed = line.trimStart();
	const marker = LIST_MARKER.exec(trimmed);
	const text = literal(trimmed.slice(marker?.[0].length ?? 0));
	const digits = marker?.[1];
	const n = Number(digits);
	const continues = `${(previousOrdinal ?? n - 1) + 1}.` === `${digits}${marker?.[2]}`;
	if (marker === null) return { kind: "plain", text, canOpenInPlace: false };
	if (digits === undefined) return { kind: "bullet", text: `- ${text}`, canOpenInPlace: true };
	return continues
		? { kind: "ordered", text: `${n}. ${text}`, canOpenInPlace: n === 1, ordinal: n }
		: { kind: "plain", text: `${digits}\\${marker[2]} ${text}`, canOpenInPlace: false };
}

function drawnLine(line: string, previous: Shape | undefined): Shape {
	const shape = lineShape(line, previous?.ordinal);
	const isPlain = shape.kind === "plain";
	const separator = isPlain && previous?.kind === "plain" ? HARD_BREAK : (!isPlain && shape.kind === previous?.kind) || shape.canOpenInPlace ? "\n" : "\n\n";
	if (previous === undefined) return shape;
	return { ...shape, text: `${separator}${shape.text}` };
}

export function proseMarkdown(prose: string, title: string) {
	const heading = title === "" ? "" : `**${title.replace(STRUCTURAL, "\\$&")}**`;
	const start: Shape[] = heading !== "" ? [{ kind: "plain", text: heading, canOpenInPlace: false }] : [];
	const text = prose
		.split("\n")
		.filter((l) => l !== "")
		.reduce<Shape[]>((shapes, l) => [...shapes, drawnLine(l, shapes.at(-1))], start)
		.map((s) => s.text)
		.join("");
	return text === "" ? "" : `${text}\n\n`;
}

// ---- Backoff and debug ----

export const CHECK_EVERY = 6;
export const CLEAR_AFTER_PROMPTS = 2;
export const SEEN_MAX = 50;
export const LOOKS_TO_SKIP_MAX = 16;
export const TYPED_PAST_FREE = 2;
export const ASKED_MS = 20_000;
export const CHECKS_KEPT = 3;

/** Checks to skip after `ignoredInARow` offers were typed past: 0, 0, 1, 2, 4, 8, then 16. */
export const looksToSkipAfter = (ignoredInARow: number) =>
	ignoredInARow <= TYPED_PAST_FREE ? 0 : Math.min(LOOKS_TO_SKIP_MAX, 2 ** (ignoredInARow - TYPED_PAST_FREE - 1));

/** Whether a check is due at this step: Claude Code's `index > 0 && index % 6 === 0`. */
export const isCheckStep = (step: number) => step > 0 && step % CHECK_EVERY === 0;

export type CheckOutcome = "shown" | "none" | "parse_failed" | "deduped" | "stale" | "aborted" | "api_error" | "error";

export interface Check {
	number: number;
	step: number;
	outcome: CheckOutcome;
	latencyMs: number;
	at: number;
}

export const checksWith = (checks: readonly Check[], check: Check) => [...checks, check].slice(-CHECKS_KEPT);

export function checkLineOf(check: Check) {
	const seconds = (check.latencyMs / 1000).toFixed(1);
	const clock = new Date(check.at).toTimeString().slice(0, 8);
	return `debug \xB7 check ${check.number} \xB7 step ${check.step} \xB7 ${check.outcome} \xB7 ${seconds}s \xB7 ${clock}`;
}

export const isDebugOn = (value: string | undefined) => value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export const storedCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

export const stringLines = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
