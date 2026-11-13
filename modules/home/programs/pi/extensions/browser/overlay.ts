// The tab's video as a picture-in-picture view in Pi's top-right corner, like a
// video call's: shown while Pi uses the browser, gone a few seconds after; one key
// (or a click) collapses it into a one-line pill, which it stays for the session
// until expanded again. It never takes the keyboard (a non-capturing overlay).
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { type CellSize, type Frame, layoutVideo, type VideoLayout } from "./video.ts";

export type OverlayMode = "hidden" | "full" | "pill";

/** When the view shows, and as what. Times are passed in, so it is a pure state machine. */
export class OverlayState {
	collapsed = false;
	private readonly calls = new Set<string>();
	private lingerUntil = 0;
	private peekUntil = 0;
	private readonly lingerMs: number;

	constructor(lingerMs = 4000) {
		this.lingerMs = lingerMs;
	}

	callStarted(id: string, _now: number) {
		this.calls.add(id);
	}

	callEnded(id: string, now: number) {
		if (!this.calls.delete(id)) return;
		this.lingerUntil = Math.max(this.lingerUntil, now + this.lingerMs);
	}

	/** Collapse or expand. With nothing on screen, the new state shows for a moment so the key does something visible. */
	toggle(now: number) {
		this.collapsed = !this.collapsed;
		this.peekUntil = now + this.lingerMs;
	}

	/** Pi stopped (Esc): gone at once, nothing lingers. The collapsed choice stays. */
	abort() {
		this.calls.clear();
		this.lingerUntil = 0;
		this.peekUntil = 0;
	}

	reset() {
		this.collapsed = false;
		this.calls.clear();
		this.lingerUntil = 0;
		this.peekUntil = 0;
	}

	/** A browser call is running: the dot is live. */
	live(): boolean {
		return this.calls.size > 0;
	}

	mode(now: number): OverlayMode {
		const present = this.calls.size > 0 || now < this.lingerUntil || now < this.peekUntil;
		if (!present) return "hidden";
		return this.collapsed ? "pill" : "full";
	}

	/** Frames are only wanted while the full video shows. */
	capturing(now: number): boolean {
		return this.mode(now) === "full";
	}

	/** When the mode next changes by itself (a timer to set), if it will. */
	nextChange(now: number): number | undefined {
		if (this.calls.size > 0) return undefined;
		const at = Math.max(this.lingerUntil, this.peekUntil);
		return at > now ? at : undefined;
	}
}

const KITTY = "\x1b_G";

/**
 * pi-tui drops an overlay's row where the chat's row under it holds an image (its
 * compositeTuiLine returns such a base line as is), so a screenshot in the chat
 * scrolled under the video would cut a hole through it. Over an image row, the
 * overlay's row is written after the image's placement, from its column.
 */
export function compositeOverImages(
	original: (base: string, overlay: string, startCol: number, overlayWidth: number, totalWidth: number) => string,
): (base: string, overlay: string, startCol: number, overlayWidth: number, totalWidth: number) => string {
	return (base, overlay, startCol, overlayWidth, totalWidth) => {
		if (!base.includes(KITTY)) return original(base, overlay, startCol, overlayWidth, totalWidth);
		return `${base}\x1b[0m\x1b[${startCol + 1}G${overlay}\x1b[0m`;
	};
}

export type OverlayTheme = { fg(color: string, text: string): string; bg(color: string, text: string): string };

export type RenderImage = (
	png: string,
	dims: { widthPx: number; heightPx: number },
	options: { maxWidthCells: number; maxHeightCells: number; imageId: number; moveCursor: false },
) => { sequence: string; rows: number; columns?: number } | null;

export type VideoOverlayOptions = {
	state: OverlayState;
	now?: () => number;
	frame: () => Frame | undefined;
	tab: () => { host?: string; title?: string };
	terminal: () => { columns: number; rows: number };
	cell: () => CellSize;
	theme: OverlayTheme;
	keyHint: string;
	imageId: number;
	/** pi-tui's renderImage: Pi re-places the images registered through it on its redraws. */
	renderImage: RenderImage;
	visibleWidth: (text: string) => number;
	truncate: (text: string, width: number) => string;
	onToggle: () => void;
};

/** The overlay's component: the bordered video, or the pill. */
export class VideoOverlay implements Component {
	private cache: { key: string; lines: string[] } | undefined;
	private readonly o: VideoOverlayOptions;

	constructor(options: VideoOverlayOptions) {
		this.o = options;
	}

	private now() {
		return (this.o.now ?? Date.now)();
	}

