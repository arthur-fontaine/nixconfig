// Tab names and tab dragging (k31). Pure, so `node --test` covers it; nix joins it into
// nix-tabs and nix-sidebar (no imports, `tab` prefix).

const tabBase = (p) => String(p).replace(/\/+$/, "").split("/").pop() || "/";

// The name a tab shows, in the bar and the sidebar alike. lead: its main pane
// ({ app, title, mod, cwd, program }); folder: its worktree's (or space's) folder.
export function tabLabel({ named, name, lead, folder }) {
  const pi = lead?.app === "pi";
  // "Pi" is what tabs started from + were named before k31: it reads as unnamed, whatever runs now.
  if (named && name !== "Pi") return name;
  if (pi) {
    const parts = String(lead.title ?? "").split(" - ");
    return parts[0] === "π" && parts.length > 2 ? parts.slice(1, -1).join(" - ") : "Pi";
  }
  if (lead?.mod) return lead.title || "Panel";
  const p = lead?.program;
  if (p && !p.shell && p.name) return p.name;
  if (!lead?.cwd) return "Terminal";
  const cwd = String(lead.cwd).replace(/\/+$/, ""), top = String(folder ?? "").replace(/\/+$/, "");
  if (top && cwd === top) return "Terminal";
  if (top && cwd.startsWith(top + "/")) return cwd.slice(top.length + 1);
  return tabBase(cwd);
}

// Where a dragged tab lands, from the tab under the pointer (its index among the shown tabs,
// the pointer along it, its length): the gap on the pointer's side of it, 0..n.
export function tabSlot(index, at, length) {
  return at < length / 2 ? index : index + 1;
}

// The drop slot as `tab.move`'s index: the tab's final place among all its space's tabs,
// from 1 (settled tabs aren't shown, so it goes through ids). null: it stays where it is.
export function tabMoveIndex(all, shown, id, slot) {
  const from = shown.indexOf(id);
  if (from < 0 || slot === from || slot === from + 1) return null;
  const rest = all.filter((x) => x !== id);
  const at = slot === 0 ? rest.indexOf(shown[0]) : rest.indexOf(shown[slot - 1]) + 1;
  return at + 1;
}
