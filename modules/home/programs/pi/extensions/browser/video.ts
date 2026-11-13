// The tab's video: screenshots taken back to back through the bridge (FrameScheduler)
// and the size of the picture-in-picture view that shows them (layoutVideo).
//
// The extension has no stream a client can reach (its own viewer, `chat_tab_frame`,
// answers claude.ai's page only), so the video is screenshots. Each takes ~400 ms
// over the bridge, ~185 ms of it the round trip, and the extension runs several at
// once: on this Mac one in flight gave 2.3 fps, three 6 fps, four 8 fps.

export type Frame = {
	/** Base64 PNG, as kitty's f=100 wants it. */
	png: string;
	width: number;
	height: number;
	/** Equal keys mean the same picture (a hash of the screenshot). */
	key: string;
};

export type FrameSchedulerOptions = {
	capture: (signal: AbortSignal) => Promise<Frame | null>;
	onFrame: (frame: Frame) => void;
	maxInFlight?: number;
	/** The shortest time between two requests' starts, so frames come evenly. */
	minGapMs?: number;
	errorBackoffMs?: number;
};

/** Keeps a few captures in flight while active, and shows each new picture in order. */
export class FrameScheduler {
	requests = 0;
	frames = 0;
	/** Same picture as the one shown. */
	skipped = 0;
	/** Landed after a newer one was shown. */
	stale = 0;
	private active = false;
	private stopped = false;
	private inFlight = 0;
	private seq = 0;
	private shownSeq = 0;
	private lastKey: string | undefined;
	private lastStart = Number.NEGATIVE_INFINITY;
	private backoffUntil = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly controllers = new Set<AbortController>();
	private readonly options: FrameSchedulerOptions;

	constructor(options: FrameSchedulerOptions) {
		this.options = options;
	}

	get running(): boolean {
		return this.active && !this.stopped;
	}

	/** Runs or pauses. A pause starts nothing new and shows nothing still in flight. */
	setActive(active: boolean) {
		if (this.stopped || this.active === active) return;
		this.active = active;
		if (active) this.fill();
		else this.clearTimer();
	}

	/** For good: aborts what is in flight. */
	stop() {
		this.stopped = true;
		this.active = false;
		this.clearTimer();
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
	}

	private clearTimer() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private fill() {
		if (!this.running) return;
		this.clearTimer();
		const max = this.options.maxInFlight ?? 3;
		const gap = this.options.minGapMs ?? 100;
		while (this.inFlight < max) {
			const wait = Math.max(this.lastStart + gap, this.backoffUntil) - Date.now();
			if (wait > 0) {
				this.timer = setTimeout(() => {
					this.timer = undefined;
					this.fill();
				}, wait);
				return;
			}
			this.launch();
		}
	}

	private launch() {
		const seq = ++this.seq;
		const controller = new AbortController();
		this.controllers.add(controller);
		this.lastStart = Date.now();
		this.inFlight++;
		this.requests++;
		this.options
			.capture(controller.signal)
			.then(
				(frame) => {
					if (!this.running || !frame) return;
					if (seq < this.shownSeq) {
						this.stale++;
						return;
					}
					this.shownSeq = seq;
					if (frame.key === this.lastKey) {
						this.skipped++;
						return;
					}
					this.lastKey = frame.key;
					this.frames++;
					this.options.onFrame(frame);
				},
				() => {
					this.backoffUntil = Date.now() + (this.options.errorBackoffMs ?? 1000);
				},
			)
			.finally(() => {
				this.inFlight--;
				this.controllers.delete(controller);
				this.fill();
			});
	}
}

export type CellSize = { widthPx: number; heightPx: number };

export type VideoLayout =
	| {
			kind: "full";
			/** The overlay's cells, border included. */
			width: number;
			height: number;
			imageColumns: number;
			imageRows: number;
			/** The picture's width in pixels: what to capture. */
			pixelWidth: number;
	  }
	| { kind: "pill" };

const MIN_COLUMNS = 70;
const MIN_ROWS = 18;
const WIDTH_SHARE = 0.4;
// The video keeps to the top half, clear of the editor and the footer.
const HEIGHT_SHARE = 0.5;
const MAX_PIXEL_WIDTH = 1000;

/** The video's size: ~40% of the width, the page's aspect, at most half the height; else the pill. */
export function layoutVideo(size: { width: number; height: number } | undefined, terminal: { columns: number; rows: number }, cell: CellSize): VideoLayout {
	if (terminal.columns < MIN_COLUMNS || terminal.rows < MIN_ROWS) return { kind: "pill" };
	const aspect = size && size.width > 0 ? size.height / size.width : 10 / 16;
	let columns = Math.round(terminal.columns * WIDTH_SHARE) - 2;
	let rows = Math.max(1, Math.round((columns * cell.widthPx * aspect) / cell.heightPx));
	const maxRows = Math.floor(terminal.rows * HEIGHT_SHARE) - 2;
	if (rows > maxRows) {
		rows = maxRows;
		columns = Math.max(1, Math.round((rows * cell.heightPx) / (aspect * cell.widthPx)));
	}
	if (rows < 4 || columns < 20) return { kind: "pill" };
	return { kind: "full", width: columns + 2, height: rows + 2, imageColumns: columns, imageRows: rows, pixelWidth: Math.min(MAX_PIXEL_WIDTH, columns * cell.widthPx) };
}