	/** What shows now: hidden, the pill (collapsed, or a terminal too small), or the full video. */
	view(): { mode: "hidden" } | { mode: "pill" } | { mode: "full"; layout: Extract<VideoLayout, { kind: "full" }> } {
		const mode = this.o.state.mode(this.now());
		if (mode === "hidden") return { mode };
		const layout = layoutVideo(this.o.frame(), this.o.terminal(), this.o.cell());
		if (mode === "pill" || layout.kind === "pill") return { mode: "pill" };
		return { mode: "full", layout };
	}

	/** The overlay's width in cells, for its options. */
	width(): number {
		const view = this.view();
		if (view.mode === "full") return view.layout.width;
		return Math.max(1, this.o.visibleWidth(this.pillText()));
	}

	private dot(): string {
		return this.o.theme.fg(this.o.state.live() ? "success" : "dim", "●");
	}

	private host(): string {
		return this.o.tab().host ?? "browser";
	}

	private pillText(): string {
		return ` ● ${this.host()}  ${this.o.keyHint} `;
	}

	render(width: number): string[] {
		const view = this.view();
		if (view.mode === "hidden") return [];
		const { theme, keyHint } = this.o;
		if (view.mode === "pill") {
			const host = this.o.truncate(this.host(), Math.max(4, width - this.o.visibleWidth(keyHint) - 6));
			return [theme.bg("selectedBg", ` ${this.dot()} ${theme.fg("text", host)}  ${theme.fg("dim", keyHint)} `)];
		}
		const { layout } = view;
		const frame = this.o.frame();
		const tab = this.o.tab();
		const key = [layout.width, layout.height, frame?.key ?? "", this.o.state.live(), tab.host, tab.title].join("|");
		if (this.cache?.key === key) return this.cache.lines;

		const border = (s: string) => theme.fg("borderMuted", s);
		const inner = layout.width - 2;
		// ╭─ ● host  title ───── key ─╮
		const right = ` ${keyHint} `;
		const room = inner - 2 - this.o.visibleWidth(right) - 1;
		const host = this.o.truncate(this.host(), Math.max(4, room - 3));
		const titleRoom = room - 3 - this.o.visibleWidth(host) - 2;
		const title = tab.title && tab.title !== tab.host && titleRoom >= 6 ? this.o.truncate(tab.title, titleRoom) : "";
		const left = ` ${this.dot()} ${theme.fg("text", host)}${title ? `  ${theme.fg("muted", title)}` : ""} `;
		const fill = Math.max(1, inner - 1 - this.o.visibleWidth(left) - this.o.visibleWidth(right) - 1);
		const top = border("╭─") + left + border("─".repeat(fill)) + theme.fg("dim", right) + border("─╮");

		const rows: string[] = [];
		const blank = " ".repeat(inner);
		let picture: string | undefined;
		if (frame) {
			const placed = this.o.renderImage(frame.png, { widthPx: frame.width, heightPx: frame.height }, { maxWidthCells: layout.imageColumns, maxHeightCells: layout.imageRows, imageId: this.o.imageId, moveCursor: false });
			// Above the chat's own images, where one scrolls under the video.
			if (placed) picture = placed.sequence.replace(/^\x1b_G/, "\x1b_Gz=1,");
		}
		for (let i = 0; i < layout.imageRows; i++) rows.push(border("│") + (i === 0 && picture ? picture : "") + blank + border("│"));
		if (!picture) {
			const text = this.o.truncate("Waiting for the first frame", inner - 2);
			const pad = Math.max(0, Math.floor((inner - this.o.visibleWidth(text)) / 2));
			const middle = Math.floor(layout.imageRows / 2);
			rows[middle] = border("│") + " ".repeat(pad) + theme.fg("dim", text) + " ".repeat(Math.max(0, inner - pad - this.o.visibleWidth(text))) + border("│");
		}
		const bottom = border(`╰${"─".repeat(inner)}╯`);
		const lines = [top, ...rows, bottom];
		this.cache = { key, lines };
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const view = this.view();
		// The pill, or the video's title bar.
		const onToggle = view.mode === "pill" || (view.mode === "full" && event.y === 0);
		if (!onToggle) return undefined;
		if (event.type === "click" && event.button === "left") this.o.onToggle();
		return event.type === "press" || event.type === "click" || event.type === "release" ? { handled: true } : undefined;
	}

	/** Pi may have cleared the terminal's images (resize, theme): the next render places the picture again. */
	invalidate() {
		this.cache = undefined;
	}
}
