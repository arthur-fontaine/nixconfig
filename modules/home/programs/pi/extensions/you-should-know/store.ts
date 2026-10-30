// What You should know remembers across sessions, like Claude Code's plugin
// store: lines already offered, lines the person knows, the backoff counters,
// and whether it is turned off on this machine.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SEEN_MAX, storedCount, stringLines } from "./parse.ts";

export interface Stored {
	seen: string[];
	known: string[];
	typedPastInARow: number;
	looksToSkip: number;
	enabled: boolean;
}

export function storedOf(value: unknown): Stored {
	const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	return {
		seen: stringLines(v.seen).slice(-SEEN_MAX),
		known: stringLines(v.known).slice(-SEEN_MAX),
		typedPastInARow: storedCount(v.typedPastInARow),
		looksToSkip: storedCount(v.looksToSkip),
		enabled: v.enabled !== false,
	};
}

export const withSeen = (s: Stored, line: string): Stored => ({ ...s, seen: [...s.seen, line].slice(-SEEN_MAX) });

export const withKnown = (s: Stored, line: string): Stored =>
	s.known.some((k) => k.toLowerCase() === line.toLowerCase()) ? s : { ...s, known: [...s.known, line].slice(-SEEN_MAX) };

/** Any answer but a timeout means the person is paying attention again. */
export const withAnswered = (s: Stored): Stored => (s.typedPastInARow > 0 ? { ...s, typedPastInARow: 0, looksToSkip: 0 } : s);

export class Store {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	read(): Stored {
		try {
			return storedOf(JSON.parse(readFileSync(this.file, "utf8")));
		} catch {
			return storedOf(undefined);
		}
	}

	// Read right before writing: other Pi processes share the file.
	update(change: (s: Stored) => Stored): Stored {
		const next = change(this.read());
		try {
			mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
			renameSync(tmp, this.file);
		} catch {}
		return next;
	}
}
