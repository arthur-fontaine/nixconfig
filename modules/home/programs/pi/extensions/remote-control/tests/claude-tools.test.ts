import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeToolUse, claudeToolUseResult, imageSize, isImageFile, mimeType } from "../claude-tools.ts";

test("Pi's tools take Claude Code's names and inputs", () => {
	assert.deepEqual(claudeToolUse("read", { path: "a.png" }), { name: "Read", input: { file_path: "a.png" } });
	assert.deepEqual(claudeToolUse("edit", { path: "f", edits: [{ oldText: "a", newText: "b" }] }), {
		name: "Edit",
		input: { file_path: "f", old_string: "a", new_string: "b" },
	});
	assert.equal(claudeToolUse("edit", { path: "f", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }).name, "MultiEdit");
	assert.deepEqual(claudeToolUse("find", { pattern: "*.ts" }), { name: "Glob", input: { pattern: "*.ts" } });
	assert.equal(claudeToolUse("send_user_file", { files: ["x"] }).name, "SendUserFile");
	assert.deepEqual(claudeToolUse("mcp__x__y", { a: 1 }), { name: "mcp__x__y", input: { a: 1 } });
});

// A 3×2 PNG: signature, then the IHDR chunk with width and height.
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 0, 3, 0, 0, 0, 2]), Buffer.alloc(8)]);

test("image sizes come from the header", () => {
	assert.deepEqual(imageSize(png), { width: 3, height: 2 });
	const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0]);
	assert.deepEqual(imageSize(gif), { width: 5, height: 7 });
	assert.equal(imageSize(Buffer.from("not an image")), undefined);
});

test("a read image gets Read's tool_use_result, send_user_file its details", () => {
	const result = claudeToolUseResult("read", [{ type: "text", text: "Read image" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], undefined) as any;
	assert.equal(result.type, "image");
	assert.equal(result.file.type, "image/png");
	assert.deepEqual(result.file.dimensions, { originalWidth: 3, originalHeight: 2, displayWidth: 3, displayHeight: 2 });
	assert.equal(claudeToolUseResult("read", [{ type: "text", text: "code" }], undefined), undefined);
	const details = { attachments: [] };
	assert.equal(claudeToolUseResult("send_user_file", [], details), details);
});

test("file types", () => {
	assert.equal(mimeType("/a/B.JPG"), "image/jpeg");
	assert.equal(mimeType("x.unknown"), "application/octet-stream");
	assert.ok(isImageFile("a.webp") && !isImageFile("a.svg"));
});
