import assert from "node:assert/strict";
import { test } from "node:test";
import { Rows } from "../rows.ts";

// Pi's invalidate renders the row again on the spot, and its renderer remembers it again.
function row(rows: Rows, id: string, drawn: string[]) {
	const invalidate = () => {
		drawn.push(id);
		if (drawn.length > 100) throw new Error("redrawn without end");
		rows.remember(id, invalidate);
	};
	rows.remember(id, invalidate);
}

test("redrawAll draws each row once, though drawing one remembers it again", () => {
	const rows = new Rows(10);
	const drawn: string[] = [];
	row(rows, "a", drawn);
	row(rows, "b", drawn);
	rows.redrawAll();
	assert.deepEqual(drawn, ["a", "b"]);
});

test("remember keeps the most recently drawn rows", () => {
	const rows = new Rows(2);
	const drawn: string[] = [];
	row(rows, "a", drawn);
	row(rows, "b", drawn);
	rows.remember("a", () => drawn.push("a"));
	rows.remember("c", () => drawn.push("c"));
	rows.redrawAll();
	assert.deepEqual(drawn, ["a", "c"]);
});
