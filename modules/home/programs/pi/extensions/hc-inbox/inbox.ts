// What `hc send` types into a Pi terminal: a bracketed paste of the message, tagged
// <hc from="t3 lead" reach="…">…</hc> when notes are on, then Enter as its own input
// about 200 ms later.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const TAGGED = /^<hc from="[^"]*"(?: [a-z-]+="[^"]*")*>[\s\S]*<\/hc>$/;
// Long enough for hc's Enter on a loaded machine, short enough that the user's own
// next Enter is theirs.
export const ENTER_WINDOW_MS = 1000;

export function hcMessageOf(data: string): string | undefined {
	if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return undefined;
	const text = data.slice(PASTE_START.length, -PASTE_END.length).replace(/\r\n?/g, "\n").trim();
	return TAGGED.test(text) ? text : undefined;
}

const isEnter = (data: string) => data === "\r" || data === "\n" || data === "\x1b[13u";

export type Taken = { consume: true; message?: string } | undefined;

/** Takes hc's paste, returning its message, and the Enter that follows it. */
export class Inbox {
	private enterUntil: number | undefined;

	input(data: string, now: number): Taken {
		const message = hcMessageOf(data);
		if (message) {
			this.enterUntil = now + ENTER_WINDOW_MS;
			return { consume: true, message };
		}
		if (!isEnter(data)) return undefined;
		// Only the first Enter after the paste can be hc's.
		const expected = this.enterUntil !== undefined && now <= this.enterUntil;
		this.enterUntil = undefined;
		return expected ? { consume: true } : undefined;
	}
}

type Delivery = "now" | "steer";

/**
 * Messages to deliver, held while a compaction runs: Pi refuses prompts then, and an
 * extension's refused message is lost.
 */
export class Outbox {
	private held: string[] = [];
	private compacting = false;

	private readonly send: (message: string, delivery: Delivery) => void;
	private readonly idle: () => boolean;

	constructor(send: (message: string, delivery: Delivery) => void, idle: () => boolean) {
		this.send = send;
		this.idle = idle;
	}

	push(message: string) {
		if (this.compacting) this.held.push(message);
		else this.send(message, this.idle() ? "now" : "steer");
	}

	compactionStarted() {
		this.compacting = true;
	}

	compactionEnded() {
		this.compacting = false;
		const held = this.held;
		this.held = [];
		for (const message of held) this.push(message);
	}
}

// A worker's report pasted whole stays in the receiver's context for the rest of the
// chat (relayed reports of 2–5k characters each filled an orchestrator to 760k). The
// head carries the gist; the rest is a file read away.
export const SHORTEN_ABOVE = 3000;
export const HEAD_CHARS = 1500;
const PARTS = /^(<hc [^>]*>)([\s\S]*)(<\/hc>)$/;

export function needsShortening(message: string): boolean {
	const body = PARTS.exec(message)?.[2];
	return body !== undefined && body.length > SHORTEN_ABOVE;
}

/** The message with its body cut at a line break near HEAD_CHARS, and where the rest is. */
export function shorten(message: string, savedTo: string): string {
	const parts = PARTS.exec(message);
	if (!parts || !needsShortening(message)) return message;
	const [, open, body, close] = parts;
	const lineEnd = body.lastIndexOf("\n", HEAD_CHARS);
	const head = body.slice(0, lineEnd > HEAD_CHARS / 2 ? lineEnd : HEAD_CHARS);
	const rest = body.length - head.length;
	return `${open}${head}\n[… ${rest} more characters; the whole message is in ${savedTo}]${close}`;
}
