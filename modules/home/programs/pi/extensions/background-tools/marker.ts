// Where the "✓ finished in the background" line goes under a detached call's row.

const ESCAPES = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RAIL = /^( *⎿ +)/;

// compact-tools' Claude-style rows open their result with a rail, "   ⎿  ", and indent
// what follows as far. 0 for any other row.
export function railOf(lines: readonly string[]): number {
	for (const line of lines) {
		const text = line.replace(ESCAPES, "");
		if (text.trim()) return RAIL.exec(text)?.[1]!.length ?? 0;
	}
	return 0;
}

// After a blank line, as Pi separates its own lines; in a Claude-style row, as its next
// line in the body column.
export function withMarker(lines: readonly string[], marker: string, width: number, wrap: (text: string, width: number) => string[]): string[] {
	const rail = railOf(lines);
	const indent = " ".repeat(rail);
	const rows = wrap(marker, Math.max(1, width - rail)).map((row) => indent + row);
	return rail ? [...lines, ...rows] : [...lines, "", ...rows];
}
