// The editable diff's figures: the hunks the diff tab's Neovim sends (diff.lua) as the
// model's, the text column under a click, the part of a line a selection covers. No Herdr
// imports, so `node --test` runs it; nix joins it into main.js after model.js.
import { markChanges } from "./model.js";

// Where a line's text starts in a row (the bar, the number, the sign) and a cell's width.
export const TEXT_X = 3 + 48 + 16;
export const CELL = 13 * 0.6;

// diff.lua's message for one file as the model's file fields: hunks of { kind, old, new,
// text } with their change blocks and changed words marked (model.js's markChanges).
export function liveFile(file, msg) {
  const hunks = (msg.hunks ?? []).map((h) => ({
    context: "", oldStart: h.oldStart, newStart: h.newStart,
    lines: h.lines.map(([kind, old, nu, text]) => {
      const line = { kind, text };
      if (old != null) line.old = old;
      if (nu != null) line.new = nu;
      return line;
    }),
  }));
  for (const h of hunks) markChanges(h.lines);
  const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
  return { ...file, hunks, add: msg.add ?? 0, del: msg.del ?? 0, lines, cut: false, modified: Boolean(msg.modified), live: true };
}

// The text column under x (from the row's left edge): the nearest gap between characters,
// `cell` the font's measured advance (CELL until the view has measured it).
export function columnAt(x, cell = CELL) {
  return Math.max(0, Math.round((x - TEXT_X) / cell));
}

// The columns [start, end) of line `n` (of `length` columns) a selection covers, or null.
// `sel`: { from: [line, col], to: [line, col], lines } with `lines` for whole lines; `to`
// is past the last selected cell (the editor's 'selection' is exclusive). A line crossed
// whole shows one cell more, for its line break.
export function selectedCols(sel, n, length) {
  if (!sel || n < sel.from[0] || n > sel.to[0]) return null;
  if (sel.lines) return [0, Math.max(length, 1)];
  const start = n === sel.from[0] ? sel.from[1] : 0;
  const end = n === sel.to[0] ? sel.to[1] : length + 1;
  return end > start ? [start, end] : null;
}

// Which files the diff tab's Neovim holds: text files still in the worktree, by absolute
// path, each with the HEAD path it is compared to (its old name when renamed).
export function editableFiles(files, root) {
  return files.filter((f) => !f.binary && f.status !== "D").map((f) => ({
    path: `${root}/${f.path}`, root, base: f.status === "R" && f.oldPath ? f.oldPath : f.path,
  }));
}

// A line's parts cut at columns (the caret, the selection's ends), each with the column it
// starts at: the caret goes in the text between two parts, where the layout puts it.
export function cutAt(parts, cols) {
  const at = [...new Set(cols.filter((c) => c != null))].sort((a, b) => a - b);
  const out = [];
  let col = 0;
  for (const p of parts) {
    const end = col + p.text.length;
    let from = col;
    for (const c of at) if (c > from && c < end) { out.push({ ...p, text: p.text.slice(from - col, c - col), col: from }); from = c; }
    out.push({ ...p, text: p.text.slice(from - col), col: from });
    col = end;
  }
  return out;
}
