// auto-compact for Pi: notices when a prompt starts a new task and offers to compact or clear the
// context before it is sent, like the Claude Code mod cc-mod-auto-compact. A decision model
// (Spisev, served locally by llama.cpp, or any System One endpoint) reads a summary tree of the
// session and the new prompt. See README.md for how each part maps to Pi.
import { type ExtensionAPI, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { autoCompact } from "./extension.ts";
import { mainSessionOnly } from "./main-session.ts";

export default function (pi: ExtensionAPI) {
	autoCompact(mainSessionOnly(pi), { summarizeMessages: generateSummaryWithUsage });
}
