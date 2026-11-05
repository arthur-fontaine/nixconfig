// Messages from the Claude apps that wait for the run to end: the apps send a message typed
// during a run with priority `later`, list it as waiting, and offer Send now and cancel on it.

export type Waiting<C> = { eventId: string; uuid?: string; content: C };

// Send now (an interrupt with send_now): as Claude Code, the waiting messages join the
// running turn instead of stopping it. Named, only a message still waiting counts; once it
// does, everything waiting goes along, in order. With no run, they run when their turn comes.
export function sendNow<C>(queue: Waiting<C>[], uuid: unknown, running: boolean) {
	const named = typeof uuid === "string" && uuid !== "";
	if (queue.length === 0 || (named && !queue.some((m) => m.uuid === uuid))) return { answer: "nothing_waiting" as const, take: [] };
	return { answer: "delivering" as const, take: running ? queue.splice(0) : [] };
}

// Pi's own queue reads "Steering: …" above the editor; these read the same, so a message
// sent from the phone shows on the computer while it waits.
export function waitingLines(texts: string[]) {
	return texts.map((text) => `Waiting (Claude app): ${text.replace(/\s+/g, " ").trim()}`);
}
