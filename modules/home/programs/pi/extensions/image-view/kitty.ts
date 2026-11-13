// Kitty graphics through Unicode placeholders: the image is uploaded once as a
// virtual placement, and each of its cells is a U+10EEEE character whose
// foreground color carries the image id. Unlike a direct placement (Pi's
// `Image`), the picture is then plain text to Pi's renderer: several fit on one
// line, they scroll and clip like text, and a click on them lands on cells.

const PLACEHOLDER = String.fromCodePoint(0x10eeee);
// The first 64 row/column diacritics of the protocol (kitty's gen/rowcolumn-diacritics.txt):
// tiles are at most 6 rows, the browser extension's live view up to 64.
const DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
	0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
	0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
	0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
];
/** The tallest picture placeholders can address. */
export const KITTY_MAX_ROWS = DIACRITICS.length;
const CHUNK = 4096;

/** An id that is always sent as a 24-bit foreground color (ids under 256 would need the 256-color form). */
export function allocateKittyId(): number {
	return 256 + Math.floor(Math.random() * (0xffffff - 256));
}

/** Uploads a PNG as a virtual placement `columns` × `rows` cells, quietly (q=2: no replies on stdin). */
export function kittyTransmit(png: string, id: number, columns: number, rows: number): string {
	const head = `a=T,U=1,f=100,q=2,i=${id},c=${columns},r=${rows}`;
	if (png.length <= CHUNK) return `\x1b_G${head};${png}\x1b\\`;
	let out = "";
	for (let at = 0; at < png.length; at += CHUNK) {
		const more = at + CHUNK < png.length ? 1 : 0;
		out += `\x1b_G${at === 0 ? `${head},` : ""}m=${more};${png.slice(at, at + CHUNK)}\x1b\\`;
	}
	return out;
}

/**
 * Uploads and places a PNG `columns` × `rows` cells at the cursor, without moving it (C=1),
 * as Pi's own Image does: one line carries the sequence, the next `rows - 1` stay empty.
 * Sending it again under the same id replaces the picture in place.
 */
export function kittyPlace(png: string, id: number, columns: number, rows: number): string {
	const head = `a=T,f=100,q=2,C=1,i=${id},c=${columns},r=${rows}`;
	if (png.length <= CHUNK) return `\x1b_G${head};${png}\x1b\\`;
	let out = "";
	for (let at = 0; at < png.length; at += CHUNK) {
		const more = at + CHUNK < png.length ? 1 : 0;
		out += `\x1b_G${at === 0 ? `${head},` : ""}m=${more};${png.slice(at, at + CHUNK)}\x1b\\`;
	}
	return out;
}

export function kittyDelete(id: number): string {
	return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

/** The placeholder text of each row; later cells of a row take their column from the one before. */
export function kittyRows(id: number, columns: number, rows: number): string[] {
	const color = `\x1b[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`;
	return Array.from({ length: rows }, (_, row) => {
		const first = PLACEHOLDER + String.fromCodePoint(DIACRITICS[row] ?? DIACRITICS[0]!) + String.fromCodePoint(DIACRITICS[0]!);
		return `${color}${first}${PLACEHOLDER.repeat(columns - 1)}\x1b[39m`;
	});
}
