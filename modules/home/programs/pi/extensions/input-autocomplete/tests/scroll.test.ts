import assert from "node:assert/strict";
import { test } from "node:test";
import { wheel } from "../scroll.ts";

test("wheel: nothing to scroll when every row is shown", () => {
	assert.equal(wheel({ offset: 0, visible: 9, total: 9, cursor: 3 }, -1), undefined);
	assert.equal(wheel({ offset: 0, visible: 9, total: 4, cursor: 3 }, 1), undefined);
});

test("wheel: up scrolls and takes the cursor along from the last row", () => {
	assert.deepEqual(wheel({ offset: 11, visible: 9, total: 20, cursor: 19 }, -3), { offset: 8, cursor: 16 });
});

test("wheel: the cursor stays where it is while still shown", () => {
	assert.deepEqual(wheel({ offset: 11, visible: 9, total: 20, cursor: 14 }, -2), { offset: 9, cursor: 14 });
});

test("wheel: stops at the first and last rows", () => {
	assert.deepEqual(wheel({ offset: 2, visible: 9, total: 20, cursor: 5 }, -10), { offset: 0, cursor: 5 });
	assert.deepEqual(wheel({ offset: 8, visible: 9, total: 20, cursor: 8 }, 10), { offset: 11, cursor: 11 });
});
