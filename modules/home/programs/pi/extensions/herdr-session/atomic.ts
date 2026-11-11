import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

// A lock older than this belongs to a session that died holding it.
const LOCK_TTL = 30_000;

// Written aside then moved, so a reader never sees half a file. `raw` writes a string as is.
export function writeAtomic(file: string, value: unknown, raw = false) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, raw ? String(value) : JSON.stringify(value));
	renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

// A lock created exclusively: one session at a time holds it.
export function claim(lock: string, now: number, ttl = LOCK_TTL) {
	try {
		closeSync(openSync(lock, "wx"));
		return true;
	} catch {
		try {
			if (now - statSync(lock).mtimeMs < ttl) return false;
			unlinkSync(lock);
			closeSync(openSync(lock, "wx"));
			return true;
		} catch {
			return false;
		}
	}
}
