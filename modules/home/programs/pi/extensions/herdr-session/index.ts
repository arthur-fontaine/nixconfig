// What Herdr's Info panel reads about a Pi session: the terminal is labelled with its
// session file (hc label <terminal> pi.session=<file>), and the Claude usage is kept in
// ~/.pi/agent/claude-usage.json, account-wide: from each response, and asked of the
// account every minute between them (poll.ts), so it moves while no agent works.
import { execFile } from "node:child_process";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeToken, INTERVAL, poll, writeAtomic } from "./poll.ts";
import { usageOf } from "./usage.ts";

// Herdr sets HC_TERMINAL_ID in the terminals it runs; elsewhere there is nothing to label.
function label(value: string) {
	const terminal = process.env.HC_TERMINAL_ID;
	if (!terminal) return;
	execFile("hc", ["label", terminal, `pi.session=${value}`], { timeout: 5000 }, () => {});
}

// Kept on globalThis so /reload, which re-runs this file in the same process, replaces
// the timer instead of adding one.
const TIMER = Symbol.for("pi.herdr-session.usage-timer");
const slot = globalThis as Record<symbol, NodeJS.Timeout | undefined>;

function startPolling() {
	clearInterval(slot[TIMER]);
	const deps = { dir: getAgentDir(), now: Date.now, token: () => claudeToken(), fetch };
	const tick = () => void poll(deps).catch(() => {});
	// Ticks a few times per interval, at a random phase, so the sessions' claims spread out;
	// the files decide whether a tick asks.
	setTimeout(tick, Math.random() * 5000).unref();
	slot[TIMER] = setInterval(tick, INTERVAL / 4 + Math.random() * 2000);
	slot[TIMER].unref();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (file) label(file);
		startPolling();
	});

	pi.on("session_shutdown", async () => {
		label("");
		clearInterval(slot[TIMER]);
		slot[TIMER] = undefined;
	});

	pi.on("message_end", async (event) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		const usage = usageOf(event.message);
		const windows = usage?.unifiedWindows;
		if (!windows) return;
		const record = {
			at: Date.now(),
			fiveHour: windows.five_hour ?? null,
			sevenDay: windows.seven_day ?? null,
			overageStatus: usage.overageStatus ?? null,
			usingOverage: usage.isUsingOverage === true,
		};
		try {
			writeAtomic(path.join(getAgentDir(), "claude-usage.json"), record);
		} catch {}
	});
}
