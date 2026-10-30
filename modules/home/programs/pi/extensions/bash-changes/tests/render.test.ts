import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRenderResultOptions, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ChangesSource, withChanges } from "../extension.ts";
import { headerPath } from "../patch.ts";
import { ChangesView, changeRows, DEFAULT_VIEW, type Paint, type RenderDeps } from "../render.ts";
import type { FileChanges } from "../snapshot.ts";

// Colors show as <token>…</token>; highlighted code as «…».
const paint: Paint = { fg: (token, text) => `<${token}>${text}</${token}>` };
const plain = (line: string) => line.replace(/<\/?\w+>|[«»]/g, "");
const deps: RenderDeps = {
	highlight: (code) => code.split("\n").map((line) => `«${line}»`),
	language: (path) => (path.endsWith(".ts") ? "typescript" : undefined),
	wrap: (text, width) => {
		const lines: string[] = [];
		for (let rest = plain(text); lines.length === 0 || rest; rest = rest.slice(width)) lines.push(rest.slice(0, width));
		return lines;
	},
	expandHint: () => "ctrl+o to show all changes",
};

const patch = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -8,3 +8,3 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	" const c = 4;",
	"@@ -40,2 +40,3 @@ function tail() {",
	" \treturn x;",
	"+\t// done",
	" }",
	"diff --git a/notes.md b/notes.md",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/notes.md",
	"@@ -0,0 +1,2 @@",
	"+# Notes",
	"+hello",
	"",
].join("\n");

const changes: FileChanges = {
	root: "/repo",
	before: "a".repeat(40),
	after: "b".repeat(40),
	files: [
		{ path: "notes.md", status: "A", added: 2, removed: 0 },
		{ path: "src/a.ts", status: "M", added: 2, removed: 1 },
	],
	patch,
};

test("expanded: a summary, then each file with its diff in the edit tool's format", () => {
	assert.deepEqual(changeRows(changes, true, DEFAULT_VIEW, paint, deps).map(plain), [
		"✎ notes.md, a.ts  +4 −1",
		"notes.md  new  +2",
		"+1 # Notes",
		"+2 hello",
		"src/a.ts  +2 −1",
		"  8 const a = 1;",
		"- 9 const b = 2;",
		"+ 9 const b = 3;",
		" 10 const c = 4;",
		"    ... function tail() {",
		" 40    return x;",
		"+41    // done",
		" 41 }",
	]);
});

test("colors follow the theme, and added code is highlighted when its language is known", () => {
	const rows = changeRows(changes, true, DEFAULT_VIEW, paint, deps);
	assert.ok(rows.includes("<toolDiffAdded>+1 # Notes</toolDiffAdded>"), "unknown language: the whole line in the added color");
	assert.ok(rows.includes("<toolDiffAdded>+ 9</toolDiffAdded> «const b = 3;»"));
	assert.ok(rows.includes("<toolDiffRemoved>- 9 const b = 2;</toolDiffRemoved>"));
	assert.ok(rows.includes("<toolDiffContext> 10 const c = 4;</toolDiffContext>"));
});

test("collapsed: the first files are previewed, the rest listed or counted, with a hint", () => {
	const many: FileChanges = {
		...changes,
		files: [...changes.files, ...["c", "d", "e", "f", "g"].map((name) => ({ path: `${name}.txt`, status: "M", added: 1, removed: 1 }))],
		overlapping: true,
	};
	const view = { ...DEFAULT_VIEW, openFiles: 1, previewLines: 1, listFiles: 3 };
	assert.deepEqual(changeRows(many, false, view, paint, deps).map(plain), [
		"✎ 7 files  +9 −6  overlapping",
		"notes.md  new  +2",
		"+1 # Notes",
		"... (1 more diff line)",
		"src/a.ts  +2 −1",
		"c.txt  +1 −1",
		"... 4 more files  +4 −4",
		"ctrl+o to show all changes",
	]);
	assert.ok(changeRows(many, false, { ...view, newFilesOpen: true, openFiles: 0 }, paint, deps).map(plain).includes("+1 # Notes"));
});

