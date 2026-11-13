// The live view of the tab a browser tool acts on: screenshots taken while the
// tool runs (FramePump), placed across the tool's row with the Kitty graphics
// protocol (LiveView), the last one left as a still once the tool ends.
import { allocateKittyId, KITTY_MAX_ROWS, kittyDelete, kittyPlace } from "../image-view/kitty.ts";

export type Frame = {
	/** Base64 PNG, as kitty's f=100 wants it. */
	png: string;
	width: number;
	height: number;
	/** Equal keys mean the same picture (a hash of the screenshot). */
	key: string;
};

export type FramePumpOptions = {
	capture: () => Promise<Frame | null>;
	onFrame: (frame: Frame) => void;
	/** The shortest time between two captures' starts: 333 ms is 3 fps. */
	minIntervalMs?: number;
	/** The most of the wall time spent capturing; slow captures space out further. */
	maxDuty?: number;
	errorBackoffMs?: number;
};

/** Takes screenshots one at a time, at most a few per second, and keeps the last new one. */
export class FramePump {
	frame: Frame | undefined;
	captures = 0;
	private running = false;
	private loop: Promise<void> | undefined;
	private wake: (() => void) | undefined;
	private readonly options: FramePumpOptions;

	constructor(options: FramePumpOptions) {
		this.options = options;
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.loop = this.run();
	}

	/** Stops after the capture in flight, if any. */
	async stop() {
		this.running = false;
		this.wake?.();
		await this.loop;
	}

	/** One capture now, outside the loop (the still taken once the tool is done). */
	async captureOnce(): Promise<Frame | undefined> {
		await this.take().catch(() => {});
		return this.frame;
	}

	private async take() {
		this.captures++;
		const frame = await this.options.capture();
		if (frame && frame.key !== this.frame?.key) {
			this.frame = frame;
			this.options.onFrame(frame);
		}
	}

	private async run() {
		const minInterval = this.options.minIntervalMs ?? 333;
		const maxDuty = this.options.maxDuty ?? 0.5;
		while (this.running) {
			const started = Date.now();
			let wait: number;
			try {
				await this.take();
				const took = Date.now() - started;
				wait = Math.max(minInterval, took / maxDuty) - took;
			} catch {
				wait = this.options.errorBackoffMs ?? 1000;
			}
			if (!this.running) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.max(0, wait));
				this.wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.wake = undefined;
		}
	}
}

export type CellSize = { widthPx: number; heightPx: number };

/** The cells a frame takes: the whole width when the rows allow, else narrower to keep its aspect. */
export function fitFrame(size: { width: number; height: number }, columns: number, cell: CellSize, maxRows: number): { columns: number; rows: number } {
	const budget = Math.max(1, Math.min(maxRows, KITTY_MAX_ROWS));
	const rowsFor = (c: number) => Math.max(1, Math.round((c * cell.widthPx * size.height) / (size.width * cell.heightPx)));
	let rows = rowsFor(columns);
	if (rows > budget) {
		rows = budget;
		columns = Math.max(1, Math.round((rows * cell.heightPx * size.width) / (size.height * cell.widthPx)));
	}
	return { columns, rows };
}

export type LiveViewOptions = {
	kitty: () => boolean;
	write: (sequence: string) => void;
	cell: () => CellSize;
	maxRows: () => number;
	allocateId?: () => number;
	/**
	 * pi-tui's renderImage. Pi's fullscreen renderer deletes every placement on an image
	 * redraw and puts back, or crops when scrolled half out, only the images registered
	 * through it, so frames must go through it to survive redraws and scrolling.
	 */
	renderImage?: (
		png: string,
		dims: { widthPx: number; heightPx: number },
		options: { maxWidthCells: number; maxHeightCells: number; imageId: number; moveCursor: false },
	) => { sequence: string; rows: number } | null;
};

/**
 * A component that draws the current frame, placed directly as Pi's own Image is:
 * its first line carries the upload, the other lines stay empty. Unicode
 * placeholders (image-view's tiles) showed the line gap between rows in Herdr,
 * striping the frame. A new frame or size changes that line, so Pi redraws it,
 * and the same id replaces the picture in place.
 */
export class LiveView {
	private frame: Frame | undefined;
	private caption = "";
	private id: number | undefined;
	private lines: { key: string; width: number; rows: string[] } | undefined;
	private readonly options: LiveViewOptions;

	constructor(options: LiveViewOptions) {
		this.options = options;
	}

	setFrame(frame: Frame | undefined) {
		this.frame = frame;
	}

	setCaption(caption: string) {
		this.caption = caption;
	}

	render(width: number): string[] {
		const frame = this.frame;
		if (!frame) return this.caption ? [this.caption] : [];
		if (!this.options.kitty()) {
			const size = `${frame.width}×${frame.height}`;
			return [[this.caption, `screen ${size}`].filter(Boolean).join(" · ")];
		}
		const cached = this.lines;
		if (cached && cached.key === frame.key && cached.width === width) return cached.rows;
		const { columns, rows } = fitFrame(frame, Math.max(1, width), this.options.cell(), this.options.maxRows());
		this.id ??= (this.options.allocateId ?? allocateKittyId)();
		let out: string[];
		const placed = this.options.renderImage?.(frame.png, { widthPx: frame.width, heightPx: frame.height }, { maxWidthCells: columns, maxHeightCells: rows, imageId: this.id, moveCursor: false });
		if (placed) out = [placed.sequence, ...Array.from({ length: placed.rows - 1 }, () => "")];
		else out = [kittyPlace(frame.png, this.id, columns, rows), ...Array.from({ length: rows - 1 }, () => "")];
		this.lines = { key: frame.key, width, rows: out };
		return out;
	}

	/** Pi may have cleared the terminal's images (resize, theme): the next render places it again. */
	invalidate() {
		this.lines = undefined;
	}

	dispose() {
		if (this.id !== undefined) this.options.write(kittyDelete(this.id));
		this.id = undefined;
		this.lines = undefined;
	}
}
