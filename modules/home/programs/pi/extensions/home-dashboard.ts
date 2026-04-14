import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import * as os from "node:os";
import * as path from "node:path";

const MAX_CONTENT_WIDTH = 108;

function padRight(text: string, width: number): string {
	const missing = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(missing);
}

function center(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	const len = visibleWidth(truncated);
	const left = Math.max(0, Math.floor((width - len) / 2));
	const right = Math.max(0, width - len - left);
	return " ".repeat(left) + truncated + " ".repeat(right);
}

function wrapBlock(lines: string[], width: number): string[] {
	return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}

function section(title: string, lines: string[], width: number, theme: any): string[] {
	const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
	const heading = theme.fg("accent", title);
	const body = wrapBlock(lines, width).map((line) => truncateToWidth(line, width));
	return [heading, border, ...body];
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
	const rows = Math.max(left.length, right.length);
	const output: string[] = [];
	for (let i = 0; i < rows; i++) {
		output.push(
			padRight(left[i] ?? "", leftWidth) + "   " + padRight(right[i] ?? "", rightWidth),
		);
	}
	return output;
}

function hasConversation(ctx: any): boolean {
	return ctx.sessionManager
		.getBranch()
		.some((entry: any) => entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget(
			"home-dashboard",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					if (hasConversation(ctx)) return [];

					const fullWidth = Math.min(MAX_CONTENT_WIDTH, Math.max(60, width - 2));
					const commands = pi.getCommands();
					const skillCount = commands.filter((c) => c.source === "skill").length;
					const promptCount = commands.filter((c) => c.source === "prompt").length;
					const extensionCount = commands.filter((c) => c.source === "extension").length;
					const toolCount = pi.getAllTools().length;
					const isHomeDir = path.resolve(ctx.cwd) === path.resolve(os.homedir());
					const user = os.userInfo().username;

					const hero = [
						"",
						center(theme.bold(theme.fg("accent", "Welcome back")), fullWidth),
						center(theme.fg("muted", user), fullWidth),
						"",
					];

					const left = section(
						"Get started",
						[
							`${theme.fg("accent", "/settings")} to tweak theme and behavior`,
							`${theme.fg("accent", "/")} to browse available slash commands`,
							`${theme.fg("accent", "! git status")} or ${theme.fg("accent", "! ls")} to inspect your workspace`,
							`${theme.fg("accent", "@file.ts")} to mention a file directly in your prompt`,
							`${theme.fg("accent", "Ctrl+V")} to paste images or drag files into Pi`,
						],
						fullWidth >= 92 ? 47 : fullWidth,
						theme,
					);

					const right = section(
						"Workspace",
						[
							`${theme.fg("muted", "Tools available:")} ${toolCount}`,
							`${theme.fg("muted", "Extensions:")} ${extensionCount}`,
							`${theme.fg("muted", "Skills:")} ${skillCount}`,
							`${theme.fg("muted", "Prompt templates:")} ${promptCount}`,
							isHomeDir
								? theme.fg("warning", "Tip: launching Pi inside a project directory usually feels more focused.")
								: theme.fg("success", "Ready to work in this project."),
						],
						fullWidth >= 92 ? 58 : fullWidth,
						theme,
					);

					const content =
						fullWidth >= 92
							? [...hero, ...joinColumns(left, right, 47, 58), ""]
							: [...hero, ...left, "", ...right, ""];

					const sidePad = Math.max(0, Math.floor((width - fullWidth) / 2));
					return [
						"",
						...content.map((line) => " ".repeat(sidePad) + padRight(truncateToWidth(line, fullWidth, ""), fullWidth)),
						"",
					];
				},
			}),
			{ placement: "aboveEditor" },
		);
	});
}
