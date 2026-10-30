// Splits `git diff-tree -p` output into hunks per file.

export type DiffLine = {
	kind: "context" | "added" | "removed";
	// Line number on the side the line belongs to (the old side for context, as edit diffs do).
	line: number;
	text: string;
};

export type Hunk = {
	// git's enclosing-function context after the `@@ … @@` range, if any.
	heading: string;
	lines: DiffLine[];
};

export type FilePatch = { hunks: Hunk[] };

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// Decodes the C-quoted string git writes for a path it has to quote.
function unquote(text: string): string | undefined {
	const bytes: number[] = [];
	let i = 1;
	while (i < text.length) {
		const char = String.fromCodePoint(text.codePointAt(i)!);
		if (char === '"') return Buffer.from(bytes).toString("utf8");
		if (char !== "\\") {
			bytes.push(...Buffer.from(char));
			i += char.length;
			continue;
		}
		const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
		if (octal) {
			bytes.push(Number.parseInt(octal[0], 8));
			i += 4;
		} else {
			const byte = ESCAPES[text[i + 1] ?? ""];
			if (byte === undefined) return undefined;
			bytes.push(byte);
			i += 2;
		}
	}
	return undefined;
}

// The path in `diff --git a/<path> b/<path>`. Renames are off, so both sides
// name the same path, which settles where an unquoted one splits even when it
// contains " b/".
export function headerPath(header: string): string | undefined {
	const rest = header.slice("diff --git ".length);
	if (rest.startsWith('"')) {
		const quoted = unquote(rest);
		return quoted?.startsWith("a/") ? quoted.slice(2) : undefined;
	}
	if ((rest.length - 5) % 2 !== 0) return undefined;
	const length = (rest.length - 5) / 2;
	const path = rest.slice(2, 2 + length);
	return rest === `a/${path} b/${path}` ? path : undefined;
}

const RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

// A path can have two sections: a type change is a deletion followed by an addition.
export function parsePatch(patch: string): Map<string, FilePatch> {
	const files = new Map<string, FilePatch>();
	let file: FilePatch | undefined;
	let hunk: Hunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			hunk = undefined;
			const path = headerPath(line);
			file = path === undefined ? undefined : files.get(path);
			if (path !== undefined && !file) files.set(path, (file = { hunks: [] }));
			continue;
		}
		if (!file) continue;
		const range = RANGE.exec(line);
		if (range) {
			oldLine = Number(range[1]);
			newLine = Number(range[2]);
			file.hunks.push((hunk = { heading: range[3] ?? "", lines: [] }));
			continue;
		}
		if (!hunk) continue;
		const text = line.slice(1);
		if (line.startsWith("+")) hunk.lines.push({ kind: "added", line: newLine++, text });
		else if (line.startsWith("-")) hunk.lines.push({ kind: "removed", line: oldLine++, text });
		else if (line.startsWith(" ")) {
			hunk.lines.push({ kind: "context", line: oldLine++, text });
			newLine++;
		}
	}
	return files;
}
