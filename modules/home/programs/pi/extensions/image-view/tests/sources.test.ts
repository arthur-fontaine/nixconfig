import assert from "node:assert/strict";
import { test } from "node:test";
import { quickLookArgv } from "../quicklook.ts";
import { draftPath, findDraftEditor, linkedImages, messageSources, referencePath, toolSources } from "../sources.ts";

const ROOT = "/agent/image-view/blobs";
const SHA = "a".repeat(64);
const image = (data = "iVBORw0KGgo=") => ({ type: "image", data, mimeType: "image/png" });

test("a prompt sent through pi-image-view tiles the blobs its markers link to", () => {
	const text = `why is [[Image #2]](file://${ROOT}/${SHA}.png) off from [Image #3](image-view://sha256/${"b".repeat(64)}.jpg)`;
	assert.deepEqual(linkedImages(text, ROOT), [
		{ n: 2, path: `${ROOT}/${SHA}.png` },
		{ n: 3, path: `${ROOT}/${"b".repeat(64)}.jpg` },
	]);
	const content = [{ type: "text", text }, image(), image()];
	assert.deepEqual(messageSources(content, ROOT), [
		{ id: "2", label: "#2", alt: "[Image #2]", path: `${ROOT}/${SHA}.png` },
		{ id: "3", label: "#3", alt: "[Image #3]", path: `${ROOT}/${"b".repeat(64)}.jpg` },
	]);
});

test("without links, the message's own images are tiled, numbered like its markers", () => {
	const content = [{ type: "text", text: "see [Image #4] and [Image #5]" }, image("A"), image("B")];
	assert.deepEqual(
		messageSources(content, ROOT).map((s) => [s.label, "image" in s && s.image.data]),
		[
			["#4", "A"],
			["#5", "B"],
		],
	);
	// A photo sent from the Claude apps: no marker at all.
	assert.deepEqual(messageSources([{ type: "text", text: "look" }, image("C")], ROOT).map((s) => s.label), ["#1"]);
	assert.deepEqual(messageSources("just text", ROOT), []);
});

test("only file URLs and pi-image-view's scheme resolve to files", () => {
	assert.equal(referencePath("file:///tmp/a%20b.png", ROOT), "/tmp/a b.png");
	assert.equal(referencePath(`image-view://sha256/${SHA}.png`, ROOT), `${ROOT}/${SHA}.png`);
	assert.equal(referencePath("https://example.com/a.png", ROOT), undefined);
	assert.equal(referencePath("file://host/a.png", ROOT), undefined);
});

test("a read image keeps the file it read; other tools' images only have bytes", () => {
	const read = toolSources("read", { path: "shots/chart.png" }, [{ type: "text", text: "Read image file [image/png]" }, image()], "/work");
	assert.deepEqual(read, [{ id: "read", label: "chart.png", alt: "[chart.png]", path: "/work/shots/chart.png" }]);
	assert.deepEqual(toolSources("read", { path: "notes.md" }, [{ type: "text", text: "# notes" }], "/work"), []);
	const mcp = toolSources("mcp__argent__screenshot", {}, [{ type: "text", text: "{}" }, image("A"), image("B")], "/work");
	assert.deepEqual(
		mcp.map((s) => [s.id, s.label]),
		[
			["tool-0", "#1"],
			["tool-1", "#2"],
		],
	);
});

test("a draft marker's file comes from the options pi-image-view hangs on its editor", () => {
	const editor = {
		[Symbol.for("pi-image-view.draft-link-options")]: {
			draftReference: (marker: string) => (marker === "[Image #1]" ? `file://${ROOT}/${SHA}.png` : undefined),
		},
	};
	const tree = { children: [{ children: [] }, { children: [{ children: [editor] }] }] };
	const found = findDraftEditor(tree);
	assert.equal(found, editor);
	assert.equal(draftPath(found, 1, ROOT), `${ROOT}/${SHA}.png`);
	assert.equal(draftPath(found, 2, ROOT), undefined);
	assert.equal(findDraftEditor({ children: [{ children: [] }] }), undefined);
	assert.equal(draftPath(undefined, 1, ROOT), undefined);
});

test("Quick Look uses the helper from the environment, then the bundled one, then qlmanage", () => {
	const has = (...files: string[]) => (file: string) => files.includes(file);
	assert.deepEqual(quickLookArgv("/a.png", "/ext", { PI_IMAGE_VIEW_QUICKLOOK: "/nix/ql" }, has("/nix/ql", "/ext/bin/quicklook")), ["/nix/ql", "/a.png"]);
	assert.deepEqual(quickLookArgv("/a.png", "/ext", { PI_IMAGE_VIEW_QUICKLOOK: "/gone" }, has("/ext/bin/quicklook")), ["/ext/bin/quicklook", "/a.png"]);
	assert.deepEqual(quickLookArgv("/a.png", "/ext", {}, has()), ["/usr/bin/qlmanage", "-p", "/a.png"]);
});
