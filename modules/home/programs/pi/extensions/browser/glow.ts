// Frames that caught the extension's orange "Claude is working" glow, so the video can drop them.
//
// Each screenshot hides the glow, captures, and shows it again. Two in flight, 200 ms
// apart, keep the video's own screenshots from catching one another's "show", but the
// extension also shows the glow when a call of Pi's starts or ends, or when one of Pi's
// own calls takes its screenshots (a batch's scrolls), and a capture of ours can land
// then: 14 of 116 shots of the live run had it. The glow is an orange band along the
// page's four edges, so a frame whose outer edges are warmer than just inside, on at
// least three edges, is dropped.
import { inflateSync } from "node:zlib";

export type Pixels = { width: number; height: number; channels: number; data: Uint8Array };

/** The pixels of an 8-bit, non-interlaced RGB or RGBA PNG (what Pi's photon writes); anything else is undefined. */
export function decodePng(png: Uint8Array): Pixels | undefined {
	const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Buffer[] = [];
	for (let at = 8; at + 8 <= buf.length; ) {
		const length = buf.readUInt32BE(at);
		const type = buf.toString("latin1", at + 4, at + 8);
		const data = buf.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
			if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return undefined;
			channels = color === 6 ? 4 : 3;
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	if (!width || !height || !channels || idat.length === 0) return undefined;
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return undefined;
	}
	const stride = width * channels;
	if (raw.length < height * (stride + 1)) return undefined;
	const out = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		const prev = row - stride;
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? out[row + i - channels]! : 0;
			const b = y > 0 ? out[prev + i]! : 0;
			const c = i >= channels && y > 0 ? out[prev + i - channels]! : 0;
			let p: number;
			switch (filter) {
				case 1:
					p = a;
					break;
				case 2:
					p = b;
					break;
				case 3:
					p = (a + b) >> 1;
					break;
				case 4: {
					const pa = Math.abs(b - c);
					const pb = Math.abs(a - c);
					const pc = Math.abs(a + b - 2 * c);
					p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
					break;
				}
				default:
					p = 0;
			}
			out[row + i] = (raw[src + i]! + p) & 255;
		}
	}
	return { width, height, channels, data: out };
}

/** How much redder than its green and blue a strip of the frame is, on average. */
function warmth(px: Pixels, x0: number, y0: number, x1: number, y1: number): number {
	let sum = 0;
	let n = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const i = (y * px.width + x) * px.channels;
			sum += px.data[i]! - (px.data[i + 1]! + px.data[i + 2]!) / 2;
			n++;
		}
	return n ? sum / n : 0;
}

/** The extension's glow: on at least three edges, the outermost strip is warm, and warmer than a strip a little inside. */
export function showsGlow(px: Pixels): boolean {
	const { width: w, height: h } = px;
	const outer = (size: number) => Math.max(1, Math.floor(size * 0.006));
	const inner = (size: number) => [Math.round(size * 0.025), Math.max(Math.round(size * 0.025) + 1, Math.round(size * 0.035))] as const;
	const [xa, xb] = inner(w);
	const [ya, yb] = inner(h);
	const along = { x0: Math.round(w * 0.1), x1: Math.round(w * 0.9), y0: Math.round(h * 0.1), y1: Math.round(h * 0.9) };
	const edges = [
		[warmth(px, 0, along.y0, outer(w), along.y1), warmth(px, xa, along.y0, xb, along.y1)],
		[warmth(px, w - outer(w), along.y0, w, along.y1), warmth(px, w - xb, along.y0, w - xa, along.y1)],
		[warmth(px, along.x0, 0, along.x1, outer(h)), warmth(px, along.x0, ya, along.x1, yb)],
		[warmth(px, along.x0, h - outer(h), along.x1, h), warmth(px, along.x0, h - yb, along.x1, h - ya)],
	];
	return edges.filter(([o, i]) => o! >= 10 && o! >= i! + 10).length >= 3;
}
