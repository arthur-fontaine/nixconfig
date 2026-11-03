// Opening a file in the editor (nix-editor), for the panels. There is one editor and every
// file opens in it, as a tab of its own tab strip (or beside the current one with `side`):
// two live nix-editor views crash Herdr (its script runtime frees one view's objects while
// it still draws them), so a second editor tab is never made while one exists.
// `h` is the herdr module (spaces, panes, run, shared, setShared, notify): nix joins this
// file into each mod's main.js, where those are already imported.

export function openInEditor(h, file, { line = null, side = false } = {}) {
  const here = h.spaces().find((s) => s.active);
  if (!here) return;
  const name = file.split("/").pop();
  // This space's editor first: tabs from before there was one editor can still be around.
  const editors = h.panes().filter((p) => p.mod === "nix-editor");
  const pane = editors.find((p) => here.tabs.some((t) => t.id === p.tab)) ?? editors[0];
  const space = pane && h.spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
  if (pane && space && space.id !== here.id && !h.shared("nix-editor.state")?.modified) {
    // Nothing unsaved over there: the editor moves here.
    h.run("tab.close", { id: pane.tab, confirmed: true });
  } else if (pane) {
    h.setShared("nix-editor.goto", { tab: pane.tab, file, line, side, n: Date.now() });
    h.run("tab.select", { id: pane.tab });
    if (space && space.id !== here.id) {
      h.notify({ title: `${name} opened in ${space.name}`, body: "The editor there has unsaved changes.", level: "info" });
    }
    return;
  }
  h.run("tab.new", { name, mod: "nix-editor", props: { file, ...(line ? { line } : {}) } });
}