test("a single file is named in the summary, with its status", () => {
	const one: FileChanges = { ...changes, files: [{ path: "img.png", status: "D" }], patch: "diff --git a/img.png b/img.png\ndeleted file mode 100644\nBinary files a/img.png and /dev/null differ\n" };
	assert.deepEqual(changeRows(one, false, DEFAULT_VIEW, paint, deps).map(plain), ["✎ img.png  deleted  binary"]);
	assert.deepEqual(changeRows({ ...one, patchTruncated: true }, true, DEFAULT_VIEW, paint, deps).map(plain), [
		"✎ img.png  deleted  binary",
		"[Diff truncated at 200 KB]",
	]);
});

test("git's quoted and unquoted headers name the file", () => {
	assert.equal(headerPath("diff --git a/space b/inside.txt b/space b/inside.txt"), "space b/inside.txt");
	assert.equal(headerPath('diff --git "a/q\\"\\\\\\t\\303\\251.txt" "b/q\\"\\\\\\t\\303\\251.txt"'), 'q"\\\té.txt');
	assert.equal(headerPath('diff --git "a/é\\"x" "b/é\\"x"'), 'é"x');
});

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
const source: ChangesSource = { view: () => DEFAULT_VIEW, saved: () => undefined, watch() {} };
const options = (expanded: boolean, isPartial = false): ToolRenderResultOptions => ({ expanded, isPartial });
const context = (lastComponent: Component | undefined) => ({ lastComponent }) as ToolRenderContext;
const lines = (...text: string[]): Component => ({ render: () => text, invalidate() {} });

test("chains onto the bash renderer it wraps, keeping its own component", () => {
	const seen: (Component | undefined)[] = [];
	const renderCall = () => lines("$ make");
	const inner: ToolRenderers = {
		renderCall,
		renderResult: (result, _options, _theme, ctx) => {
			seen.push(ctx.lastComponent);
			return lines(`output of ${(result.content[0] as { text: string }).text}`);
		},
	};
	const renderers = withChanges(inner, source, deps);
	assert.equal(renderers.renderCall, renderCall);
	const theme = paint as never;

	const partial = renderers.renderResult!({ content: [{ type: "text", text: "a" }], details: undefined }, options(false, true), theme, context(undefined));
	assert.deepEqual(partial.render(80), ["output of a"]);

	const result = { content: [{ type: "text" as const, text: "b" }], details: { truncation: undefined, fileChanges: changes } };
	const first = renderers.renderResult!(result, options(false), theme, context(partial));
	assert.ok(first instanceof ChangesView);
	assert.equal(seen[1], partial);
	const rendered = first.render(80);
	assert.equal(rendered[0], "output of b");
	assert.equal(rendered[1], "");
	assert.equal(rendered[2], "✎ notes.md, a.ts  +4 −1");

	// The inner renderer gets back its own component, never the wrapper.
	const firstBase = first.base;
	const second = renderers.renderResult!(result, options(true), theme, context(first));
	assert.equal(second, first);
	assert.equal(seen[2], firstBase);
	assert.ok(second.render(80).includes("  8 const a = 1;"));
	for (const line of second.render(12)) assert.ok(line.length <= 12, line);
});

test("results without changes are the inner renderer's alone", () => {
	const base = lines("plain");
	const renderers = withChanges({ renderResult: () => base }, source, deps);
	assert.equal(renderers.renderResult!({ content: [], details: { fileChanges: "nope" } }, options(true), paint as never, context(undefined)), base);
	const fallback = withChanges(undefined, source, deps);
	assert.deepEqual(fallback.renderResult!({ content: [{ type: "text", text: "hi" }], details: undefined }, options(true), paint as never, context(undefined)).render(80), ["", "hi"]);
});

test("a detached call's changes come from the saved entries, and its row is repainted when they arrive", () => {
	const saved = new Map<string, FileChanges>();
	const repaints: string[] = [];
	const renderers = withChanges({ renderResult: () => lines("final output") }, { ...source, saved: (id) => saved.get(id), watch: (id) => repaints.push(id) }, deps);
	const render = () => renderers.renderResult!({ content: [], details: {} }, options(false), paint as never, { lastComponent: undefined, toolCallId: "bg", invalidate() {} } as never);
	assert.deepEqual(render().render(80), ["final output"]);
	assert.deepEqual(repaints, ["bg"]);
	saved.set("bg", changes);
	assert.equal(render().render(80)[2], "✎ notes.md, a.ts  +4 −1");
});
