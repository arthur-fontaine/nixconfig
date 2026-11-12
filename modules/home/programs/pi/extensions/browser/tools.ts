// Claude Code's Claude in Chrome tools, as `claude --claude-in-chrome-mcp`
// lists them (claude-tools.json, checked against the installed Claude Code by
// tests/tools.test.ts). Pi declares them under the names Claude Code's model
// sees, deferred behind tool_search as Claude Code defers them behind ToolSearch.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVER = "claude-in-chrome";
export const TOOL_PREFIX = `mcp__${SERVER}__`;

export type ClaudeTool = {
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	_meta?: Record<string, unknown>;
};

let cached: ClaudeTool[] | undefined;

export function claudeTools(): ClaudeTool[] {
	cached ??= (JSON.parse(readFileSync(join(import.meta.dirname ?? __dirname, "claude-tools.json"), "utf8")) as { tools: ClaudeTool[] }).tools;
	return cached;
}

export function piToolName(name: string): string {
	return `${TOOL_PREFIX}${name}`;
}

export function claudeToolName(piName: string): string | undefined {
	return piName.startsWith(TOOL_PREFIX) ? piName.slice(TOOL_PREFIX.length) : undefined;
}

export type PiToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	exposure: "deferred";
};

export function piToolDefinitions(): PiToolDefinition[] {
	return claudeTools().map((tool) => ({
		name: piToolName(tool.name),
		label: tool.title ?? tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
		exposure: "deferred" as const,
	}));
}

/**
 * `save_to_disk` is Claude Code's own option, never sent to the extension: the
 * client saves the screenshot itself. In a batch it may sit on any computer action.
 */
export function stripSaveToDisk(tool: string, args: Record<string, unknown>): { args: Record<string, unknown>; wantsSave: boolean } {
	if (tool === "browser_batch" && Array.isArray(args.actions)) {
		const { save_to_disk, ...rest } = args;
		let wantsSave = save_to_disk === true;
		const actions = args.actions.map((action) => {
			if (!action || typeof action !== "object") return action;
			const item = action as { name?: unknown; input?: unknown };
			if (!item.input || typeof item.input !== "object") return action;
			const { save_to_disk: save, ...input } = item.input as Record<string, unknown>;
			if (save === true && item.name === "computer") wantsSave = true;
			return { ...item, input };
		});
		return { args: { ...rest, actions }, wantsSave };
	}
	if (!("save_to_disk" in args)) return { args, wantsSave: false };
	const { save_to_disk, ...rest } = args;
	return { args: rest, wantsSave: tool === "computer" && save_to_disk === true };
}
