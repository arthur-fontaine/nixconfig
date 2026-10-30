import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileStore } from "./store.ts";

test("the store keeps values across instances and drops past days", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "cache-warmer-"));
	try {
		const file = path.join(dir, "cache-warmer.json");
		let now = new Date(2026, 9, 4, 23, 0).getTime();
		const a = fileStore(file, () => now);
		await a.set("budget:2026-10-04", 1000);
		await a.set("off:2026-10-04", true);
		const b = fileStore(file, () => now);
		assert.equal(await b.get("budget:2026-10-04"), 1000);
		await b.delete("off:2026-10-04");
		assert.equal(await a.get("off:2026-10-04"), undefined);

		now = new Date(2026, 9, 6, 9, 0).getTime();
		await a.set("budget:2026-10-06", 5);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { "budget:2026-10-06": 5 });
	} finally {
		await rm(dir, { recursive: true });
	}
});
