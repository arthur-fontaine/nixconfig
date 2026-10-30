import assert from "node:assert/strict";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { bashChanges, settingsFrom } from "../extension.ts";
import { DEFAULT_VIEW, type RenderDeps } from "../render.ts";
import type { FileChanges } from "../snapshot.ts";
import { git, repo, scratch } from "./repo.ts";

const cleanup: string[] = [];
after(async () => {
	for (const path of cleanup) await rm(path, { recursive: true, force: true });
});

const deps: RenderDeps = { highlight: (code) => code.split("\n"), language: () => undefined, wrap: (text) => [text], expandHint: () => "" };

// A Pi that only records registrations, driven by hand in the order the agent loop emits events.
function fakePi(settings: unknown = {}, branch: unknown[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const listeners = new Map<string, (data: unknown) => void>();
	const resolvers: ToolRendererResolver[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		events: { on: (channel: string, listener: (data: unknown) => void) => listeners.set(channel, listener), emit() {} },
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		registerToolRenderer: (resolver: ToolRendererResolver) => resolvers.push(resolver),
		getSettings: () => settings,
	} as unknown as ExtensionAPI;
	const emit = (name: string, event: object, cwd = "") =>
		handlers.get(name)?.({ type: name, ...event }, { cwd, sessionManager: { getBranch: () => branch } }) as Promise<unknown>;
	const broadcast = (channel: string, data: unknown) => listeners.get(channel)?.(data);
	return { pi, emit, broadcast, resolvers, entries };
}

async function setup(settings?: unknown, branch?: unknown[]) {
	const root = await repo();
	const tmp = await scratch("bash-changes-tmp-");
	cleanup.push(root, tmp);
	await writeFile(join(root, "a.txt"), "a\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	process.env.TMPDIR = tmp;
	const fake = fakePi(settings, branch);
	bashChanges(fake.pi, deps);
	await fake.emit("session_start", {});
	// Index copies left in the extension's temp directory, warm ones aside.
	const copies = async () => {
		const [directory] = await readdir(tmp);
		return directory ? (await readdir(join(tmp, directory))).filter((name) => !name.startsWith("warm-")) : [];
	};
	return { root, tmp, copies, ...fake };
}

async function bash(emit: ReturnType<typeof fakePi>["emit"], root: string, id: string, run: () => Promise<void>, details: unknown = undefined, isError = false) {
	await emit("tool_execution_start", { toolCallId: id, toolName: "bash", args: {} });
	assert.equal(await emit("tool_call", { toolCallId: id, toolName: "bash", input: { command: "x" } }, root), undefined);
	await run();
	const result = (await emit("tool_result", { toolCallId: id, toolName: "bash", input: {}, content: [{ type: "text", text: "out" }], details, isError })) as
		| { details: { fileChanges: FileChanges } & Record<string, unknown> }
		| undefined;
	await emit("tool_execution_end", { toolCallId: id, toolName: "bash", result: {}, isError });
	return result;
}

test("adds details.fileChanges to successful and failed results, keeping the other details", async () => {
	const { root, emit, copies } = await setup();
	const ok = await bash(emit, root, "1", () => writeFile(join(root, "a.txt"), "b\n"), { truncation: { truncated: false } });
	assert.deepEqual(Object.keys(ok!), ["details"]);
	assert.deepEqual(ok!.details.truncation, { truncated: false });
	assert.deepEqual(ok!.details.fileChanges.files, [{ path: "a.txt", status: "M", added: 1, removed: 1 }]);
	assert.equal(ok!.details.fileChanges.overlapping, undefined);
	const failed = await bash(emit, root, "2", () => writeFile(join(root, "b.txt"), "b\n"), undefined, true);
	assert.deepEqual(failed!.details.fileChanges.files.map((file) => file.path), ["b.txt"]);
	assert.equal(await bash(emit, root, "3", async () => {}), undefined);
	assert.deepEqual(await copies(), []);
	await emit("session_shutdown", {});
});

test("a call that never runs leaves nothing behind", async () => {
	const { root, emit, copies } = await setup();
	await emit("tool_execution_start", { toolCallId: "blocked", toolName: "bash", args: {} });
	await emit("tool_call", { toolCallId: "blocked", toolName: "bash", input: {} }, root);
	assert.equal((await copies()).length, 1);
	// Blocked by a later tool_call handler: the loop goes straight to tool_execution_end.
	await emit("tool_execution_end", { toolCallId: "blocked", toolName: "bash", result: {}, isError: true });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(await copies(), []);
	await emit("session_shutdown", {});
});

test("a call still running when its result comes keeps its window until then; other tools meanwhile mark it overlapping", async () => {
	const { root, emit } = await setup();
	await emit("tool_execution_start", { toolCallId: "slow", toolName: "bash", args: {} });
	await emit("tool_call", { toolCallId: "slow", toolName: "bash", input: {} }, root);
	await writeFile(join(root, "a.txt"), "late\n");
	assert.equal(await bash(emit, root, "fg", async () => {}), undefined);
	await new Promise((resolve) => setTimeout(resolve, 20));
	const result = (await emit("tool_result", { toolCallId: "slow", toolName: "bash", input: {}, content: [], details: undefined, isError: false })) as {
		details: { fileChanges: FileChanges };
	};
	assert.equal(result.details.fileChanges.overlapping, true);
	assert.deepEqual(result.details.fileChanges.files.map((file) => file.path), ["a.txt"]);
	await emit("session_shutdown", {});
});

test("a call detached by background-tools is recorded when it ends, as a session entry its row reads", async () => {
	const { root, emit, broadcast, entries, resolvers, copies } = await setup();
	const placeholder = { content: [{ type: "text", text: "running in the background" }], details: { background: { startedAt: 1 } } };
	await emit("tool_execution_start", { toolCallId: "bg", toolName: "bash", args: {} });
	await emit("tool_call", { toolCallId: "bg", toolName: "bash", input: {} }, root);
	broadcast("background-tools", { type: "detach", toolCallId: "bg", toolName: "bash", startedAt: 1 });
	await writeFile(join(root, "a.txt"), "before the placeholder\n");
	assert.equal(await emit("tool_result", { toolCallId: "bg", toolName: "bash", input: {}, ...placeholder, isError: false }), undefined);
	await emit("tool_execution_end", { toolCallId: "bg", toolName: "bash", result: placeholder, isError: false });
	assert.equal((await copies()).length, 1);

	let repainted = 0;
	const renderers = resolvers[0]!("bash", () => ({ renderResult: () => ({ render: () => ["final"], invalidate() {} }) }))!;
	const render = () =>
		renderers.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, { fg: (_: string, text: string) => text } as never, {
			toolCallId: "bg",
			lastComponent: undefined,
			invalidate: () => repainted++,
		} as never);
	assert.deepEqual(render().render(80), ["final"]);

	await writeFile(join(root, "b.txt"), "after it\n");
	broadcast("background-tools", { type: "end", toolCallId: "bg", result: {}, isError: false, stopped: false });
	for (let i = 0; i < 100 && !entries.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(entries[0]?.customType, "bash-changes");
	const data = entries[0]!.data as { toolCallId: string; fileChanges: FileChanges };
	assert.equal(data.toolCallId, "bg");
	assert.deepEqual(data.fileChanges.files.map((file) => file.path), ["a.txt", "b.txt"]);
	assert.equal(repainted, 1);
	assert.ok(render().render(80).includes("✎ a.txt, b.txt  +2 −1"));
	assert.deepEqual(await copies(), []);
	await emit("session_shutdown", {});

	// A resumed session finds them on its branch.
	const resumed = fakePi({}, [{ type: "custom", customType: "bash-changes", data }]);
	bashChanges(resumed.pi, deps);
	await resumed.emit("session_start", {});
	const again = resumed.resolvers[0]!("bash", () => ({ renderResult: () => ({ render: () => [], invalidate() {} }) }))!;
	const lines = again.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, { fg: (_: string, text: string) => text } as never, {
		toolCallId: "bg",
		lastComponent: undefined,
		invalidate() {},
	} as never);
	assert.equal(lines.render(80)[1], "✎ a.txt, b.txt  +2 −1");
});

test("skips nested calls, other tools, repositories' outsides, foreign details and detection turned off", async () => {
	const { root, emit, copies } = await setup();
	await emit("tool_call", { toolCallId: "p/1", parentToolCallId: "p", toolName: "bash", input: {} }, root);
	await emit("tool_call", { toolCallId: "w", toolName: "write", input: {} }, root);
	assert.deepEqual(await copies(), []);
	const plain = await scratch("bash-changes-plain-");
	cleanup.push(plain);
	assert.equal(await bash(emit, plain, "out", () => writeFile(join(plain, "x"), "x")), undefined);
	assert.equal(await bash(emit, root, "str", () => writeFile(join(root, "c.txt"), "c"), "not an object"), undefined);
	await emit("session_shutdown", {});

	const off = await setup({ bashChanges: { detect: false } });
	assert.equal(await bash(off.emit, off.root, "1", () => writeFile(join(off.root, "a.txt"), "z\n")), undefined);
	await off.emit("session_shutdown", {});
});

test("session shutdown removes the temp directory, pending windows included", async () => {
	const { root, tmp, emit } = await setup();
	await bash(emit, root, "1", () => writeFile(join(root, "a.txt"), "q\n"));
	await emit("tool_call", { toolCallId: "open", toolName: "bash", input: {} }, root);
	await emit("session_shutdown", {});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(await readdir(tmp), []);
});

test("registers a renderer for bash only, and reads its settings from settings.json", () => {
	const { pi, resolvers } = fakePi();
	bashChanges(pi, deps);
	const other = { renderResult: () => ({ render: () => [], invalidate() {} }) };
	assert.equal(resolvers[0]!("read", () => other), other);
	assert.notEqual(resolvers[0]!("bash", () => other), other);
	assert.deepEqual(settingsFrom({ bashChanges: { openFiles: 1, previewLines: -2, newFilesOpen: true } }), {
		detect: true,
		view: { ...DEFAULT_VIEW, openFiles: 1, newFilesOpen: true },
	});
});
