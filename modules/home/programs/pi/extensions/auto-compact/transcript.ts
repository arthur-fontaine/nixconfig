// Pi's context messages as the transcript rows Claude Code's $.session.messages() returns, so
// text.ts groups and renders them exactly as the mod (and the training pipeline) did.

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { Row, ToolUse } from "./text.ts";

export type AgentMessage = ContextEvent["messages"][number];

function textOf(content: unknown) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

// Compaction and branch summaries, `!` commands, custom and system messages are left out, as
// Claude Code's continuation summaries and <bash-input> prompts are.
export function rowsOf(messages: readonly AgentMessage[]): Row[] {
	const failed = new Set<string>();
	for (const m of messages) if (m.role === "toolResult" && m.isError) failed.add(m.toolCallId);
	const rows: Row[] = [];
	for (const m of messages) {
		if (m.role === "user") rows.push({ role: "user", text: textOf(m.content), toolUses: [] });
		else if (m.role === "assistant") {
			const toolUses: ToolUse[] = [];
			for (const part of m.content) {
				if (part.type !== "toolCall") continue;
				toolUses.push({ tool: part.name, input: part.arguments, ...(failed.has(part.id) && { isError: true }) });
			}
			rows.push({ role: "assistant", text: textOf(m.content), toolUses });
		}
	}
	return rows;
}
