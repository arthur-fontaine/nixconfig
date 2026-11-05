import assert from "node:assert/strict";
import { test } from "node:test";

import { charIndex, Grid, hex, nvimKey } from "../grid.js";

const text = (g: Grid, row: number, id = 1) => g.grids.get(id)!.lines[row].map((c) => c[0]).join("");

test("grid_line carries the highlight over and repeats cells", () => {
  const g = new Grid();
  g.apply([["grid_resize", [1, 6, 2]]]);
  const flushed = g.apply([["grid_line", [1, 0, 0, [["a", 3], ["b"], [" ", 0, 2], ["c", 4]]]], ["flush", []]]);
  assert.equal(flushed, true);
  assert.equal(text(g, 0), "ab  c ");
  assert.deepEqual(g.grids.get(1)!.lines[0].map((c) => c[1]), [3, 3, 0, 0, 4, 0]);
  assert.deepEqual(g.runs(1, 0), [
    { col: 0, cells: 2, text: "ab", hl: 3 },
    { col: 2, cells: 2, text: "  ", hl: 0 },
    { col: 4, cells: 1, text: "c", hl: 4 },
    { col: 5, cells: 1, text: " ", hl: 0 },
  ]);
});

test("grid_scroll moves a region up and down", () => {
  const g = new Grid();
  g.apply([["grid_resize", [1, 3, 4]]]);
  for (let r = 0; r < 4; r++) g.apply([["grid_line", [1, r, 0, [[String(r), 0, 3]]]]]);
  g.apply([["grid_scroll", [1, 0, 4, 0, 3, 1, 0]]]);
  assert.deepEqual([0, 1, 2].map((r) => text(g, r)), ["111", "222", "333"]);
  g.apply([["grid_scroll", [1, 0, 4, 0, 3, -2, 0]]]);
  assert.deepEqual([2, 3].map((r) => text(g, r)), ["111", "222"]);
});

test("resize keeps what fits; clear blanks", () => {
  const g = new Grid();
  g.apply([["grid_resize", [1, 2, 1]], ["grid_line", [1, 0, 0, [["x", 1], ["y", 1]]]]]);
  g.apply([["grid_resize", [1, 3, 2]]]);
  assert.equal(text(g, 0), "xy ");
  assert.equal(text(g, 1), "   ");
  g.apply([["grid_clear", [1]]]);
  assert.equal(text(g, 0), "   ");
});

test("styles fall back to the defaults and reverse swaps", () => {
  const g = new Grid();
  g.apply([["default_colors_set", [0xffffff, 0x111214, 0xff0000, 0, 0]], ["hl_attr_define", [5, { foreground: 0x5e6ad2, reverse: true, undercurl: true }, {}, []]]]);
  assert.equal(hex(0x111214), "#111214");
  const s = g.style(5);
  assert.equal(s.fg, "#111214");
  assert.equal(s.bg, "#5e6ad2");
  assert.equal(s.undercurl, true);
  assert.equal(g.style(0).fg, "#ffffff");
});

test("cursor shape follows the mode", () => {
  const g = new Grid();
  g.apply([["mode_info_set", [true, [{ name: "normal", cursor_shape: "block", cell_percentage: 0 }, { name: "insert", cursor_shape: "vertical", cell_percentage: 25 }]]], ["mode_change", ["insert", 1]]]);
  assert.deepEqual(g.cursorShape(), { shape: "vertical", percentage: 25, name: "insert" });
});

test("popup menu shows, selects and hides", () => {
  const g = new Grid();
  g.apply([["popupmenu_show", [[["foo", "f", "", ""]], -1, 3, 4, 2]], ["popupmenu_select", [0]]]);
  assert.equal(g.popup?.grid, 2);
  assert.equal(g.popup?.selected, 0);
  g.apply([["popupmenu_hide", []]]);
  assert.equal(g.popup, null);
});

const ev = (key: string, mods: Partial<Record<"shift" | "control" | "alt" | "platform", boolean>> = {}, key_char?: string) =>
  ({ key, key_char, keystroke: key, modifiers: { shift: false, control: false, alt: false, platform: false, function: false, ...mods } });

test("keys become Neovim notation", () => {
  assert.equal(nvimKey(ev("a", {}, "a")), "a");
  assert.equal(nvimKey(ev("a", { shift: true }, "A")), "A");
  assert.equal(nvimKey(ev(",", {}, "<")), "<lt>");
  assert.equal(nvimKey(ev("e", { alt: true }, "é")), "é");
  assert.equal(nvimKey(ev("enter")), "<CR>");
  assert.equal(nvimKey(ev("left", { alt: true })), "<A-Left>");
  assert.equal(nvimKey(ev("s", { platform: true }, "s")), "<D-s>");
  assert.equal(nvimKey(ev("z", { platform: true, shift: true }, "Z")), "<D-S-z>");
  assert.equal(nvimKey(ev("a", { control: true }, "a")), "<C-a>");
  assert.equal(nvimKey(ev("f12")), "<F12>");
  assert.equal(nvimKey(ev("space", {}, " ")), "<Space>");
  assert.equal(nvimKey(ev("shift")), null);
});

