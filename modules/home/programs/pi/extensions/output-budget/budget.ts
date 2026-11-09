// A long bash output is kept to its head and tail in the model's context, the whole of
// it saved to a file. Pi's own limit (50KB, ~12k tokens) lets a single `cat` of a big
// file or a long log fill the context, where it stays for every later request. No Pi
// imports, so tests run without node_modules.

export const KEEP_ABOVE = 16_000;
export const HEAD = 4_000;
export const TAIL = 10_000;

const cutAtLine = (text: string, at: number, fromEnd: boolean) => {
	if (fromEnd) {
		const start = text.indexOf("\n", text.length - at);
		return start < 0 ? text.slice(-at) : text.slice(start + 1);
	}
	const end = text.lastIndexOf("\n", at);
	return end < at / 2 ? text.slice(0, at) : text.slice(0, end);
};

/** The text cut to its head and tail around a line naming where the rest is, or undefined when short. */
export function trimmed(text: string, savedTo: string): string | undefined {
	if (text.length <= KEEP_ABOVE) return undefined;
	const head = cutAtLine(text, HEAD, false);
	const tail = cutAtLine(text, TAIL, true);
	const omitted = text.slice(head.length, text.length - tail.length);
	const lines = omitted.split("\n").length - 1;
	return [
		head,
		`[… ${lines} lines (${omitted.length} characters) left out to save context; the whole output is in ${savedTo}. Read the part you need with rg or read's offset/limit …]`,
		tail,
	].join("\n");
}
