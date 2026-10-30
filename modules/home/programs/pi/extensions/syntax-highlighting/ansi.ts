// Splicing styled text into lines another renderer drew. Positions count
// visible UTF-16 code units, not terminal columns: both sides of a splice are
// the same text, so they agree without measuring widths.

// CSI, OSC (BEL or ST terminated), APC/DCS/PM/SOS strings, then two-byte escapes.
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[_PX^][^\x1b]*\x1b\\|[@-Z\\-_])/y;
const SGR = /^\x1b\[[0-9;:]*m$/;

export const FG_RESET = "\x1b[39m";
// Cancels the attributes a host renderer may have set (bold titles, italics)
// without touching the background: Pi's tool box paints one under the row.
const ATTRIBUTES_OFF = "\x1b[22;23;24;27;29m";

type Piece = { escape: string } | { text: string };

function* pieces(line: string): Generator<Piece> {
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			ESCAPE.lastIndex = i;
			const match = ESCAPE.exec(line);
			if (match) {
				yield { escape: match[0] };
				i += match[0].length;
				continue;
			}
		}
		let end = line.indexOf("\x1b", i + 1);
		if (end < 0) end = line.length;
		yield { text: line.slice(i, end) };
		i = end;
	}
}

export function stripAnsi(line: string): string {
	let out = "";
	for (const piece of pieces(line)) if ("text" in piece) out += piece.text;
	return out;
}

export function escapes(line: string): string[] {
	const out: string[] = [];
	for (const piece of pieces(line)) if ("escape" in piece) out.push(piece.escape);
	return out;
}

const isSgr = (escape: string) => SGR.test(escape);

// The visible range [start, end) of a styled line, opened with the styles in
// effect at `start` so it renders the same on its own.
export function sliceVisible(line: string, start: number, end: number): string {
	let carried = "";
	let out = "";
	let at = 0;
	for (const piece of pieces(line)) {
		if ("escape" in piece) {
			if (at < start) {
				if (isSgr(piece.escape)) carried += piece.escape;
			} else if (at < end) out += piece.escape;
			continue;
		}
		const from = Math.max(start, at);
		const to = Math.min(end, at + piece.text.length);
		if (from < to) out += piece.text.slice(from - at, to - at);
		at += piece.text.length;
		if (at >= end) break;
	}
	return carried + out;
}

// Replaces the visible range [start, end) of `line` with `replacement`, then
// restores the styles `line` had at `end` so the rest of it looks unchanged.
export function spliceVisible(line: string, start: number, end: number, replacement: string): string {
	let before = "";
	let after = "";
	let replayed = "";
	let kept = "";
	let at = 0;
	for (const piece of pieces(line)) {
		if ("escape" in piece) {
			if (at < start) before += piece.escape;
			else if (at < end) {
				if (isSgr(piece.escape)) replayed += piece.escape;
				// Hyperlinks and other non-style sequences stay, after the replacement.
				else kept += piece.escape;
			} else after += piece.escape;
			continue;
		}
		const text = piece.text;
		const pieceEnd = at + text.length;
		if (at < start) before += text.slice(0, Math.min(text.length, start - at));
		if (pieceEnd > end) after += text.slice(Math.max(0, end - at));
		at = pieceEnd;
	}
	const sgrBefore = escapes(before).filter(isSgr).join("");
	return `${before}${ATTRIBUTES_OFF}${replacement}${FG_RESET}${ATTRIBUTES_OFF}${sgrBefore}${replayed}${kept}${after}`;
}
