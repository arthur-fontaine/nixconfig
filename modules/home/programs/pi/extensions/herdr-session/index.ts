// What Herdr's Info panel reads about a Pi session: the terminal is labelled with its
// session file (hc label <terminal> pi.session=<file>), and the Claude usage the latest
// response reported is kept in ~/.pi/agent/claude-usage.json, account-wide.
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { usageOf } from "./usage.ts";

// Herdr sets HC_TERMINAL_ID in the terminals it runs; elsewhere there is nothing to label.
function label(value: string) {
	const terminal = process.env.HC_TERMINAL_ID;
	if (!terminal) return;
	execFile("hc", ["label", terminal, `pi.session=${value}`], { timeout: 5000 }, () => {});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (file) label(file);
	});

	pi.on("session_shutdown", async () => label(""));

	pi.on("message_end", async (event) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		const usage = usageOf(event.message);
		const windows = usage?.unifiedWindows;
		if (!windows) return;
		const file = path.join(getAgentDir(), "claude-usage.json");
		const record = {
			at: Date.now(),
			fiveHour: windows.five_hour ?? null,
			sevenDay: windows.seven_day ?? null,
			overageStatus: usage.overageStatus ?? null,
			usingOverage: usage.isUsingOverage === true,
		};
		// Written aside then moved, so a reader never sees half a file.
		try {
			writeFileSync(`${file}.tmp`, JSON.stringify(record));
			renameSync(`${file}.tmp`, file);
		} catch {}
	});
}
