import assert from "node:assert/strict";
import { test } from "node:test";
import { railOf, withMarker } from "../marker.ts";

const wrap = (text: string, width: number) => {
	const rows: string[] = [];
	for (let rest = text; rest; rest = rest.slice(width)) rows.push(rest.slice(0, width));
	return rows;
};

test("the marker follows a blank line under Pi's own rows", () => {
	assert.deepEqual(withMarker(["$ sleep 3", "", "done", "", "Took 3.0s"], "✓ finished in the background", 80, wrap), [
		"$ sleep 3",
		"",
		"done",
		"",
		"Took 3.0s",
		"",
		"✓ finished in the background",
	]);
});

test("under a Claude-style row, the marker is the next line in its body column", () => {
	assert.equal(railOf(["", "\x1b[38;2;9;9;9m   ⎿  \x1b[39mdone"]), 6);
	assert.equal(railOf(["done", "   ⎿  x"]), 0);
	assert.deepEqual(withMarker(["   ⎿  done", "      Took 3.0s"], "✓ finished", 14, wrap), ["   ⎿  done", "      Took 3.0s", "      ✓ finish", "      ed"]);
});
