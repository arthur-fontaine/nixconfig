import assert from "node:assert/strict";
import { test } from "node:test";
import { sendNow, waitingLines } from "../waiting.ts";

const queue = () => [
	{ eventId: "e1", uuid: "u1", content: "first" },
	{ eventId: "e2", uuid: "u2", content: "second" },
];

test("Send now during a run takes every waiting message, in order", () => {
	const q = queue();
	const { answer, take } = sendNow(q, "u2", true);
	assert.equal(answer, "delivering");
	assert.deepEqual(take.map((m) => m.uuid), ["u1", "u2"]);
	assert.equal(q.length, 0);
});

test("Send now without a name counts every waiting message", () => {
	const q = queue();
	assert.equal(sendNow(q, "", true).take.length, 2);
});

test("Send now on a message no longer waiting does nothing", () => {
	const q = queue();
	assert.deepEqual(sendNow(q, "u9", true), { answer: "nothing_waiting", take: [] });
	assert.equal(q.length, 2);
	assert.deepEqual(sendNow([], undefined, true), { answer: "nothing_waiting", take: [] });
});

test("Send now with no run leaves the messages to run in their turn", () => {
	const q = queue();
	assert.deepEqual(sendNow(q, "u1", false), { answer: "delivering", take: [] });
	assert.equal(q.length, 2);
});

test("waiting messages read as one line each, as Pi's queue", () => {
	assert.deepEqual(waitingLines(["look at\n\nthe problems  "]), ["Waiting (Claude app): look at the problems"]);
});
