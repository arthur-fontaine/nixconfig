// full-history for Pi: a resumed or redrawn session shows its whole conversation, compactions
// included as their collapsed summaries, instead of only what followed the latest one. Pi
// draws its chat from SessionManager.buildContextEntries(), which nothing else calls; this
// wraps it on the session manager's class. See display.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayEntries, type Entry, INITIAL_RENDER } from "./display.ts";

const WRAPPED = Symbol.for("pi.full-history");

type Manager = { buildContextEntries(): Entry[]; getBranch(): Entry[] };

export function wrap(proto: Manager & { [WRAPPED]?: boolean }) {
	if (proto[WRAPPED] || typeof proto.buildContextEntries !== "function" || typeof proto.getBranch !== "function") return;
	const original = proto.buildContextEntries;
	proto.buildContextEntries = function (this: Manager) {
		const context = original.call(this);
		try {
			// Which of Pi's chat methods asked: only its stack says so.
			const initial = INITIAL_RENDER.test(new Error().stack ?? "");
			return displayEntries(context, this.getBranch(), initial);
		} catch {
			return context;
		}
	};
	proto[WRAPPED] = true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const manager = ctx.sessionManager as unknown as Manager;
		wrap(Object.getPrototypeOf(manager));
	});
}
