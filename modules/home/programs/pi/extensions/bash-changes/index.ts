// bash-changes for Pi: records which files each bash call changed in its git
// repository and shows their diff under the call, like edit and write do.
import { type ExtensionAPI, getLanguageFromPath, highlightCode, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bashChanges } from "./extension.ts";
import type { Paint, Tint } from "./render.ts";

// compact-tools' diff tint: this much of the change's color over the background.
const TINT = 0.17;

function rgbOf(ansi: string) {
	const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function fill(paint: Paint, tint: Tint, text: string, width: number): string {
	const theme = paint as Theme;
	const color = rgbOf(theme.getFgAnsi(tint === "added" ? "toolDiffAdded" : "toolDiffRemoved"));
	const textColor = rgbOf(theme.getFgAnsi("text"));
	if (!color || !textColor) return text;
	const dark = (theme as { appearance?: string }).appearance
		? (theme as { appearance?: string }).appearance === "dark"
		: textColor[0]! + textColor[1]! + textColor[2]! > 384;
	const pole = dark ? 0 : 255;
	const [r, g, b] = color.map((c) => Math.round(pole + (c - pole) * TINT));
	const open = `\x1b[48;2;${r};${g};${b}m`;
	// Highlighting resets (0) would end the tint mid-row: it is opened again after each.
	const body = text.replace(/\x1b\[0?m/g, (code) => code + open);
	return `${open}${body}${" ".repeat(Math.max(0, width - visibleWidth(text)))}\x1b[49m`;
}

export default function (pi: ExtensionAPI) {
	bashChanges(pi, {
		highlight: highlightCode,
		language: getLanguageFromPath,
		wrap: wrapTextWithAnsi,
		expandHint: () => keyHint("app.tools.expand", "to show all changes"),
		fill,
	});
}
