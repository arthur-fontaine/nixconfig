// Turns image files into tile rows: half blocks scaled by sips, or Kitty
// Unicode placeholders over a PNG Pi converts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { halfBlockRows, parseBmp } from "./halfblock.ts";
import { allocateKittyId, kittyDelete, kittyRows, kittyTransmit } from "./kitty.ts";
import type { Cells, Size } from "./layout.ts";
import type { ImageBlock } from "./sources.ts";
import type { Paint } from "./tiles.ts";

const run = promisify(execFile);
// Enough to reach a JPEG's frame header, which can follow large EXIF blocks.
const HEADER_BYTES = 64 * 1024;
// Kitty scales the upload to the tile; a tile is at most 32 cells wide.
const KITTY_MAX_PX = 640;
const MIME_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function mimeOf(bytes: Uint8Array): string | undefined {
	const hex = Buffer.from(bytes.subarray(0, 12)).toString("hex");
	if (hex.startsWith("89504e47")) return "image/png";
	if (hex.startsWith("ffd8ff")) return "image/jpeg";
	if (hex.startsWith("47494638")) return "image/gif";
	if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "image/webp";
	return undefined;
}

/** Pixel size from the file's header, or null when it can't be read. */
export async function imageSize(path: string): Promise<Size | null> {
	try {
		const file = await open(path);
		try {
			const head = Buffer.alloc(HEADER_BYTES);
			const { bytesRead } = await file.read(head, 0, HEADER_BYTES, 0);
			const bytes = head.subarray(0, bytesRead);
			const mime = mimeOf(bytes);
			const dims = mime ? getImageDimensions(bytes.toString("base64"), mime) : null;
			return dims ? { width: dims.widthPx, height: dims.heightPx } : null;
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

export function blockSize(image: ImageBlock): Size | null {
	const dims = getImageDimensions(image.data, image.mimeType);
	return dims ? { width: dims.widthPx, height: dims.heightPx } : null;
}

/**
 * A file for an image that only exists as bytes (an MCP screenshot, a photo sent
 * from the apps), so sips can scale it and Quick Look can open it. Named by
 * content, so drawing it again doesn't write it again.
 */
export function saveImage(image: ImageBlock): string {
	const dir = join(tmpdir(), "pi-image-view");
	const bytes = Buffer.from(image.data, "base64");
	const name = `${createHash("sha256").update(bytes).digest("hex")}.${MIME_EXTENSIONS[image.mimeType] ?? "img"}`;
	const path = join(dir, name);
	if (!existsSync(path)) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, bytes);
	}
	return path;
}

type Painter = { paint: Paint; invalidate(): void; dispose(): void };

// Pi calls render synchronously, so a picture not made yet draws "…" and the
// painter asks for a render once it is.
export class HalfBlocks implements Painter {
	private readonly rows = new Map<string, string[] | null>();
	private readonly queue = new Map<string, { path: string; cells: Cells }>();
	private isRunning = false;
	private dir: string | undefined;
	private count = 0;

	constructor(private readonly onReady: () => void) {}

	paint: Paint = (path, cells) => {
		const key = `${path}:${cells.columns}x${cells.rows}`;
		if (this.rows.has(key)) return this.rows.get(key);
		this.queue.set(key, { path, cells });
		void this.drain();
		return undefined;
	};

	invalidate(): void {}

	dispose(): void {
		this.queue.clear();
		if (this.dir) rmSync(this.dir, { recursive: true, force: true });
		this.dir = undefined;
	}

	private async drain() {
		if (this.isRunning) return;
		this.isRunning = true;
		try {
			for (const [key, { path, cells }] of this.queue) {
				this.queue.delete(key);
				this.rows.set(key, await this.convert(path, cells).catch(() => null));
				this.onReady();
			}
		} finally {
			this.isRunning = false;
		}
	}

	private async convert(path: string, { columns, rows }: Cells): Promise<string[] | null> {
		this.dir ??= mkdtempSync(join(tmpdir(), "pi-image-view-"));
		const out = join(this.dir, `${++this.count}-${columns}x${rows}.bmp`);
		try {
			// -z takes the height first.
			await run("/usr/bin/sips", ["-s", "format", "bmp", "-z", String(rows * 2), String(columns), path, "--out", out]);
			const bitmap = parseBmp(await readFile(out));
			return bitmap === null ? null : halfBlockRows(bitmap, columns, rows);
		} finally {
			await rm(out, { force: true });
		}
	}
}

export class KittyPictures implements Painter {
	private readonly pngs = new Map<string, string | null>();
	private readonly ids = new Map<string, number>();
	private readonly sent = new Set<number>();
	private readonly loading = new Set<string>();
	private screen = "";

	constructor(
		private readonly onReady: () => void,
		private readonly write: (sequence: string) => void,
		private readonly screenSize: () => string,
	) {}

	paint: Paint = (path, { columns, rows }) => {
		// Pi redraws everything after a resize, deleting the terminal's images first.
		const screen = this.screenSize();
		if (screen !== this.screen) this.sent.clear();
		this.screen = screen;
		const png = this.pngs.get(path);
		if (png === undefined) {
			void this.load(path);
			return undefined;
		}
		if (png === null) return null;
		const key = `${path}:${columns}x${rows}`;
		let id = this.ids.get(key);
		if (id === undefined) this.ids.set(key, (id = allocateKittyId()));
		if (!this.sent.has(id)) {
			this.write(kittyTransmit(png, id, columns, rows));
			this.sent.add(id);
		}
		return kittyRows(id, columns, rows);
	};

	// Pi invalidates components after new cell metrics or a theme change, when
	// it may have cleared the terminal's images, so the next render uploads them again.
	invalidate(): void {
		this.sent.clear();
	}

	dispose(): void {
		for (const id of this.sent) this.write(kittyDelete(id));
		this.sent.clear();
	}

	private async load(path: string) {
		if (this.loading.has(path)) return;
		this.loading.add(path);
		try {
			const bytes = await readFile(path);
			const mime = mimeOf(bytes);
			let png: string | null = null;
			if (mime) {
				const resized = await resizeImage(bytes, mime, { maxWidth: KITTY_MAX_PX, maxHeight: KITTY_MAX_PX }).catch(() => null);
				const image = resized ?? { data: bytes.toString("base64"), mimeType: mime };
				png = image.mimeType === "image/png" ? image.data : ((await convertToPng(image.data, image.mimeType).catch(() => null))?.data ?? null);
			}
			this.pngs.set(path, png);
		} catch {
			this.pngs.set(path, null);
		} finally {
			this.loading.delete(path);
		}
		this.onReady();
	}
}
