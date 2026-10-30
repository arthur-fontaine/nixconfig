import assert from "node:assert/strict";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { readTreeFile } from "../git.ts";
import { prune, Store } from "../store.ts";
import { cleanup, git, scratch, snapshot } from "./harness.ts";

const paths: string[] = [];
after(() => cleanup(paths));

test("a file is backed up once per prompt before its first change, after every change", async () => {
	const dir = await scratch("rewind-store-");
	paths.push(dir);
	const file = join(dir, "work.txt");
	const store = new Store(join(dir, "store"), join(dir, "session.jsonl"));
	assert.equal(await store.backUp("t1", "u1", file), true);
	await writeFile(file, "one\n");
	assert.equal(await store.backUp("t1", "u1", file, "after"), true);
	assert.equal(await store.backUp("t2", "u1", file), false);
	assert.equal(await store.backUp("t3", "u2", file), true);
	const backups = await store.backups();
	assert.deepEqual(
		backups.map(({ toolCallId, message, phase, blob }) => ({ toolCallId, message, phase, has: blob !== undefined })),
		[
			{ toolCallId: "t1", message: "u1", phase: undefined, has: false },
			{ toolCallId: "t1", message: "u1", phase: "after", has: true },
			{ toolCallId: "t3", message: "u2", phase: undefined, has: true },
		],
	);
	assert.equal((await store.get(backups[1]!.blob!))?.toString(), "one\n");
	// A new instance (Pi restarted) still knows what was backed up.
	const again = new Store(join(dir, "store"), join(dir, "session.jsonl"));
	assert.equal(await again.backUp("t4", "u2", file), false);
});

test("stores of deleted sessions are pruned after a grace period", async () => {
	const root = await scratch("rewind-prune-");
	paths.push(root);
	const make = async (name: string, sessionFile: string) => {
		await mkdir(join(root, name));
		await writeFile(join(root, name, "session"), sessionFile);
		const old = new Date(Date.now() - 2 * 86_400_000);
		await utimes(join(root, name, "session"), old, old);
	};
	await writeFile(join(root, "alive.jsonl"), "");
	await make("alive", join(root, "alive.jsonl"));
	await make("gone", join(root, "gone.jsonl"));
	await make("live", join(root, "nothing.jsonl"));
	await mkdir(join(root, "fresh"));
	await writeFile(join(root, "fresh", "session"), join(root, "not-yet.jsonl"));
	await prune(root, join(root, "live"));
	assert.deepEqual((await readdir(root)).sort(), ["alive", "alive.jsonl", "fresh", "live"]);
});

test("files are read out of snapshot trees, and a pruned tree is missing", async () => {
	const root = await scratch("rewind-git-");
	paths.push(root);
	git(root, "init", "-q");
	await mkdir(join(root, "sub dir"));
	await writeFile(join(root, "sub dir", "a*.txt"), "star\n");
	await writeFile(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
	const tree = snapshot(root);
	const file = await readTreeFile(root, tree, "sub dir/a*.txt");
	assert.ok(typeof file === "object" && file.content.toString() === "star\n");
	const script = await readTreeFile(root, tree, "run.sh");
	assert.ok(typeof script === "object" && script.mode === 0o755);
	assert.equal(await readTreeFile(root, tree, "sub dir/a.txt"), "absent");
	assert.equal(await readTreeFile(root, "0".repeat(40), "run.sh"), "missing");
});
