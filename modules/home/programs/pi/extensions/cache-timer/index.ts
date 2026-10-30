// cache-timer for Pi: shows `cache expires in 3 min` in the footer in the last
// five minutes before the session's prompt cache expires.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Entry, label, lastTouch, ttlMsFrom } from "./timer.ts";

const STATUS_KEY = "cache-timer";
// Bounds the walk back to the last request on a branch that has none.
const MAX_SCAN = 2000;

function* newestFirst(ctx: ExtensionContext): Generator<Entry> {
	const session = ctx.sessionManager;
	let entry = session.getLeafEntry();
	for (let i = 0; entry && i < MAX_SCAN; i++) {
		yield entry as Entry;
		entry = entry.parentId ? session.getEntry(entry.parentId) : undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Settings can't be read while extensions load.
	let ttlMs = ttlMsFrom(undefined);
	let running = false;
	let shown: string | undefined;

	function render() {
		if (!ctx?.hasUI) return;
		// Each request restarts the clock, so a countdown during a run would only
		// flicker near its full lifetime.
		const line = running || !ctx.isIdle() ? undefined : label(lastTouch(newestFirst(ctx)), ttlMs, Date.now());
		// Colors are for the terminal; RPC clients get plain text.
		const text = line && (ctx.mode === "tui" ? ctx.ui.theme.fg(line.tone, line.text) : line.text);
		if (text === shown) return;
		shown = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function stop() {
		clearInterval(ticker);
		ticker = undefined;
	}

	pi.on("session_start", async (_event, next) => {
		ctx = next;
		ttlMs = ttlMsFrom(pi.getSettings());
		running = false;
		shown = undefined;
		stop();
		// Other modes have no footer; a status update every second would only
		// flood RPC clients.
		if (next.mode === "tui") {
			ticker = setInterval(render, 1000);
			ticker.unref?.();
		}
		render();
	});

	pi.on("session_shutdown", async () => {
		stop();
		ctx = undefined;
	});

	pi.on("agent_start", async (_event, next) => {
		ctx = next;
		running = true;
		render();
	});

	pi.on("agent_settled", async (_event, next) => {
		ctx = next;
		running = false;
		render();
	});

	const refresh = async (_event: unknown, next: ExtensionContext) => {
		ctx = next;
		render();
	};
	pi.on("session_compact", refresh);
	pi.on("session_tree", refresh);
	pi.on("model_select", refresh);

	// cache-warmer records each ping on the session; this updates the label as
	// soon as one lands rather than on the next tick.
	pi.events.on("cache-warmer:state", () => render());
}
