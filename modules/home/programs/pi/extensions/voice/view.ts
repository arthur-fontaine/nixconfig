// What the call shows: the footer status, and the "Spoke" row of each spoken answer.
// pi-tui's helpers come in as `Tui` (index.ts passes the real ones), so tests run with Node alone.
import type { Component, MouseRegionHandler } from "@earendil-works/pi-tui";

export interface Tui {
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
	visibleWidth(text: string): number;
	wrapTextWithAnsi(text: string, width: number): string[];
	MouseRegion: new (child: Component, onMouse: MouseRegionHandler) => Component;
}

/** The data of a voice-spoken custom entry (pi.appendEntry): never part of the model's context. */
export interface SpokenEntry {
	text: string;
	interrupted: boolean;
	durationMs?: number;
}

export interface Paint {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

const STATES: Record<string, string> = {
	listening: "listening",
	user_speaking: "listening…",
	paused: "listening…",
	pi_working: "Pi is thinking",
	pi_speaking: "Pi is speaking",
	muted: "muted",
};

/** The footer's call item: "📞 listening", "📞 « partial »", "📞 call in other-chat"… */
export function statusText(s: { active: boolean; mine: boolean; owner?: string | null; state?: string; partial?: string; loading?: boolean }): string | undefined {
	if (!s.active) return undefined;
	if (!s.mine) return `📞 call in ${s.owner ?? "another chat"}`;
	if (s.loading) return "📞 loading voice models…";
	if ((s.state === "user_speaking" || s.state === "paused") && s.partial) return `📞 « ${s.partial} »`;
	return `📞 ${STATES[s.state ?? "listening"] ?? s.state}`;
}

function seconds(ms: number | undefined): string {
	return ms === undefined ? "" : ` ${Math.max(1, Math.round(ms / 1000))}s`;
}

/** The row's lines: one collapsed, the whole spoken text when expanded. */
export function spokenLines(tui: Tui, data: SpokenEntry, expanded: boolean, width: number, theme: Paint): string[] {
	const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = tui;
	const title = `Spoke${seconds(data.durationMs)}${data.interrupted ? ", interrupted" : ""}`;
	const bullet = theme.fg("dim", "⦁ ");
	if (!expanded) {
		const hint = theme.fg("dim", "  (click to expand)");
		const head = `${bullet}${theme.fg("muted", title)}${theme.fg("dim", " · ")}`;
		const room = Math.max(10, width - visibleWidth(head) - visibleWidth(hint));
		const quote = truncateToWidth(`« ${data.text.replace(/\s+/g, " ").trim()} »`, room, "… »");
		return [truncateToWidth(head + theme.fg("dim", quote) + hint, width)];
	}
	const lines = [`${bullet}${theme.fg("muted", title)}`];
	for (const line of wrapTextWithAnsi(data.text.trim(), Math.max(10, width - 2))) lines.push(`  ${theme.fg("dim", line)}`);
	return lines;
}

/** The row as a component: a click opens or closes it; Ctrl+O (`expanded`) opens every row. */
export function spokenRow(tui: Tui, data: SpokenEntry, globalExpanded: boolean, open: { value: boolean }, theme: Paint): Component {
	const inner: Component = {
		render: (width) => spokenLines(tui, data, globalExpanded || open.value, width, theme),
		invalidate() {},
	};
	return new tui.MouseRegion(inner, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		open.value = !open.value;
		return { handled: true };
	});
}
