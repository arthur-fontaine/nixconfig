// Claude Code's "Allowed by auto mode" row note (SPEC.md §3): the verdict kept on the
// tool result, and where the note goes among the lines another renderer drew.
export const NOTE = "Allowed by auto mode";

export type Verdict = { allowed: true };

export const allowedIn = (details: unknown) => (details as { autoMode?: { allowed?: unknown } } | null | undefined)?.autoMode?.allowed === true;

// The result's details with the verdict merged in; undefined leaves details another
// tool owns in another shape alone rather than replacing them.
export function withVerdict(details: unknown): Record<string, unknown> | undefined {
	if (details !== undefined && (typeof details !== "object" || details === null || Array.isArray(details))) return undefined;
	return { ...(details as Record<string, unknown> | undefined), autoMode: { allowed: true } satisfies Verdict };
}

// CSI (colors) and OSC 8 (links), the escapes Pi's renderers draw.
const ESCAPES = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const plain = (line: string) => line.replace(ESCAPES, "");

// Pi's toolTimerText once final (formatToolDuration: `4.2s`, `1m 30s`, `2h 3m 4s`).
const TIMER = /^Took (?:\d+h )?(?:\d+m )?\d+(?:\.\d+)?s$/;

export const isTimer = (line: string, mutedAnsi: string) => TIMER.test(plain(line).trim()) && (!mutedAnsi || line.includes(mutedAnsi));

const pad = (line: string, width: number) => line + " ".repeat(Math.max(0, width - [...plain(line)].length));

// The note goes after the last `Took Xs` line, two spaces from it, when it fits on that line;
// below it when it doesn't; otherwise as the result's last line, after a blank one as Pi
// separates its own timer. Lines added below the timer by other renderers (file changes, a
// background marker) stay where they are.
export function placeNote(lines: readonly string[], width: number, note: string, noteWidth: number, isTimerLine: (line: string) => boolean): string[] {
	const fitted = noteWidth > width ? plain(note).slice(0, Math.max(1, width)) : note;
	const out = [...lines];
	for (let i = out.length - 1; i >= 0; i--) {
		if (!isTimerLine(out[i])) continue;
		const base = out[i].replace(/ +$/, "");
		if ([...plain(base)].length + 2 + noteWidth <= width) out[i] = pad(`${base}  ${note}`, width);
		else out.splice(i + 1, 0, pad(fitted, width));
		return out;
	}
	return [...out, pad("", width), pad(fitted, width)];
}
