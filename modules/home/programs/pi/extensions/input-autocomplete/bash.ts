// Bash mode as in Claude Code: the `!` that starts it stays in the draft, where Pi reads it
// (border color, `!!`, history), but isn't drawn, and the cursor never goes before it.
// No Pi imports.

export const inBashMode = (firstLine: string) => firstLine.startsWith("!");

// The editor's first text row without its leading `!`, as wide as before.
export function hideBang(row: string): string | undefined {
	const match = /^( *)!/u.exec(row);
	return match ? `${match[1]}${row.slice(match[0].length)} ` : undefined;
}

// Where the cursor goes so it stays after the `!`.
export function afterBang(firstLine: string, cursor: { line: number; col: number }): number {
	return inBashMode(firstLine) && cursor.line === 0 && cursor.col === 0 ? 1 : cursor.col;
}
