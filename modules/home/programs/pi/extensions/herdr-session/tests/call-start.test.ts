import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { CALL_START } from "../index.ts";

function fake() {
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, h: (event: unknown) => unknown) => handlers.set(name, h),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	extension(pi as never);
	return { call: handlers.get("tool_call")!, entries };
}

test("a top-level call's start is recorded, never blocking it", () => {
	const { call, entries } = fake();
	const before = Date.now();
	assert.equal(call({ toolCallId: "t1", toolName: "bash", input: {} }), undefined);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, CALL_START);
	const data = entries[0].data as { toolCallId: string; at: number };
	assert.equal(data.toolCallId, "t1");
	assert.ok(data.at >= before && data.at <= Date.now());
});

test("a script's step has no row of its own: no marker", () => {
	const { call, entries } = fake();
	call({ toolCallId: "t1/1", parentToolCallId: "t1", toolName: "bash", input: {} });
	assert.equal(entries.length, 0);
});

test("a failing appendEntry doesn't break the call", () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	extension({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h), appendEntry: () => { throw new Error("x"); } } as never);
	assert.equal(handlers.get("tool_call")!({ toolCallId: "t1", toolName: "bash", input: {} }), undefined);
});
