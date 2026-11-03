import assert from "node:assert/strict";
import { test } from "node:test";
import { displayEntries, INITIAL_RENDER } from "../display.ts";
import { wrap } from "../index.ts";

const e = (type: string, id: string) => ({ type, id });
const branch = [e("message", "a"), e("message", "b"), e("compaction", "c1"), e("message", "d"), e("compaction", "c2"), e("message", "f")];
const context = [e("compaction", "c2"), e("message", "d"), e("message", "f")];

test("without a compaction, the chat shows what Pi would", () => {
	const plain = [e("message", "a")];
	assert.equal(displayEntries(plain, plain, true), plain);
});

test("a chat drawn from scratch shows the whole branch, compactions where they happened", () => {
	assert.deepEqual(displayEntries(context, branch, true).map((x) => x.id), ["a", "b", "c1", "d", "c2", "f"]);
});

test("after a live compaction, Pi gets that compaction first, then everything else", () => {
	assert.deepEqual(displayEntries(context, branch, false).map((x) => x.id), ["c2", "a", "b", "c1", "d", "f"]);
});

test("the redraw methods are told apart from the compaction handlers", () => {
	assert.ok(INITIAL_RENDER.test("at InteractiveMode.renderInitialMessages (file.js:1:2)"));
	assert.ok(INITIAL_RENDER.test("at rebuildChatFromMessages (chunk.js:3:4)"));
	assert.ok(!INITIAL_RENDER.test("at handleEvent (chunk.js:3:4)"));
});

test("wrapping the class: once, and through the caller's stack", () => {
	class Manager {
		buildContextEntries() { return context; }
		getBranch() { return branch; }
	}
	wrap(Manager.prototype);
	wrap(Manager.prototype);
	const m = new Manager();
	const renderInitialMessages = () => m.buildContextEntries();
	assert.deepEqual(renderInitialMessages().map((x) => x.id), ["a", "b", "c1", "d", "c2", "f"]);
	assert.deepEqual(m.buildContextEntries().map((x) => x.id), ["c2", "a", "b", "c1", "d", "f"]);
});
