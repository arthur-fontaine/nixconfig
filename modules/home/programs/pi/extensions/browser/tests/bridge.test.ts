import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeWsClient, type SocketLike } from "../bridge.ts";

// A stand-in for wss://bridge.claudeusercontent.com, answering as the bridge and
// the extension do in Claude Code 2.1.322's client (the shapes its handleMessage reads).
class FakeBridge implements SocketLike {
	sent: any[] = [];
	url: string;
	private listeners: Record<string, ((e: any) => void)[]> = {};
	extensions = [{ deviceId: "dev-mac-1", name: "Some Browser", osPlatform: "macOS", connectedAt: 2 }];
	onToolCall: (frame: any) => void = (frame) => this.reply({ type: "tool_result", tool_use_id: frame.tool_use_id, content: [{ type: "text", text: `ran ${frame.tool}` }] });
	constructor(url: string) {
		this.url = url;
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type: string, fn: (e: any) => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	emit(type: string, e: any) {
		for (const fn of this.listeners[type] ?? []) fn(e);
	}
	reply(m: unknown) {
		queueMicrotask(() => this.emit("message", { data: JSON.stringify(m) }));
	}
	send(data: string) {
		const m = JSON.parse(data);
		this.sent.push(m);
		if (m.type === "connect") this.reply({ type: "paired" });
		else if (m.type === "list_extensions") this.reply({ type: "extensions_list", extensions: this.extensions });
		else if (m.type === "tool_call") {
			this.reply({ type: "routing_ack", tool_use_id: m.tool_use_id });
			this.onToolCall(m);
		}
	}
	close() {
		this.emit("close", { code: 1000 });
	}
}

function setup(extra: Partial<ConstructorParameters<typeof BridgeWsClient>[0]> = {}) {
	let bridge: FakeBridge | undefined;
	const client = new BridgeWsClient({
		credentials: async () => ({ accessToken: "tok-test", accountUuid: "acct-1234" }),
		createSocket: (url) => (bridge = new FakeBridge(url)),
		...extra,
	});
	return { client, bridge: () => bridge! };
}

test("connects to /chrome/<account> and introduces itself as Claude Code does", async () => {
	const { client, bridge } = setup();
	await client.ensureConnected();
	assert.equal(bridge().url, "wss://bridge.claudeusercontent.com/chrome/acct-1234");
	assert.deepEqual(bridge().sent[0], { type: "connect", client_type: "claude-code", oauth_token: "tok-test" });
	client.close();
});

test("a tool call targets the selected extension and carries Claude Code's fields", async () => {
	const { client, bridge } = setup();
	const response = await client.callTool("navigate", { url: "http://127.0.0.1/", tabId: 7 }, { sessionScope: { sessionId: "s1" }, onPermissionRequest: () => true });
	const call = bridge().sent.find((m) => m.type === "tool_call");
	assert.deepEqual(Object.keys(call).sort(), [
		"args",
		"client_type",
		"handle_permission_prompts",
		"permission_mode",
		"session_scope",
		"supports_tool_result_error_code",
		"supports_tool_result_notices",
		"target_device_id",
		"tool",
		"tool_use_id",
		"type",
	]);
	assert.equal(call.target_device_id, "dev-mac-1");
	assert.equal(call.permission_mode, "ask");
	assert.equal(call.handle_permission_prompts, true);
	assert.deepEqual(call.session_scope, { sessionId: "s1" });
	assert.deepEqual(response, { tool_use_id: call.tool_use_id, result: { content: [{ type: "text", text: "ran navigate" }] } });
	client.close();
});

test("the extension's permission prompt for our call is answered, then the result comes", async () => {
	const prompts: any[] = [];
	const { client, bridge } = setup();
	await client.ensureConnected();
	bridge().onToolCall = (frame) => {
		bridge().reply({ type: "permission_request", tool_use_id: "someone-else", request_id: "r0", tool_type: "navigate", url: "https://x/" });
		bridge().reply({ type: "permission_request", tool_use_id: frame.tool_use_id, request_id: "r1", tool_type: "navigate", url: "http://127.0.0.1/" });
		const wait = setInterval(() => {
			const answer = bridge().sent.find((m) => m.type === "permission_response");
			if (!answer) return;
			clearInterval(wait);
			bridge().reply({ type: "tool_result", tool_use_id: frame.tool_use_id, content: [{ type: "text", text: `allowed=${answer.allowed}` }] });
		}, 2);
	};
	const response = await client.callTool("navigate", { url: "http://127.0.0.1/", tabId: 7 }, { onPermissionRequest: (p) => (prompts.push(p), true) });
	assert.deepEqual(prompts.map((p) => p.url), ["http://127.0.0.1/"], "only our call's prompt reaches the handler");
	assert.deepEqual(
		bridge().sent.filter((m) => m.type === "permission_response"),
		[{ type: "permission_response", request_id: "r1", allowed: true, target_device_id: "dev-mac-1" }],
	);
	assert.equal((response.result!.content as any)[0].text, "allowed=true");
	client.close();
});

test("an error result is an error; a ping gets a pong", async () => {
	const { client, bridge } = setup();
	await client.ensureConnected();
	bridge().onToolCall = (frame) => bridge().reply({ type: "tool_result", tool_use_id: frame.tool_use_id, is_error: true, content: [{ type: "text", text: "Tab 7 no longer exists" }] });
	const response = await client.callTool("find", { query: "x", tabId: 7 });
	assert.deepEqual(response.error, { content: [{ type: "text", text: "Tab 7 no longer exists" }] });
	bridge().reply({ type: "ping" });
	await new Promise((r) => setTimeout(r, 5));
	assert.ok(bridge().sent.some((m) => m.type === "pong"));
	client.close();
});

test("several browsers: this Mac's, most recently connected, unless one is chosen", async () => {
	const { client, bridge } = setup();
	await client.ensureConnected();
	bridge().extensions = [
		{ deviceId: "dev-win", name: "Chrome", osPlatform: "Windows", connectedAt: 9 },
		{ deviceId: "dev-mac-old", name: "Chrome", osPlatform: "macOS", connectedAt: 1 },
		{ deviceId: "dev-mac-new", name: "Some Browser", osPlatform: "macOS", connectedAt: 5 },
	];
	await client.callTool("tabs_context_mcp", {});
	assert.equal(bridge().sent.at(-1).target_device_id, "dev-mac-new");
	client.select("dev-win");
	await client.callTool("tabs_context_mcp", {});
	assert.equal(bridge().sent.at(-1).target_device_id, "dev-win");
	assert.deepEqual((await client.listExtensions()).map((e) => e.deviceId), ["dev-win", "dev-mac-old", "dev-mac-new"]);
	client.close();
});

test("no extension on the bridge: a clear error", async () => {
	const { client, bridge } = setup({ discoveryWaitMs: 20 });
	await client.ensureConnected();
	bridge().extensions = [];
	await assert.rejects(client.callTool("tabs_context_mcp", {}), { name: "BrowserNotConnectedError", message: /No browser with the Claude extension/ });
	client.close();
});

test("no Claude Code login: the loader's message, no socket opened", async () => {
	let opened = false;
	const client = new BridgeWsClient({
		credentials: async () => {
			throw new Error("The Claude Code login has expired. Start `claude` once to refresh it.");
		},
		createSocket: (url) => ((opened = true), new FakeBridge(url)),
	});
	await assert.rejects(client.callTool("tabs_context_mcp", {}), /Start `claude` once/);
	assert.equal(opened, false);
});
