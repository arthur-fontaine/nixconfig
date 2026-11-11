import { renameSync, writeFileSync } from "node:fs";

// Written aside then moved, so a reader never sees half a file. `raw` writes a string as is.
export function writeAtomic(file: string, value: unknown, raw = false) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, raw ? String(value) : JSON.stringify(value));
	renameSync(tmp, file);
}