test("messages: the latest is kept, errors flagged, msg_clear empties", () => {
  const g = new Grid();
  g.apply([["msg_show", ["emsg", [[0, "E492: Not an editor command"]], false]]]);
  assert.deepEqual(g.message, { kind: "emsg", text: "E492: Not an editor command", error: true });
  g.apply([["msg_show", ["", [[0, '"x.ts" 3L written']], true]]]);
  assert.equal(g.message?.error, false);
  g.apply([["msg_clear", []]]);
  assert.equal(g.message, null);
});

test("cmdline: shown with its prefix, cursor in characters, hidden", () => {
  const g = new Grid();
  g.apply([["cmdline_show", [[[0, "café"]], 5, "/", "", 0, 1]]]);
  assert.deepEqual(g.cmdline, { lead: "/", text: "café", pos: 4 });
  g.apply([["cmdline_pos", [3, 1]]]);
  assert.equal(g.cmdline?.pos, 3);
  g.apply([["cmdline_hide", [1, false]]]);
  assert.equal(g.cmdline, null);
  assert.equal(charIndex("aé", 3), 2);
});

test("multigrid: windows are placed, floats float, the cursor names its grid", () => {
  const g = new Grid();
  g.apply([
    ["grid_resize", [1, 20, 10], [2, 20, 9], [4, 8, 2]],
    ["win_pos", [2, 1000, 0, 0, 20, 9]],
    ["win_float_pos", [4, 1001, "NW", 2, 3, 5, true, 50, 1, 3, 5]],
    ["grid_line", [2, 0, 0, [["a", 0, 20]]], [4, 0, 0, [["h", 0, 8]]]],
    ["grid_cursor_goto", [2, 1, 2]],
  ]);
  assert.deepEqual(g.windows().map((w) => w.id), [1, 2]);
  assert.deepEqual(g.floats().map((f) => [f.id, f.row, f.col]), [[4, 3, 5]]);
  assert.deepEqual(g.cursor, { grid: 2, row: 1, col: 2 });
  assert.equal(text(g, 0, 4), "hhhhhhhh");
  // The pointer over the float reaches the float, elsewhere the window.
  assert.deepEqual(g.at(3, 6), { grid: 4, row: 0, col: 1 });
  assert.deepEqual(g.at(0, 0), { grid: 2, row: 0, col: 0 });
  g.apply([["win_hide", [4]]]);
  assert.deepEqual(g.floats(), []);
  g.apply([["win_close", [2]]]);
  assert.deepEqual(g.windows().map((w) => w.id), [1]);
});

test("the word under a cell: letters, digits, _ and $, not punctuation", () => {
  const g = new Grid();
  g.apply([["grid_resize", [1, 20, 1]], ["grid_line", [1, 0, 0, [["a"], ["."], ["$"], ["f"], ["o"], ["o"], ["_"], ["1"], ["("], [")"]], false]]]);
  assert.deepEqual(g.wordAt(1, 0, 4), { start: 2, end: 8 });
  assert.deepEqual(g.wordAt(1, 0, 0), { start: 0, end: 1 });
  assert.equal(g.wordAt(1, 0, 1), null);
  assert.equal(g.wordAt(1, 0, 15), null);
  assert.deepEqual(g.cellAt(1, 0, 3), ["f", 0]);
});

test("a whole-window scroll keeps the rows it pushed out, for the view's slide", () => {
  const g = new Grid();
  g.apply([["grid_resize", [2, 3, 4]]]);
  for (let r = 0; r < 4; r++) g.apply([["grid_line", [2, r, 0, [[String(r), 0, 3]]]]]);
  g.apply([["grid_scroll", [2, 0, 4, 0, 3, 1, 0]]]);
  g.apply([["grid_scroll", [2, 0, 4, 0, 3, -2, 0]]]);
  // Taken together: one line down then two up is one line up.
  const [both] = g.takeScrolls();
  assert.equal(both.rows, -1);
  assert.deepEqual(g.takeScrolls(), []);
  g.apply([["grid_scroll", [2, 0, 4, 0, 3, 1, 0]]]);
  const [down] = g.takeScrolls();
  assert.equal(down.rows, 1);
  assert.deepEqual(down.lines.map((l) => l.map((c) => c[0]).join("")), ["111"]);
  // Part of a window (a region) or the screen grid: nothing to slide.
  g.apply([["grid_scroll", [2, 1, 4, 0, 3, 1, 0]]]);
  assert.deepEqual(g.takeScrolls(), []);
});

test("a topline change is a scroll even when nvim redraws instead of scrolling", () => {
  const g = new Grid();
  g.apply([["grid_resize", [2, 3, 10]]]);
  g.apply([["win_viewport", [2, null, 20, 30, 20, 0, 100, 0]]]);
  assert.deepEqual(g.takeScrolls(), []);
  // 6 lines up, drawn as grid_lines only.
  g.apply([["win_viewport", [2, null, 14, 24, 14, 0, 100, -6]]]);
  assert.deepEqual(g.takeScrolls().map((s) => s.rows), [-6]);
  // Another file in the window: not a scroll.
  g.apply([["win_viewport", [2, null, 0, 10, 0, 0, 5, 0]]]);
  assert.deepEqual(g.takeScrolls(), []);
});
