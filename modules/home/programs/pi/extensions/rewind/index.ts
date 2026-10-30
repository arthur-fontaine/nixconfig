// rewind for Pi: Claude Code's /rewind (Esc+Esc on an empty prompt), with the
// code restore built on bash-changes' snapshots and edit/write backups, and
// /restore to bring rewound prompts back.
import { convertToLlm, CustomEditor, type ExtensionAPI, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, parseKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { rewind } from "./extension.ts";

export default function (pi: ExtensionAPI) {
	rewind(pi, {
		agentDir: getAgentDir,
		newEditor: (tui, theme, keys) => new CustomEditor(tui, theme, keys),
		serialize: (messages) => serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0])),
		truncate: (text, width) => truncateToWidth(text, width, "…"),
		wrap: wrapTextWithAnsi,
		parseKey,
		decodePrintable: decodeKittyPrintable,
	});
}
