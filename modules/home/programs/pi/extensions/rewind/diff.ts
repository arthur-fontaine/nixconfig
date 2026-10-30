// Line counts of a diff between two texts, as `git diff --numstat` gives them.

export type LineCounts = { added: number; removed: number };

// Past this many differences the exact count costs more than it is worth on a
// one-line summary; the rest is counted as lines missing from either side.
const MAX_EDITS = 4_000;

export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function lineCounts(before: string, after: string): LineCounts {
	if (before === after) return { added: 0, removed: 0 };
	let a = splitLines(before);
	let b = splitLines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	a = a.slice(start, endA);
	b = b.slice(start, endB);
	// A missing final newline changes the last line, as in git.
	const lastChanged = before.endsWith("\n") !== after.endsWith("\n") && a.length === 0 && b.length === 0;
	if (lastChanged) return { added: 1, removed: 1 };
	const common = lcsLength(a, b);
	return { added: b.length - common, removed: a.length - common };
}

// Myers' O(ND) shortest edit script, keeping only its length.
function lcsLength(a: string[], b: string[]): number {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return 0;
	const max = Math.min(n + m, MAX_EDITS);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return (n + m - d) / 2;
		}
	}
	return multisetCommon(a, b);
}

function multisetCommon(a: string[], b: string[]): number {
	const counts = new Map<string, number>();
	for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of b) {
		const left = counts.get(line) ?? 0;
		if (left > 0) {
			common++;
			counts.set(line, left - 1);
		}
	}
	return common;
}

export function isBinary(content: Buffer): boolean {
	return content.subarray(0, 8000).includes(0);
}
