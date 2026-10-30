// State shared by every Pi session on this machine: the daily keep-alive spend
// and `/warm off all`. Claude Code gave the mod a store for this; Pi has none,
// so it is a JSON file next to Pi's own settings.
import { readFile, rename, writeFile } from "node:fs/promises";
import { dateKey, type Store } from "./warmer.ts";

type Data = Record<string, unknown>;

// Keys are `budget:<date>` and `off:<date>`; keep today's and yesterday's so a
// session open across midnight still finds its own.
function prune(data: Data, now: number): Data {
	const keep = new Set([dateKey(now), dateKey(now - 86_400_000)]);
	return Object.fromEntries(Object.entries(data).filter(([key]) => keep.has(key.slice(key.indexOf(":") + 1))));
}

export function fileStore(file: string, now: () => number = Date.now): Store {
	async function load(): Promise<Data> {
		try {
			const data = JSON.parse(await readFile(file, "utf8"));
			return data && typeof data === "object" && !Array.isArray(data) ? data : {};
		} catch {
			return {};
		}
	}

	// Read, change and write back in one go. Two sessions writing at the same
	// instant can lose one update to the budget, which only moves it by a ping.
	async function change(apply: (data: Data) => void): Promise<void> {
		const data = prune(await load(), now());
		apply(data);
		const tmp = `${file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
		await rename(tmp, file);
	}

	return {
		get: async (key) => (await load())[key],
		set: (key, value) =>
			change((data) => {
				data[key] = value;
			}),
		delete: (key) =>
			change((data) => {
				delete data[key];
			}),
	};
}
