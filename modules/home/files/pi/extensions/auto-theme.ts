import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

type ThemeMode = "dark" | "light";

async function getMacOSTheme(): Promise<ThemeMode> {
	try {
		await execAsync("defaults read -g AppleInterfaceStyle");
		return "dark";
	} catch {
		return "light";
	}
}

function parseHexColor(value: string): [number, number, number] | null {
	const hex = value.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function inferModeFromRgb([r, g, b]: [number, number, number]): ThemeMode {
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return luminance < 0.5 ? "dark" : "light";
}

async function inferModeFromGhosttyThemeFile(themeName: string): Promise<ThemeMode | null> {
	const themePath = path.join(os.homedir(), ".config", "ghostty", "themes", themeName);
	try {
		const content = await fs.readFile(themePath, "utf8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = line.match(/^background\s*=\s*(.+)$/);
			if (!match) continue;
			const rgb = parseHexColor(match[1].trim());
			if (rgb) return inferModeFromRgb(rgb);
		}
	} catch {
		// Ignore and fall back.
	}
	return null;
}

async function detectGhosttyTheme(): Promise<ThemeMode | null> {
	if (process.env.TERM_PROGRAM !== "ghostty") return null;

	const configPath = path.join(os.homedir(), ".config", "ghostty", "config");
	try {
		const content = await fs.readFile(configPath, "utf8");
		let themeValue: string | null = null;
		let backgroundValue: string | null = null;

		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;

			const themeMatch = line.match(/^theme\s*=\s*(.+)$/);
			if (themeMatch) {
				themeValue = themeMatch[1].trim();
				continue;
			}

			const backgroundMatch = line.match(/^background\s*=\s*(.+)$/);
			if (backgroundMatch) {
				backgroundValue = backgroundMatch[1].trim();
			}
		}

		if (backgroundValue) {
			const rgb = parseHexColor(backgroundValue);
			if (rgb) return inferModeFromRgb(rgb);
		}

		if (themeValue) {
			const darkLightTheme = /dark\s*:/i.test(themeValue) && /light\s*:/i.test(themeValue);
			if (darkLightTheme) {
				return await getMacOSTheme();
			}

			if (/^dark\s*:/i.test(themeValue)) return "dark";
			if (/^light\s*:/i.test(themeValue)) return "light";

			const quoted = themeValue.replace(/^"|"$/g, "");
			const inferred = await inferModeFromGhosttyThemeFile(quoted);
			if (inferred) return inferred;
		}
	} catch {
		// Ignore and fall back.
	}

	return null;
}

async function detectTheme(): Promise<ThemeMode> {
	return (await detectGhosttyTheme()) ?? (await getMacOSTheme());
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let currentTheme: ThemeMode | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const applyTheme = async () => {
			const nextTheme = await detectTheme();
			if (nextTheme !== currentTheme) {
				currentTheme = nextTheme;
				ctx.ui.setTheme(nextTheme);
			}
		};

		await applyTheme();
		intervalId = setInterval(applyTheme, 2000);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
