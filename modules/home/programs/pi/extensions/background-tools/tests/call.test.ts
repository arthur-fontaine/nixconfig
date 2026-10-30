import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallEvents, DetachableCall, type Execute, type Outcome } from "../call.ts";
import type { Result } from "../records.ts";
import { placeholderStart } from "../records.ts";

const text = (value: string): Result => ({ content: [{ type: "text", text: value }], details: undefined });

// An operation that prints when told to and ends when told to, or fails when aborted.
function controllable() {
	let update!: (partial: Result) => void;
	let finish!: (result: Result) => void;
	let signal!: AbortSignal;
	const execute: Execute = (runSignal, onUpdate) => {
		signal = runSignal;
		update = onUpdate;
		return new Promise((resolve, reject) => {
			finish = resolve;
			runSignal.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
		});
	};
	return { execute, update: (value: string) => update(text(value)), finish: (value: string) => finish(text(value)), signal: () => signal };
}

function recorder() {
	const seen: string[] = [];
	const ended: Outcome[] = [];
	const events: CallEvents = {
		detached: () => seen.push("detached"),
		updated: (call) => seen.push(`updated:${(call.latest?.content[0] as { text: string }).text}`),
		ended: (_call, outcome) => {
			seen.push("ended");
			ended.push(outcome);
		},
	};
	return { events, seen, ended };
}

test("in the foreground a call is the tool's own execution", async () => {
	const op = controllable();
	const { events, seen } = recorder();
	const call = new DetachableCall("call_1", "bash", events);
	const forwarded: string[] = [];
	const running = call.run(op.execute, undefined, (partial) => forwarded.push((partial.content[0] as { text: string }).text));
	op.update("a");
	op.finish("done");
	assert.deepEqual(await running, text("done"));
	assert.deepEqual(forwarded, ["a"]);
	assert.deepEqual(seen, [], "no background events for a foreground call");
	assert.equal(call.detach(), false, "an ended call can't be detached");
});

test("a foreground failure rejects like the tool, and the turn's abort reaches it", async () => {
	const op = controllable();
	const turn = new AbortController();
	const call = new DetachableCall("call_1", "bash", recorder().events);
	const running = call.run(op.execute, turn.signal, undefined);
	turn.abort();
	await assert.rejects(running, /Command aborted/);
});

test("detaching returns a placeholder at once and keeps the operation going", async () => {
	const op = controllable();
	const turn = new AbortController();
	const { events, seen, ended } = recorder();
	const call = new DetachableCall("call_1", "bash", events);
	const forwarded: unknown[] = [];
	const running = call.run(op.execute, turn.signal, (partial) => forwarded.push(partial));
	op.update("before");
	assert.equal(call.detach(), true);
	assert.equal(call.detach(), false, "only once");
	const result = await running;
	assert.equal(placeholderStart(result.details), call.startedAt);
	turn.abort();
	assert.equal(op.signal().aborted, false, "the turn's abort no longer reaches a detached call");
	assert.equal(call.latest?.content[0]?.type, "text");
	op.update("after");
	op.finish("done");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(forwarded.length, 1, "updates stop reaching the finished row");
	assert.deepEqual(seen, ["detached", "updated:after", "ended"]);
	assert.deepEqual(ended, [{ result: text("done"), isError: false }]);
	assert.equal(call.running, false);
});

test("stopping a detached call aborts it and reports how it ended", async () => {
	const op = controllable();
	const { events, ended } = recorder();
	const call = new DetachableCall("call_1", "bash", events);
	const running = call.run(op.execute, undefined, undefined);
	call.detach();
	await running;
	const outcome = await call.stop();
	assert.equal(op.signal().aborted, true);
	assert.equal(outcome?.isError, true);
	assert.match((outcome?.result.content[0] as { text: string }).text, /aborted/);
	assert.equal(call.stopped, true);
	assert.equal(ended.length, 1, "the stopped outcome is still reported");
	assert.equal(await call.stop(), undefined, "an ended call can't be stopped again");
});

test("a foreground call can't be stopped, and a closed call reports nothing", async () => {
	const op = controllable();
	const { events, ended } = recorder();
	const call = new DetachableCall("call_1", "bash", events);
	const running = call.run(op.execute, undefined, undefined);
	assert.equal(await call.stop(), undefined);
	call.detach();
	await running;
	call.close();
	assert.equal(op.signal().aborted, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(ended, []);
	assert.equal(call.running, false);
});

test("a tool that throws before returning fails like it would in the foreground", async () => {
	const call = new DetachableCall("call_1", "bash", recorder().events);
	await assert.rejects(
		call.run(
			() => {
				throw new Error("bad input");
			},
			undefined,
			undefined,
		),
		/bad input/,
	);
});
