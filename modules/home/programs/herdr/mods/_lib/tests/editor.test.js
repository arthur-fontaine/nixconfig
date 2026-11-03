import assert from "node:assert/strict";
import { test } from "node:test";
import { openInEditor } from "../editor.js";

// A fake herdr: spaces with their tabs, the editor's pane (if any), the shared values,
// and every run/notify call.
function herdr({ editorIn = null, modified = false } = {}) {
  const calls = [];
  const values = { "nix-editor.state": { modified } };
  const spaces = [
    { id: "here", name: "here", active: true, tabs: [{ id: "t1" }, ...(editorIn === "here" ? [{ id: "ed" }] : [])] },
    { id: "there", name: "api", active: false, tabs: [{ id: "t2" }, ...(editorIn === "there" ? [{ id: "ed" }] : [])] },
  ];
  return {
    calls,
    values,
    spaces: () => spaces,
    panes: () => (editorIn ? [{ pane: "p1", tab: "t1" }, { pane: "p2", mod: "nix-editor", tab: "ed" }] : [{ pane: "p1", tab: "t1" }]),
    run: (name, args) => calls.push([name, args]),
    notify: (n) => calls.push(["notify", n]),
    shared: (k) => values[k],
    setShared: (k, v) => { values[k] = v; },
  };
}

test("no editor: a new editor tab with the file", () => {
  const h = herdr();
  openInEditor(h, "/r/src/a.ts", { line: 3 });
  assert.deepEqual(h.calls, [["tab.new", { name: "a.ts", mod: "nix-editor", props: { file: "/r/src/a.ts", line: 3 } }]]);
});

test("the editor in this space: the file goes to it, no second editor", () => {
  const h = herdr({ editorIn: "here" });
  openInEditor(h, "/r/b.ts", { side: true });
  assert.deepEqual(h.calls, [["tab.select", { id: "ed" }]]);
  const goto = h.values["nix-editor.goto"];
  assert.equal(goto.file, "/r/b.ts");
  assert.equal(goto.tab, "ed");
  assert.equal(goto.side, true);
  assert.equal(goto.line, null);
});

test("editors in two spaces (from before): this space's gets the file", () => {
  const h = herdr({ editorIn: "there" });
  h.spaces()[0].tabs.push({ id: "ed2" });
  const panes = h.panes();
  h.panes = () => [...panes, { pane: "p3", mod: "nix-editor", tab: "ed2" }];
  openInEditor(h, "/r/b.ts");
  assert.deepEqual(h.calls, [["tab.select", { id: "ed2" }]]);
});

test("the editor in another space, nothing unsaved: it moves here", () => {
  const h = herdr({ editorIn: "there" });
  openInEditor(h, "/r/b.ts");
  assert.deepEqual(h.calls.map((c) => c[0]), ["tab.close", "tab.new"]);
  assert.equal(h.calls[0][1].id, "ed");
});

test("the editor in another space with unsaved changes: the file opens there, with a note", () => {
  const h = herdr({ editorIn: "there", modified: true });
  openInEditor(h, "/r/b.ts", { line: 9 });
  assert.deepEqual(h.calls.map((c) => c[0]), ["tab.select", "notify"]);
  assert.equal(h.values["nix-editor.goto"].line, 9);
  assert.match(h.calls[1][1].title, /b\.ts opened in api/);
});
