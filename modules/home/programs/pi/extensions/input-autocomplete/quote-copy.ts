import type { TUI } from "@earendil-works/pi-tui";

// Escape sequences that draw nothing: SGR and other CSI, and OSC (links, OSC 133 marks).
const ESCAPE = /^(?:\x1b\[[0-9;:?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * The columns a markdown quote's left edge takes on a rendered line: the padding before
 * the border and every nested border, each as `border` (Pi's `quoteBorder("│ ")`, styled,
 * so a table's or a code block's plain `│` never matches). 0 on a line that isn't quoted.
 */
export function quoteEdge(line: string, border: string): number {
	let index = 0;
	let column = 0;
	let edge = 0;
	while (index < line.length) {
		if (line.startsWith(border, index)) {
			index += border.length;
			column += 2;
			edge = column;
			continue;
		}
		const escape = ESCAPE.exec(line.slice(index, index + 64));
		if (escape) {
			index += escape[0].length;
			continue;
		}
		if (line[index] !== " ") break;
		index += 1;
		column += 1;
	}
	return edge;
}

interface Columns {
	start: number;
	end: number;
}
// Both private in pi-tui's types. `getActiveSelectionText` is what Ctrl+C and Cmd+C copy; it
// cuts each selected line with `getSelectionColumns`, which the highlight uses too.
type SelectionColumns = (line: string, row: number, selection: unknown, ...rest: number[]) => Columns;

const HOOKED = Symbol.for("pi-extension-input-autocomplete.quote-copy");
type Hooked = { border: (() => string) | undefined };
type RendererInternals = {
	readonly mode: TUI["mode"];
	getSelectionColumns?: SelectionColumns;
	getActiveSelectionText?: () => string | undefined;
	[HOOKED]?: Hooked;
};

/**
 * Leaves a quote's border out of what the fullscreen renderer copies from a selection, so
 * Ctrl+C or Cmd+C gives the quoted text alone. The highlight is Pi's, border included.
 * Wrapped once per renderer; a reload only swaps `border`, undefined copies as Pi does.
 */
export function skipQuoteBorders(tui: TUI, border: (() => string) | undefined): void {
	const renderer = tui as unknown as RendererInternals;
	if (renderer.mode !== "fullscreen") return;
	const hooked = renderer[HOOKED];
	if (hooked) {
		hooked.border = border;
		return;
	}
	// Checked rather than trusted: a Pi release may rename either.
	const columns = renderer.getSelectionColumns;
	const text = renderer.getActiveSelectionText;
	if (!border || typeof columns !== "function" || typeof text !== "function") return;
	const state: Hooked = { border };
	renderer[HOOKED] = state;
	let copying: string | undefined;
	renderer.getActiveSelectionText = function () {
		copying = state.border?.();
		try {
			return text.call(this);
		} finally {
			copying = undefined;
		}
	};
	renderer.getSelectionColumns = function (line, row, selection, ...rest) {
		const range = columns.call(this, line, row, selection, ...rest);
		const edge = copying ? quoteEdge(line, copying) : 0;
		if (range.start >= edge) return range;
		return { start: edge, end: Math.max(edge, range.end) };
	};
}
