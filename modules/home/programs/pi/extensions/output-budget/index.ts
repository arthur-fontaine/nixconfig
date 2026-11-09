// Long bash outputs reach the model as their head and tail plus the path of the whole
// output, instead of up to 50KB that stays in the context for the rest of the chat.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trimmed } from "./budget.ts";

const SAVED_DIR = join(homedir(), ".pi", "agent", "tmp", "output-budget");

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || event.content.length !== 1) return;
		const [only] = event.content;
		if (only?.type !== "text") return;
		// Pi saves the whole output itself when it truncated it; otherwise save it here.
		const piSaved = (event.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
		let savedTo: string;
		if (typeof piSaved === "string") savedTo = piSaved;
		else {
			if (only.text.length <= 16_000) return;
			savedTo = join(SAVED_DIR, `${event.toolCallId.replace(/[^\w-]+/g, "_")}.txt`);
			try {
				mkdirSync(SAVED_DIR, { recursive: true });
				writeFileSync(savedTo, only.text);
			} catch {
				return;
			}
		}
		const text = trimmed(only.text, savedTo);
		return text === undefined ? undefined : { content: [{ type: "text", text }] };
	});
}
