// Text pushed back toward the background, its colors kept. SGR 2 (faint) would be simpler, but
// Ghostty draws it as half-transparent text, which washes syntax colors out to gray: each
// true color is mixed toward the background instead, and the default color stands for `text`.
const SGR = /\x1b\[([\d;:]*)m/g;
// Inline images (kitty, iTerm2) are left as they are.
const IMAGE = /\x1b_G|\x1b\]1337;/;

export type Rgb = { r: number; g: number; b: number };

export interface Fade {
	/** The theme's text color, used where the line has none of its own. */
	text: Rgb;
	/** What the colors move toward: the terminal background, or near it. */
	background: Rgb;
	/** How far they move, 0 to 1. */
	amount: number;
}

const mix = (from: Rgb, to: Rgb, t: number): Rgb => ({
	r: Math.round(from.r + (to.r - from.r) * t),
	g: Math.round(from.g + (to.g - from.g) * t),
	b: Math.round(from.b + (to.b - from.b) * t),
});
const fg = ({ r, g, b }: Rgb) => `38;2;${r};${g};${b}`;

// One SGR sequence with its foreground colors faded: a true color mixed, a reset or default
// color replaced by the faded text color.
function fadeParams(params: string, fade: Fade, text: string): string {
	const parts = params === "" ? ["0"] : params.split(";");
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p === "38" && parts[i + 1] === "2" && i + 4 < parts.length) {
			const color = { r: Number(parts[i + 2]), g: Number(parts[i + 3]), b: Number(parts[i + 4]) };
			out.push(fg(mix(color, fade.background, fade.amount)));
			i += 4;
		} else if (p === "38" && parts[i + 1] === "5" && i + 2 < parts.length) {
			out.push(p, parts[i + 1]!, parts[i + 2]!);
			i += 2;
		} else if (p === "0" || p === "39") {
			out.push(p, text);
		} else out.push(p);
	}
	return out.join(";");
}

export function faint(line: string, fade: Fade): string {
	if (!line || IMAGE.test(line)) return line;
	const text = fg(mix(fade.text, fade.background, fade.amount));
	const body = line.replace(SGR, (code, params: string) => (params.includes(":") ? code : `\x1b[${fadeParams(params, fade, text)}m`));
	return `\x1b[${text}m${body}\x1b[39m`;
}

/** The fade for a theme, read from its escape sequences; undefined outside true color. */
export function fadeOf(theme: { getFgAnsi(token: string): string; appearance?: string }, amount: number): Fade | undefined {
	const rgb = (token: string) => {
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.getFgAnsi(token));
		return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : undefined;
	};
	const text = rgb("text");
	if (!text) return undefined;
	const dark = theme.appearance ? theme.appearance === "dark" : text.r + text.g + text.b > 384;
	// The theme's own background is unknown to Pi's tokens; a dark gray or a light one is close.
	const background = dark ? { r: 31, g: 36, b: 48 } : { r: 248, g: 249, b: 250 };
	return { text, background, amount };
}
