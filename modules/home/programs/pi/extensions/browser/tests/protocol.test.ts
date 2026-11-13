import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeClient } from "../client.ts";
import { classify, encodeFrame, FrameDecoder, toolRequest } from "../protocol.ts";

// Messages in the shapes Some Browser's extension (1.0.107) and Claude Code 2.1.322 exchanged.
const SESSION = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as { dir: "in" | "out"; message: any });

test("a frame is a little-endian length then the JSON", () => {
	const frame = encodeFrame({ a: "é" });
	assert.equal(frame.readUInt32LE(0), Buffer.byteLength('{"a":"é"}'));
	assert.equal(frame.subarray(4).toString("utf8"), '{"a":"é"}');
	assert.deepEqual([...frame.subarray(0, 4)], [10, 0, 0, 0]);
});

test("the recorded session decodes from one stream, cut anywhere", () => {
	const stream = Buffer.concat(SESSION.map(({ message }) => encodeFrame(message)));
	for (const step of [1, 3, 7, 64, stream.length]) {
		const decoder = new FrameDecoder();
		const out: unknown[] = [];
		for (let at = 0; at < stream.length; at += step) out.push(...decoder.push(stream.subarray(at, at + step)));
		assert.deepEqual(out, SESSION.map(({ message }) => message), `chunks of ${step}`);
		assert.equal(decoder.pending, 0);
	}
});

test("a length the host would refuse is an error", () => {
	const bad = Buffer.alloc(8);
	bad.writeUInt32LE(0, 0);
	assert.throws(() => new FrameDecoder().push(bad), /Invalid frame length 0/);
});

test("requests are built as Claude Code builds them", () => {
	for (const { dir, message } of SESSION.filter((m) => m.dir === "out")) {
		assert.equal(dir, "out");
		const { tool, args, tool_use_id, session_scope } = message.params;
		assert.deepEqual(toolRequest(tool, args, tool_use_id, session_scope ? { sessionScope: session_scope } : {}), message);
	}
	assert.deepEqual(toolRequest("navigate", {}, "x", { handlePermissionPrompts: true, permissionMode: "ask" }).params, {
		client_id: "claude-code",
		tool: "navigate",
		args: {},
		tool_use_id: "x",
		permission_mode: "ask",
		handle_permission_prompts: true,
	});
});

test("replies are responses, method frames are notifications", () => {
	for (const { message } of SESSION.filter((m) => m.dir === "in")) assert.equal(classify(message).kind, "response");
	assert.equal(classify({ method: "permission_request", params: { request_id: "r" } }).kind, "notification");
	assert.equal(classify({ hello: 1 }).kind, "unknown");
});

// A stand-in for the native host: like the real one, it relays each reply to every client.
function fakeHost(dir: string, reply: (request: any, broadcast: (m: unknown) => void) => void): Promise<Server> {
	const clients = new Set<Socket>();
	const broadcast = (m: unknown) => {
		for (const c of clients) c.write(encodeFrame(m));
	};
	const server = createServer((socket) => {
		clients.add(socket);
		const decoder = new FrameDecoder();
		socket.on("data", (chunk) => {
			for (const request of decoder.push(chunk)) reply(request, broadcast);
		});
		socket.on("close", () => clients.delete(socket));
	});
	return new Promise((resolve) => server.listen(join(dir, "1.sock"), () => resolve(server)));
}

test("two clients on one host each get only their own replies", async () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
	// Replies in reverse order, so each client sees the other's first.
	const queue: any[] = [];
	const server = await fakeHost(dir, (request, broadcast) => {
		queue.push(request);
		if (queue.length < 2) return;
		for (const r of queue.reverse()) broadcast({ tool_use_id: r.params.tool_use_id, result: { content: [{ type: "text", text: r.params.args.who }] } });
	});
	const find = async () => [{ path: join(dir, "1.sock"), pid: 1, mtimeMs: 0 }];
	const a = new BridgeClient({ findSockets: find });
	const b = new BridgeClient({ findSockets: find });
	try {
		await Promise.all([a.ensureConnected(), b.ensureConnected()]);
		const [ra, rb] = await Promise.all([a.callTool("find", { who: "a" }), b.callTool("find", { who: "b" })]);
		assert.equal((ra.result?.content as any)[0].text, "a");
		assert.equal((rb.result?.content as any)[0].text, "b");
	} finally {
		a.close();
		b.close();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a permission prompt for our call is answered, then the reply arrives", async () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
	const seen: any[] = [];
	const server = await fakeHost(dir, (request, broadcast) => {
		seen.push(request);
		if (request.method === "execute_tool") {
			broadcast({ method: "permission_request", params: { request_id: "p1", tool_use_id: request.params.tool_use_id, tool_type: "navigate", url: "http://127.0.0.1/" } });
		} else if (request.method === "permission_response") {
			const id = seen[0].params.tool_use_id;
			broadcast({ tool_use_id: id, result: { content: [{ type: "text", text: `allowed=${request.params.allowed}` }] } });
		}
	});
	const client = new BridgeClient({ findSockets: async () => [{ path: join(dir, "1.sock"), pid: 1, mtimeMs: 0 }] });
	try {
		const prompts: any[] = [];
		const response = await client.callTool("navigate", { url: "http://127.0.0.1/" }, { onPermissionRequest: (p) => (prompts.push(p), true) });
		assert.equal(seen[0].params.handle_permission_prompts, true);
		assert.equal(prompts[0].url, "http://127.0.0.1/");
		assert.deepEqual(seen[1], { method: "permission_response", params: { request_id: "p1", allowed: true } });
		assert.equal((response.result?.content as any)[0].text, "allowed=true");
	} finally {
		client.close();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no host socket: a clear error, not a hang", async () => {
	const client = new BridgeClient({ findSockets: async () => [] });
	await assert.rejects(client.callTool("tabs_context_mcp", {}), { name: "BrowserNotConnectedError", message: /not connected/ });
});
