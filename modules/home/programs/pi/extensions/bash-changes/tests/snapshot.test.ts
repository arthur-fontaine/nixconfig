import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { parsePatch } from "../patch.ts";
import { PATCH_LIMIT, Snapshots } from "../snapshot.ts";
import { git, repo, scratch } from "./repo.ts";

const cleanup: string[] = [];
after(async () => {
	for (const path of cleanup) await rm(path, { recursive: true, force: true });
});

async function fixture() {
	const root = await repo();
	cleanup.push(root);
	await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
	await writeFile(join(root, "kept.txt"), "one\ntwo\nthree\n");
	await writeFile(join(root, "gone.txt"), "bye\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	return root;
}

// Everything git keeps besides objects: the real index, refs, the stash and the status.
async function gitState(root: string) {
	const index = createHash("sha256")
		.update(await readFile(join(root, ".git/index")))
		.digest("hex");
	return { index, refs: git(root, "for-each-ref"), stash: git(root, "stash", "list"), status: git(root, "status", "--porcelain") };
}

test("records what changed between two snapshots, untracked files included and ignored ones not", async () => {
	const root = await fixture();
	await writeFile(join(root, "staged.txt"), "staged\n");
	git(root, "add", "staged.txt");
	const snapshots = new Snapshots();
	const before = await gitState(root);
	const window = await snapshots.open(join(root));
	assert.ok(window);
	await writeFile(join(root, "kept.txt"), "one\n2\nthree\nfour\n");
	await unlink(join(root, "gone.txt"));
	await writeFile(join(root, "untracked.txt"), "new\n");
	await mkdir(join(root, "ignored"));
	await writeFile(join(root, "ignored", "cache.txt"), "x\n");
	await writeFile(join(root, "debug.log"), "x\n");
	const middle = await gitState(root);
	const changes = await window.close();
	assert.ok(changes);
	assert.equal(changes.root, root);
	assert.deepEqual(changes.files, [
		{ path: "gone.txt", status: "D", added: 0, removed: 1 },
		{ path: "kept.txt", status: "M", added: 2, removed: 1 },
		{ path: "untracked.txt", status: "A", added: 1, removed: 0 },
	]);
	assert.match(changes.patch, /^diff --git a\/gone.txt b\/gone.txt$/m);
	assert.match(changes.patch, /^\+four$/m);
	assert.equal(changes.patchTruncated, undefined);
	assert.equal(git(root, "cat-file", "-t", changes.before).trim(), "tree");
	// The ids restore any recorded file.
	assert.equal(git(root, "show", `${changes.before}:gone.txt`), "bye\n");
	assert.deepEqual(await gitState(root), middle);
	assert.equal(before.index, middle.index);
	await snapshots.dispose();
});

test("records nothing when the tree is unchanged or outside a git repository", async () => {
	const root = await fixture();
	const snapshots = new Snapshots();
	const window = await snapshots.open(root);
	assert.ok(window);
	assert.equal(await window.close(), undefined);
	const plain = await scratch("bash-changes-plain-");
	cleanup.push(plain);
	assert.equal(await snapshots.open(plain), undefined);
	await snapshots.dispose();
});

test("works in a fresh repository that has no index yet", async () => {
	const root = await repo();
	cleanup.push(root);
	const snapshots = new Snapshots();
	for (const name of ["first.txt", "second.txt"]) {
		const window = await snapshots.open(root);
		await writeFile(join(root, name), "x\n");
		assert.deepEqual(
			(await window!.close())?.files.map((file) => file.path),
			[name],
		);
	}
	assert.equal(git(root, "status", "--porcelain"), "?? first.txt\n?? second.txt\n");
	await snapshots.dispose();
});

test("snapshots the whole repository from a subdirectory", async () => {
	const root = await fixture();
	await mkdir(join(root, "sub"));
	const snapshots = new Snapshots();
	const window = await snapshots.open(join(root, "sub"));
	assert.ok(window);
	await writeFile(join(root, "top.txt"), "x\n");
	const changes = await window.close();
	assert.equal(changes?.root, root);
	assert.deepEqual(
		changes?.files.map((file) => file.path),
		["top.txt"],
	);
	await snapshots.dispose();
});

test("the reused snapshot index never hides changes made between calls", async () => {
	const root = await fixture();
	const snapshots = new Snapshots();
	const first = await snapshots.open(root);
	await writeFile(join(root, "scratch.txt"), "a\n");
	assert.deepEqual(
		(await first!.close())?.files.map((file) => file.path),
		["scratch.txt"],
	);
	// Edited outside any call: not this call's change, but its before state.
	await writeFile(join(root, "scratch.txt"), "b\n");
	const second = await snapshots.open(root);
	await writeFile(join(root, "kept.txt"), "changed\n");
	assert.deepEqual(
		(await second!.close())?.files.map((file) => file.path),
		["kept.txt"],
	);
	// Staging changes the real index, which takes over again as the starting point.
	git(root, "add", "kept.txt");
	const third = await snapshots.open(root);
	await writeFile(join(root, "scratch.txt"), "c\n");
	const changes = await third!.close();
	assert.deepEqual(
		changes?.files.map((file) => file.path),
		["scratch.txt"],
	);
	assert.match(changes!.patch, /^-b\n\+c$/m);
	await snapshots.dispose();
});

test("removes its index copies when windows close and when disposed", async () => {
	const root = await fixture();
	const tmp = await scratch("bash-changes-tmp-");
	cleanup.push(tmp);
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try {
		const snapshots = new Snapshots();
		const closed = await snapshots.open(root);
		const discarded = await snapshots.open(root);
		await writeFile(join(root, "x.txt"), "x\n");
		await closed!.close();
		await discarded!.discard();
		const [directory] = await readdir(tmp);
		assert.deepEqual(
			(await readdir(join(tmp, directory!))).map((name) => name.replace(/[0-9a-f]+$/, "")),
			["warm-"],
		);
		await snapshots.dispose();
		assert.deepEqual(await readdir(tmp), []);
	} finally {
		process.env.TMPDIR = previous;
	}
});

test("type changes, binary files and mode changes", async () => {
	const root = await fixture();
	await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
	await writeFile(join(root, "script.sh"), "echo hi\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "more");
	const snapshots = new Snapshots();
	const window = await snapshots.open(root);
	await unlink(join(root, "kept.txt"));
	await symlink("gone.txt", join(root, "kept.txt"));
	await writeFile(join(root, "image.bin"), Buffer.from([0, 9, 9, 3]));
	await chmod(join(root, "script.sh"), 0o755);
	const changes = await window!.close();
	assert.deepEqual(changes?.files, [
		{ path: "image.bin", status: "M" },
		{ path: "kept.txt", status: "T", added: 1, removed: 3 },
		{ path: "script.sh", status: "M", added: 0, removed: 0 },
	]);
	const patches = parsePatch(changes!.patch);
	assert.deepEqual(patches.get("image.bin"), { hunks: [] });
	// A type change is a deletion and an addition, both kept under the one path.
	assert.deepEqual(
		patches.get("kept.txt")?.hunks.map((hunk) => hunk.lines.map((line) => line.kind)),
		[["removed", "removed", "removed"], ["added"]],
	);
	await snapshots.dispose();
});

test("caps the patch at 200 KB on a line boundary but lists every file", async () => {
	const root = await fixture();
	const snapshots = new Snapshots();
	const window = await snapshots.open(root);
	const line = `${"x".repeat(99)}\n`;
	await writeFile(join(root, "big.txt"), line.repeat(3000));
	await writeFile(join(root, "small.txt"), "small\n");
	const changes = await window!.close();
	assert.equal(changes?.patchTruncated, true);
	assert.ok(Buffer.byteLength(changes!.patch) <= PATCH_LIMIT);
	assert.ok(changes!.patch.endsWith(`+${line}`));
	assert.deepEqual(
		changes!.files.map((file) => [file.path, file.added]),
		[
			["big.txt", 3000],
			["small.txt", 1],
		],
	);
	await snapshots.dispose();
});

const awkward = [
	"plain.txt",
	"accentué 日本 😀.txt",
	'quote".txt',
	"back\\slash.txt",
	"tab\t.txt",
	"new\nline.txt",
	"bell\x07\b\v\f\r.txt",
	'mixed é"\\\t.txt',
	"space b/inside.txt",
];

for (const quotePath of [true, false]) {
	test(`every path keeps its own hunks with core.quotePath=${quotePath}`, async () => {
		const root = await fixture();
		git(root, "config", "core.quotePath", String(quotePath));
		await mkdir(join(root, "space b"));
		for (const path of awkward) await writeFile(join(root, path), "before\n");
		git(root, "add", "-A");
		const snapshots = new Snapshots();
		const window = await snapshots.open(root);
		for (const [index, path] of awkward.entries()) await writeFile(join(root, path), `after ${index}\n`);
		const changes = await window!.close();
		assert.equal(changes?.files.length, awkward.length);
		assert.match(changes!.patch, /^diff --git "a\//m);
		const patches = parsePatch(changes!.patch);
		for (const [index, path] of awkward.entries()) {
			assert.ok(changes!.files.some((file) => file.path === path), JSON.stringify(path));
			const added = patches.get(path)?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "added").map((line) => line.text));
			assert.deepEqual(added, [`after ${index}`], JSON.stringify(path));
		}
		await snapshots.dispose();
	});
}
