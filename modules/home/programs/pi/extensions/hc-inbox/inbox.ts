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
