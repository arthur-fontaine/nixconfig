// A paste right after a paste marker joins it, as in Claude Code. No Pi imports.

// The draft as one string, the cursor an offset into it.
export interface Draft {
	text: string;
	cursor: number;
}

// Pi's Editor's paste registry: marker ids to their content, and the last id given.
export interface Pastes {
	contents: Map<number, string>;
	counter: number;
}

const MARKER_BEFORE_CURSOR = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]$/u;

// Pi's own label and threshold for a paste's marker.
export function marker(id: number, content: string): string {
	const lines = content.split("\n").length;
	return lines > 10 ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${content.length} chars]`;
}

/**
 * The draft and pastes once the paste that turned `before` into `after` joins
 * the marker right before the cursor: its content goes on the end of that
 * marker's, as is, and no second marker is left. Undefined when the cursor
 * wasn't right after a marker, so Pi's paste stands.
 */
export function joinPaste(before: Draft, after: Draft, pastesBefore: Pastes, pastesAfter: Pastes): { draft: Draft; pastes: Pastes } | undefined {
	const head = before.text.slice(0, before.cursor);
	const tail = before.text.slice(before.cursor);
	const match = MARKER_BEFORE_CURSOR.exec(head);
	const id = match ? Number(match[1]) : Number.NaN;
	const first = pastesAfter.contents.get(id);
	if (!match || first === undefined) return undefined;
	const length = after.text.length - before.text.length;
	if (length <= 0 || !after.text.startsWith(head) || !after.text.endsWith(tail)) return undefined;
	const inserted = after.text.slice(head.length, head.length + length);

	const contents = new Map(pastesAfter.contents);
	let counter = pastesAfter.counter;
	let added = inserted;
	// A long paste came in as a marker of its own: its content is taken back from it.
	if (counter > pastesBefore.counter) {
		const own = contents.get(counter);
		if (own === undefined || inserted !== marker(counter, own)) return undefined;
		added = own;
		contents.delete(counter);
		counter = pastesBefore.counter;
	}
	const joined = first + added;
	contents.set(id, joined);
	const start = head.slice(0, head.length - match[0].length) + marker(id, joined);
	return { draft: { text: start + tail, cursor: start.length }, pastes: { contents, counter } };
}
