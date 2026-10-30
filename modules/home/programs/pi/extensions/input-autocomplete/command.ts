// A slash command at the start of the draft, colored once Pi knows it.

// The name Pi would run: `/name` at the very start, as its own command parser reads it.
export function commandName(firstLine: string): string | undefined {
	return /^\/([^\s/]+)/u.exec(firstLine)?.[1];
}

// Colors `/name` where the editor drew it at the start of a row (after its padding). The
// lookahead accepts an escape, so the end-of-line cursor right after the name still matches.
export function paintCommand(row: string, name: string, paint: (text: string) => string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = new RegExp(`^( *)(/${escaped})(?=[\\s\\x1b]|$)`, "u").exec(row);
	if (!match) return undefined;
	return match[1] + paint(match[2]!) + row.slice(match[0].length);
}
