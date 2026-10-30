// Kitty graphics through Unicode placeholders: the image is uploaded once as a
// virtual placement, and each of its cells is a U+10EEEE character whose
// foreground color carries the image id. Unlike a direct placement (Pi's
// `Image`), the picture is then plain text to Pi's renderer: several fit on one
// line, they scroll and clip like text, and a click on them lands on cells.

const PLACEHOLDER = String.fromCodePoint(0x10eeee);
// The first row/column diacritics of the protocol; tiles are at most 6 rows.
const DIACRITICS = [0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a];
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
