import { test } from "node:test";
import assert from "node:assert/strict";
import { sidebarState, sidebarReopen, sidebarFold, sidebarToggleInBar } from "../sidebar.js";

test("sidebar: hidden, rail (under 160) or open", () => {
  assert.equal(sidebarState({ hidden: true, size: { px: 256 } }), "hidden");
  assert.equal(sidebarState({ hidden: false, size: { px: 76 } }), "rail");
  assert.equal(sidebarState({ size: { px: 256 } }), "open");
  assert.equal(sidebarState(null), "open");
});
test("sidebar: reopening a hidden one shows it; a hidden rail is widened too", () => {
  assert.deepEqual(sidebarReopen({ hidden: true, size: { px: 256 } }, 300), [["layout.show", { id: "sidebar" }]]);
  assert.deepEqual(sidebarReopen({ hidden: true, size: { px: 76 } }, 300), [["layout.show", { id: "sidebar" }], ["layout.resize", { id: "sidebar", px: 300 }]]);
});
test("sidebar: reopening a rail widens it to the saved width, else 256", () => {
  assert.deepEqual(sidebarReopen({ size: { px: 76 } }, 300), [["layout.resize", { id: "sidebar", px: 300 }]]);
  assert.deepEqual(sidebarReopen({ size: { px: 44 } }, undefined), [["layout.resize", { id: "sidebar", px: 256 }]]);
  assert.deepEqual(sidebarReopen({ size: { px: 256 } }, 300), []);
});
test("sidebar: folding goes to a rail wide enough for the macOS traffic lights", () => {
  assert.equal(sidebarFold("macos"), 76);
  assert.equal(sidebarFold("linux"), 44);
});
test("sidebar: the bar shows its toggle when the sidebar has none of its own", () => {
  assert.equal(sidebarToggleInBar("hidden", "linux"), true);
  assert.equal(sidebarToggleInBar("rail", "macos"), true);
  assert.equal(sidebarToggleInBar("rail", "linux"), false);
  assert.equal(sidebarToggleInBar("open", "macos"), false);
});
