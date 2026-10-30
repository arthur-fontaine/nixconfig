import assert from "node:assert/strict";
import { test } from "node:test";
import { addressees, matchingPeers, mentionAt, type Peer } from "../mentions.ts";

const peers: Peer[] = [
	{ name: "api-worker", cwd: "/api" },
	{ name: "Research", cwd: "/docs" },
	{ name: "subagent-chat-1a2b", cwd: "/x", unnamed: true },
	{ name: "api", cwd: "/api" },
];

test("mentionAt reads the @ word ending at the cursor", () => {
	assert.equal(mentionAt("@ap", 3), "@ap");
	assert.equal(mentionAt("ask @re", 7), "@re");
	assert.equal(mentionAt("ask @", 5), "@");
	assert.equal(mentionAt("mail a@b", 8), undefined);
	assert.equal(mentionAt("@api hello", 10), undefined);
	assert.equal(mentionAt("@api hello", 4), "@api");
});

test("matchingPeers filters by prefix, named sessions first", () => {
	assert.deepEqual(
		matchingPeers(peers, "@").map((p) => p.name),
		["api", "api-worker", "Research", "subagent-chat-1a2b"],
	);
	assert.deepEqual(
		matchingPeers(peers, "@API-").map((p) => p.name),
		["api-worker"],
	);
});

test("addressees drops leading mentions and keeps inline ones", () => {
	assert.deepEqual(addressees("@api-worker run the tests", peers), { to: ["api-worker"], message: "run the tests" });
	assert.deepEqual(addressees("@api-worker, @research: sync up", peers), { to: ["api-worker", "Research"], message: "sync up" });
	assert.deepEqual(addressees("can you ask @research, please?", peers), { to: ["Research"], message: "can you ask @research, please?" });
});

test("addressees ignores unknown names, emails and empty messages", () => {
	assert.equal(addressees("@src/index.ts explain this", peers), undefined);
	assert.equal(addressees("write to me@api please", peers), undefined);
	assert.equal(addressees("@api", peers), undefined);
	assert.equal(addressees("no mention", peers), undefined);
});

test("addressees matches whole names only", () => {
	assert.deepEqual(addressees("@api hi", peers), { to: ["api"], message: "hi" });
	assert.equal(addressees("@ap hi", peers), undefined);
});
