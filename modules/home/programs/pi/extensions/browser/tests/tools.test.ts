import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { claudeTools, piToolDefinitions, piToolName, stripSaveToDisk, TOOL_PREFIX } from "../tools.ts";

const NAMES = [
	"javascript_tool",
	"read_page",
	"find",
	"form_input",
	"computer",
	"browser_batch",
	"navigate",
	"resize_window",
	"gif_creator",
	"upload_image",
	"get_page_text",
	"tabs_context_mcp",
	"tabs_create_mcp",
	"tabs_close_mcp",
	"read_console_messages",
	"read_network_requests",
	"file_upload",
	"switch_browser",
	"list_connected_browsers",
	"select_browser",
];

test("the snapshot holds Claude Code's 20 Claude in Chrome tools", () => {
	assert.deepEqual(
		claudeTools().map((t) => t.name),
		NAMES,
	);
});

test("Pi's tools carry Claude Code's names, descriptions and schemas, deferred", () => {
	const defs = piToolDefinitions();
	assert.equal(defs.length, NAMES.length);
	for (const [i, tool] of claudeTools().entries()) {
		const def = defs[i]!;
		assert.equal(def.name, `mcp__claude-in-chrome__${tool.name}`);
		assert.equal(def.name, piToolName(tool.name));
		assert.equal(def.description, tool.description);
		assert.deepEqual(def.parameters, tool.inputSchema);
		assert.equal(def.exposure, "deferred");
	}
	assert.equal(TOOL_PREFIX, "mcp__claude-in-chrome__");
});

test("save_to_disk is the client's, not the extension's", () => {
	assert.deepEqual(stripSaveToDisk("computer", { action: "screenshot", tabId: 1, save_to_disk: true }), {
		args: { action: "screenshot", tabId: 1 },
		wantsSave: true,
	});
	assert.deepEqual(stripSaveToDisk("navigate", { url: "x", save_to_disk: true }), { args: { url: "x" }, wantsSave: false });
	assert.deepEqual(
		stripSaveToDisk("browser_batch", {
			actions: [
				{ name: "computer", input: { action: "screenshot", tabId: 1, save_to_disk: true } },
				{ name: "navigate", input: { url: "x" } },
			],
		}),
		{ args: { actions: [{ name: "computer", input: { action: "screenshot", tabId: 1 } }, { name: "navigate", input: { url: "x" } }] }, wantsSave: true },
	);
});

// The snapshot must stay what the installed Claude Code declares; skipped without it.
const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
test("the snapshot matches the installed Claude Code's tools/list", { skip: claude.status !== 0 && "claude not installed" }, async () => {
	const child = spawn("claude", ["--claude-in-chrome-mcp"], { stdio: ["pipe", "pipe", "ignore"] });
	let out = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
	send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
	send({ jsonrpc: "2.0", method: "notifications/initialized" });
	send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	const deadline = Date.now() + 20_000;
	let list: any;
	while (!list && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		list = out
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.find((m) => m.id === 2);
	}
	child.kill();
	assert.ok(list, "no tools/list reply");
	assert.deepEqual(list.result.tools, claudeTools(), `Claude Code ${claude.stdout.trim()} declares other tools: refresh claude-tools.json`);
});
