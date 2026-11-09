// Messages `hc send` types into Pi go to the agent, not into the editor: hc pastes them
// and presses Enter, which would join and submit whatever the user is drafting. Its paste
// and that Enter are taken from the terminal input, and the message is sent as a user
// message, steering the run when one is going. The draft keeps its text and cursor.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Inbox, Outbox } from "./inbox.ts";

export default function (pi: ExtensionAPI) {
	// hc only types into the terminals it runs, and they all have HC_TERMINAL_ID.
	if (!process.env.HC_TERMINAL_ID) return;

	let ctx: ExtensionContext | undefined;
	let stopInput: (() => void) | undefined;
	const inbox = new Inbox();
	const outbox = new Outbox(
		(message, delivery) => pi.sendUserMessage(message, delivery === "steer" ? { deliverAs: "steer" } : undefined),
		() => ctx?.isIdle() ?? true,
	);

	pi.on("session_start", (_event, next) => {
		ctx = next;
		stopInput?.();
		stopInput = undefined;
		if (next.mode !== "tui") return;
		stopInput = next.ui.onTerminalInput((data) => {
			const taken = inbox.input(data, Date.now());
			if (taken?.message) outbox.push(taken.message);
			return taken && { consume: true };
		});
	});

	pi.on("session_before_compact", () => outbox.compactionStarted());
	// Pi clears its compaction state only after these handlers return.
	const release = () => void setTimeout(() => outbox.compactionEnded(), 0);
	pi.on("session_compact", release);
	pi.on("session_compact_failed", release);

	pi.on("session_shutdown", () => {
		stopInput?.();
		stopInput = undefined;
		ctx = undefined;
	});
}
