import { test } from "node:test";
import assert from "node:assert/strict";
import { paneRadius } from "../pane.js";

// A mod shown as a tab in main rounds its own fills by the layout's pane radius (a fill isn't clipped by its frame).
test("paneRadius: the main block's pane radius, 0 when none", () => {
  const islands = { id: "root", children: [{ id: "work", children: [{ id: "main", content: { tab: "active", pane: { radius: 9 } } }] }] };
  assert.equal(paneRadius(islands), 9);
  assert.equal(paneRadius({ id: "root", children: [{ id: "main", content: { pane: { radius: 0 } } }] }), 0);
  assert.equal(paneRadius({ id: "root", children: [{ id: "main", content: { tab: "active" } }] }), 0);
  assert.equal(paneRadius(null), 0);
});
