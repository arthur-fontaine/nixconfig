import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTER_WINDOW_MS, hcMessageOf, Inbox, Outbox } from "../inbox.ts";

// Bytes captured from `hc send` into a terminal reporting OSC 7501 status.
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const tagged = '<hc from="t4q hc-inbox">multi\nline "x"</hc>';

test("hc's tagged paste is a message, with or without reach", () => {
	assert.equal(hcMessageOf(paste(tagged)), tagged);
	const reach = '<hc from="t3 lead" reach="hc send t3 when done or stuck">Review x.rs</hc>';
	assert.equal(hcMessageOf(paste(reach)), reach);
	assert.equal(hcMessageOf(paste('<hc from="t3">a\r\nb</hc>')), '<hc from="t3">a\nb</hc>');
});

test("a person's paste stays theirs", () => {
	assert.equal(hcMessageOf(paste("plain text")), undefined);
	assert.equal(hcMessageOf(paste(`see ${tagged}`)), undefined);
	assert.equal(hcMessageOf(paste('<hc from="t3">unclosed')), undefined);
	assert.equal(hcMessageOf(tagged), undefined);
	assert.equal(hcMessageOf("\r"), undefined);
});

test("the paste and the Enter after it are taken, nothing more", () => {
	const inbox = new Inbox();
	assert.deepEqual(inbox.input(paste(tagged), 0), { consume: true, message: tagged });
	assert.deepEqual(inbox.input("\r", 200), { consume: true });
	assert.equal(inbox.input("\r", 300), undefined);
});

test("the user's typing between the paste and hc's Enter goes through", () => {
	const inbox = new Inbox();
	inbox.input(paste(tagged), 0);
	assert.equal(inbox.input("a", 50), undefined);
	assert.equal(inbox.input("\x1b[D", 60), undefined);
	assert.deepEqual(inbox.input("\r", 200), { consume: true });
});

test("an Enter long after the paste is the user's", () => {
	const inbox = new Inbox();
	inbox.input(paste(tagged), 0);
	assert.equal(inbox.input("\r", ENTER_WINDOW_MS + 1), undefined);
	assert.equal(inbox.input("\r", 0), undefined);
});

test("messages go now when idle, as steers during a run", () => {
	const sent: [string, string][] = [];
	let idle = true;
	const outbox = new Outbox((m, d) => sent.push([m, d]), () => idle);
	outbox.push("a");
	idle = false;
	outbox.push("b");
	assert.deepEqual(sent, [["a", "now"], ["b", "steer"]]);
});

test("messages wait for a compaction to end", () => {
	const sent: [string, string][] = [];
	const outbox = new Outbox((m, d) => sent.push([m, d]), () => true);
	outbox.compactionStarted();
	outbox.push("a");
	outbox.push("b");
	assert.deepEqual(sent, []);
	outbox.compactionEnded();
	assert.deepEqual(sent, [["a", "now"], ["b", "now"]]);
});
