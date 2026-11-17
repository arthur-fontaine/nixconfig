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

// Whether tabLabel gave a folder (cut at its start when too long), not a name or a program.
export function tabLabelIsPath(tab) {
  const { named, name, lead, folder } = tab;
  if ((named && name !== "Pi") || lead?.app === "pi" || lead?.mod || !lead?.cwd) return false;
  if (lead.program && !lead.program.shell && lead.program.name) return false;
  return String(lead.cwd).replace(/\/+$/, "") !== String(folder ?? "").replace(/\/+$/, "");
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

// The wheel over the tab strip: Herdr's scroller takes horizontal swipes, and can only be moved
// to a child (ScrollHandle.scroll_to_item), so a vertical wheel steps one tab per 40 px.
// state { acc, index }; returns the new state and whether to scroll to index.
export function tabWheel({ acc, index }, dy, dx, count) {
  if (Math.abs(dy) <= Math.abs(dx)) return { acc, index, step: false };
  let a = acc + dy, i = index;
  while (a >= 40 && i < count - 1) { a -= 40; i++; }
  while (a <= -40 && i > 0) { a += 40; i--; }
  if (i === count - 1 && a > 0) a = 0;
  if (i === 0 && a < 0) a = 0;
  return { acc: a, index: i, step: i !== index };
}
