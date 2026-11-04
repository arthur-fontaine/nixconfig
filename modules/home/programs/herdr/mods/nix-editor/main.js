// A code editor tab: a headless Neovim does the editing, highlighting, LSP and
// completion (nvim.js, through the bridge); this view draws its UI grid in the
// terminal's look and turns keys and the mouse into Neovim input, as Neovide does.
// Opened with tab.new { mod: "nix-editor", props: { file, line? } }. One editor at a time
// (../_lib/editor.js): the panels open their files in it, each in a Neovim tab page that
// this view draws as its tab strip, or beside the current file (a split).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings, props, exec, home, appHome, shared, setShared, spaces, panes, focused, run } from "herdr";
import { Grid, nvimKey } from "./grid.js";
import { startNvim } from "./nvim.js";

const STATUS = 24; // px, the strip under the grid
const TABS = 32; // px, the tab strip over it, with two files or more
const PAD = { x: 8, y: 8 }; // px around the grid
const BLINK = 530; // ms the caret is shown, then hidden, as macOS's insertion point
// Scrolling: the wheel and trackpad move a window's content at once, by the pixel, ahead of
// nvim (`pred`); each line nvim then scrolls is taken back from that offset, so nothing jumps.
// A scroll nvim makes on its own (the caret leaving the screen) slides from where the
// content was, its offset (`anim`) shrinking by e^(-dt/SLIDE) each frame, as Neovide does.
const SLIDE = 45;
const FRAME = 8;
// Rows nvim draws under the editor's bottom edge, clipped: what the content uncovers when it
// moves up ahead of nvim. scrolloff (init.lua) keeps the caret above them.
const EXTRA = 2;
const FLOAT = { x: 8, y: 6, gap: 4 }; // a float's padding, and its distance from the line it's about
// Cmd chords the editor keeps; any other Cmd chord stays Herdr's (new tab, palette…).
const OWN_CMD = new Set(["s", "z", "a", "c", "x", "v", "f", "/", "[", "]", "\\", "left", "right", "up", "down", "backspace", "d", "p"]);

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.split("/").pop();
// Light or dark, from how bright the theme's background is.
const appearance = (hex) => {
  const n = parseInt((hex ?? "#000000").slice(1, 7), 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 128 ? "light" : "dark";
};

export default class Editor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file;
    this.line = p.line ?? null;
    this.grid = new Grid();
    this.status = null; // herdr_status: { file, modified, errors, warnings, lsp }
    this.error = null;
    this.size = null; // { cols, rows }
    this.nvim = null;
    this.starting = false;
    this.dragging = false;
    this.wheel = { x: 0, y: 0 };
    this.root = dirname(this.file ?? "/");
    // A line asked of this file's tab by nix-files or nix-diff (nix-editor.goto); one asked
    // before this tab existed was for another one.
    this.gotoSeen = shared("nix-editor.goto")?.n;
    this.tab = this.findTab(basename(this.file ?? ""));
    this.handle = cx.focus_handle();
    this.cx = cx;
    cx.timer.after(50, () => this.handle.focus(), { owner: this });
    // The caret blinks while the editor has the keyboard, and shows steadily for a moment
    // after each key, click or move (this.wake), as macOS text fields do.
    this.blink = true;
    this.woke = Date.now();
    // Window grid → { pred, anim (px, + = content drawn lower), pending (lines asked of nvim,
    // + = down), above, below (rows that left, to fill what the offset uncovers) }.
    this.slides = new Map();
    this.sliding = false;
    cx.timer.every(BLINK, () => {
      const focused = this.handle.is_focused();
      const blink = !focused || Date.now() - this.woke < BLINK ? true : !this.blink;
      if (blink !== this.blink || focused !== this.focused) { this.blink = blink; this.focused = focused; this.cx.notify(); }
    }, { owner: this });
  }

  wake() {
    this.woke = Date.now();
    if (!this.blink) { this.blink = true; this.cx.notify(); }
  }

  close() {
    this.nvim?.close();
    this.nvim = null;
  }

  // The layout's terminal font; each cell is the font's advance as laid out (measured, see
  // render), 0.6em (JetBrains Mono's) until then.
  metrics() {
    const s = settings();
    const size = Number(s.font_size) || 12;
    const mono = s.font_family ?? "JetBrains Mono";
    const cw = this.advance?.key === `${mono}/${size}` ? this.advance.cw : size * 0.6;
    return { mono, size, cw, lh: Math.round(size * 1.45) };
  }

  resized(px) {
    const { cw, lh } = this.metrics();
    const cols = Math.max(20, Math.floor((px.width - PAD.x * 2) / cw));
    const rows = Math.max(4, Math.floor((px.height - PAD.y * 2) / lh));
    if (this.size?.cols === cols && this.size?.rows === rows) return;
    this.size = { cols, rows };
    if (!this.nvim && !this.starting) return this.start();
    // A window drag reports many sizes: nvim hears the last one. (No Task.cancel(): it
    // crashes Herdr's script runtime under load; a later size just makes this one stale.)
    const n = (this.resizes = (this.resizes ?? 0) + 1);
    this.cx.timer.after(80, () => { if (n === this.resizes) this.nvim?.resize(cols, rows + EXTRA); }, { owner: this });
  }

  start() {
    if (!this.file) { this.error = "No file to open"; return this.cx.notify(); }
    if (typeof startNvim !== "function") { this.error = "The editor backend (nvim.js) isn't installed"; return this.cx.notify(); }
    this.starting = true;
    // No async function and no task here: Herdr's script runtime frees the closures an
    // async function makes once it returns, and the connection's live as long as the view
    // (nvim.js). Plain promise chains, with `this.cx` (init's, which outlives an await).
    const notify = () => this.cx.notify();
    const onRedraw = (events) => {
      if (!this.grid.apply(events)) return;
      const scrolls = this.grid.takeScrolls();
      if (scrolls.length) this.slide(scrolls);
      const c = this.grid.cursor, at = `${c.grid}:${c.row}:${c.col}`;
      if (at !== this.caretAt) { this.caretAt = at; this.woke = Date.now(); this.blink = true; }
      notify();
    };
    const onNotify = (name, args) => {
      if (name === "herdr_status") { this.status = args?.[0] ?? null; this.followTabs(); notify(); }
      if (name === "nvim_closed") { this.nvim = null; this.error = "Neovim exited"; notify(); }
    };
    exec("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(this.file) }).catch(() => null)
      .then((top) => {
        if (top?.code === 0) this.root = top.stdout.trim();
        return startNvim({ home: home(), appHome: appHome(), file: this.file, cwd: dirname(this.file), width: this.size.cols, height: this.size.rows + EXTRA, onRedraw, onNotify });
      })
      .then((nvim) => {
        this.nvim = nvim;
        if (!nvim) this.error = "Couldn't start Neovim";
        else if (this.line) nvim.notify("nvim_win_set_cursor", 0, [this.line, 0]);
      }, (e) => { this.error = `Couldn't start Neovim: ${e?.message ?? e}`; })
      .then(() => { this.starting = false; notify(); });
  }

  // nvim scrolled whole windows: their content slides from where it was. The rows that left
  // are kept to fill the space the slide uncovers, as many as a window can show.
  slideOf(id) {
    let s = this.slides.get(id);
    if (!s) { s = { pred: 0, anim: 0, pending: 0, above: [], below: [] }; this.slides.set(id, s); }
    return s;
  }

  slide(scrolls) {
    const { lh } = this.metrics();
    let animate = false;
    for (const { id, rows, lines } of scrolls) {
      const g = this.grid.grids.get(id);
      if (!g) continue;
      const s = this.slideOf(id);
      if (rows > 0) { if (s.pred + s.anim < 0) s.below = []; s.above = [...s.above, ...lines].slice(-g.rows); }
      else { if (s.pred + s.anim > 0) s.above = []; s.below = [...lines, ...s.below].slice(0, g.rows); }
      // Lines the wheel asked for: the content is already there, the offset gives them back.
      const asked = Math.sign(s.pending) === Math.sign(rows) ? Math.sign(rows) * Math.min(Math.abs(s.pending), Math.abs(rows)) : 0;
      s.pending -= asked;
      s.pred += asked * lh;
      if (rows !== asked) { s.anim = Math.max(-g.rows * lh, Math.min(g.rows * lh, s.anim + (rows - asked) * lh)); animate = true; }
    }
    if (animate) this.animate();
  }

  animate() {
    if (this.sliding) return;
    this.sliding = true;
    this.frameAt = Date.now();
    this.cx.timer.after(FRAME, () => this.step(), { owner: this });
  }

  step() {
    const now = Date.now(), k = Math.exp(-(now - this.frameAt) / SLIDE);
    this.frameAt = now;
    let moving = false;
    for (const [id, s] of this.slides) {
      s.anim *= k;
      if (Math.abs(s.anim) < 0.5) s.anim = 0; else moving = true;
      if (!s.anim && Math.abs(s.pred) < 0.5 && !s.pending) this.slides.delete(id);
    }
    this.cx.notify();
    if (moving) this.cx.timer.after(FRAME, () => this.step(), { owner: this });
    else this.sliding = false;
  }

  // Keys, as Neovim notation. Clipboard chords go through the system clipboard here,
  // since a headless Neovim has none.
  key(e, cx) {
    if (!this.nvim) return;
    this.wake();
    const m = e.modifiers;
    if (m.platform && !OWN_CMD.has(e.key)) return; // Herdr's own shortcut
    cx.stop_propagation();
    if (m.platform && !m.shift && !m.control && !m.alt && e.key === "v") {
      const text = cx.read_from_clipboard();
      if (text) this.nvim.notify("nvim_paste", text, true, -1);
      return;
    }
    const keys = nvimKey(e);
    if (!keys) return;
    this.nvim.input(keys);
    if (m.platform && !m.shift && (e.key === "c" || e.key === "x")) {
      // After the mapping has yanked into "+.
      this.cx.timer.after(30, (cx) => {
        this.nvim?.request("nvim_call_function", "getreg", ["+"]).then((text) => {
          if (typeof text === "string" && text) cx.write_to_clipboard(text);
        }, () => {});
      }, { owner: this });
    }
  }

  // The grid cell under the pointer, as nvim_input_mouse wants it (multigrid): a float by
  // where we drew it, else the window or the screen under that screen cell.
  cell(e) {
    const m = this.metrics(), g = this.grid;
    const p = e.local_position ?? { x: 0, y: 0 };
    for (const f of [...g.floats()].reverse()) {
      if (!f.float.mouse) continue;
      const r = this.placeFloat(f, m);
      if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) {
        const col = Math.max(0, Math.min(f.cols - 1, Math.floor((p.x - r.x - FLOAT.x) / m.cw)));
        const row = Math.max(0, Math.min(f.rows - 1, Math.floor((p.y - r.y - FLOAT.y) / m.lh)));
        return { grid: f.id, row, col };
      }
    }
    const col = Math.max(0, Math.min(g.cols - 1, Math.floor((p.x - PAD.x) / m.cw)));
    const row = Math.max(0, Math.min(g.rows - 1, Math.floor((p.y - PAD.y) / m.lh)));
    const hit = g.at(row, col);
    return { ...hit, screen: `${row}:${col}` };
  }

  mods(m) {
    return (m.control ? "C" : "") + (m.alt ? "A" : "") + (m.shift ? "S" : "") + (m.platform ? "D" : "");
  }

  mouseDown(e, cx) {
    this.handle.focus();
    this.wake();
    if (!this.nvim || !this.grid.mouse) return;
    const { grid, row, col, screen } = this.cell(e);
    this.dragging = true;
    this.last = screen;
    if (e.modifiers.platform) {
      // Cmd+click: the caret there, then the LSP's definition.
      this.nvim.inputMouse("left", "press", "", grid, row, col);
      this.nvim.inputMouse("left", "release", "", grid, row, col);
      this.dragging = false;
      this.nvim.notify("nvim_exec_lua", "vim.lsp.buf.definition()", []);
      return;
    }
    this.nvim.inputMouse("left", "press", this.mods(e.modifiers), grid, row, col);
  }

  // Drags select; plain moves reach nvim's <MouseMove>, which shows the hover float.
  mouseMove(e) {
    if (!this.nvim || !this.grid.mouse) return;
    const { grid, row, col, screen } = this.cell(e);
    this.hover = { grid, row, col };
    this.followLink(e.modifiers.platform);
    const at = screen ?? `${grid}/${row}:${col}`;
    if (at === this.last) return;
    this.last = at;
    if (this.dragging) this.nvim.inputMouse("left", "drag", this.mods(e.modifiers), grid, row, col);
    else this.nvim.inputMouse("move", "", this.mods(e.modifiers), grid, row, col);
  }

  mouseUp(e) {
    if (!this.dragging || !this.nvim) return;
    this.dragging = false;
    const { grid, row, col } = this.cell(e);
    this.nvim.inputMouse("left", "release", this.mods(e.modifiers), grid, row, col);
  }

  // Trackpads report pixels: one wheel step per line height, in either direction.
  scroll(e) {
    if (!this.nvim || !this.grid.mouse) return;
    const { lh, cw } = this.metrics();
    const { grid, row, col } = this.cell(e);
    this.wheel.y += e.delta.y;
    this.wheel.x += e.delta.x;
    // The content follows the fingers now; nvim scrolls a line for each line height. Past
    // the file's ends nvim doesn't, and the content gives at most a line before it stops.
    const w = this.grid.grids.get(grid);
    if (w && !w.float && grid !== 1 && e.delta.y) {
      const s = this.slideOf(grid);
      s.pred = Math.max(-lh * (Math.abs(s.pending) + 1), Math.min(lh * (Math.abs(s.pending) + 1), s.pred + e.delta.y));
      this.cx.notify();
    }
    while (Math.abs(this.wheel.y) >= lh) {
      const up = this.wheel.y > 0;
      const s = this.slides.get(grid);
      if (s && Math.abs(s.pending) >= 3) { this.wheel.y = 0; break; }
      this.nvim.inputMouse("wheel", up ? "up" : "down", this.mods(e.modifiers), grid, row, col);
      if (s) s.pending += up ? -1 : 1;
      this.wheel.y += up ? -lh : lh;
    }
    while (Math.abs(this.wheel.x) >= cw * 4) {
      const left = this.wheel.x > 0;
      this.nvim.inputMouse("wheel", left ? "left" : "right", this.mods(e.modifiers), grid, row, col);
      this.wheel.x += left ? -cw * 4 : cw * 4;
    }
    if (e.touch_phase === "ended") {
      this.wheel = { x: 0, y: 0 };
      // The fingers are off: what is left of the offset eases back.
      for (const s of this.slides.values()) { s.anim += s.pred; s.pred = 0; s.pending = 0; }
      this.animate();
    }
  }

  // Cmd held over a word: it is underlined and the pointer is a hand, as a link to its
  // definition (Cmd+click goes there). Redrawn only when the word or Cmd changes.
  followLink(cmd) {
    const h = cmd && !this.dragging ? this.hover : null;
    const w = h ? this.grid.wordAt(h.grid, h.row, h.col) : null;
    const link = w && { grid: h.grid, row: h.row, ...w };
    const key = link ? `${link.grid}/${link.row}:${link.start}-${link.end}` : "";
    if (key === (this.linkKey ?? "")) return;
    this.linkKey = key;
    this.link = link;
    this.cx.notify();
  }

  linkLine(m, t) {
    const l = this.link, w = l && this.grid.grids.get(l.grid);
    if (!w || w.float || w.hidden) return null;
    const color = this.grid.style(this.grid.cellAt(l.grid, l.row, l.start)?.[1] ?? 0).fg ?? t.foreground;
    return div().absolute().left(PAD.x + (w.col + l.start) * m.cw).top(PAD.y + (w.row + l.row) * m.lh).h(m.lh)
      .line_height(`${m.lh}px`).whitespace_nowrap().text_color(color).underline().child(" ".repeat(l.end - l.start));
  }

  // One element per run of a highlight, at its cell; a run's width is its cells' so
  // columns stay exact whatever the glyphs measure. `base` is the surface under the grid:
  // runs of that color draw no background of their own.
  row(id, r, x, y, base, m, t) {
    return this.rowOf(this.grid.runs(id, r), this.grid.grids.get(id).cols, x, y, base, m, t);
  }

  rowOf(cells, cols, x, y, base, m, t) {
    const g = this.grid;
    const runs = cells.map((run) => {
      const s = g.style(run.hl);
      const blank = !run.text.trim();
      return div().absolute().left(run.col * m.cw).top(0).w(run.cells * m.cw).h(m.lh).flex_none().overflow_hidden()
        .whitespace_nowrap().line_height(`${m.lh}px`)
        .when(Boolean(s.bg) && s.bg !== base, (e) => e.bg(s.bg))
        .when(!blank, (e) => e.text_color(s.fg ?? t.foreground)
          .when(s.bold, (e) => e.font_weight(700))
          .when(s.italic, (e) => e.italic())
          .when(s.underline && !s.spSet, (e) => e.underline())
          .when(s.strikethrough, (e) => e.line_through())
          .child(run.text))
        // A line in the special color (GPUI colors decorations like the text): an underline
        // drawn under spaces of that color, wavy for undercurl.
        .when(s.undercurl || (s.underline && s.spSet), (e) => e.child(div().absolute().left(0).top(0).w_full().h(m.lh).line_height(`${m.lh}px`)
          .text_color(s.sp ?? t.blocked).underline().when(s.undercurl, (e) => e.text_decoration_wavy()).whitespace_nowrap()
          .child(" ".repeat(run.cells))));
    });
    return div().absolute().left(x).top(y).w(cols * m.cw).h(m.lh).children(runs)
      .when(Boolean(this.link), (e) => e.cursor_pointer()).when(!this.link, (e) => e.cursor_text());
  }

  // A window grid where nvim put it on the screen, opaque: grid 1 under it keeps what other
  // tab pages drew there (a split's separator).
  windowRows(w, m, t) {
    const base = this.grid.defaults.bg, g = this.grid;
    const opaque = (e) => e.when(w.id !== 1 && Boolean(base), (e) => e.bg(base));
    const sl = this.slides.get(w.id);
    const s = sl && { ...sl, off: sl.pred + sl.anim };
    if (!s || !s.off) return Array.from({ length: w.rows }, (_, r) => opaque(this.row(w.id, r, PAD.x + w.col * m.cw, PAD.y + (w.row + r) * m.lh, base, m, t)));
    // Sliding: the window clips its rows, drawn `off` px from their place, and the rows that
    // left fill the space uncovered above (scrolling down) or below (scrolling up).
    const line = (runs, y) => opaque(this.rowOf(runs, w.cols, 0, y, base, m, t));
    const rows = Array.from({ length: w.rows }, (_, r) => line(g.runs(w.id, r), r * m.lh + s.off));
    const n = Math.ceil(Math.abs(s.off) / m.lh);
    if (s.off > 0) for (let k = 1; k <= Math.min(n, s.above.length); k++) rows.push(line(g.runsOf(s.above[s.above.length - k]), s.off - k * m.lh));
    else for (let k = 0; k < Math.min(n, s.below.length); k++) rows.push(line(g.runsOf(s.below[k]), (w.rows + k) * m.lh + s.off));
    return [div().absolute().left(PAD.x + w.col * m.cw).top(PAD.y + w.row * m.lh).w(w.cols * m.cw).h(w.rows * m.lh).overflow_hidden().children(rows)];
  }

  // Where a float is drawn: in a padded frame 4px under the line it's about (the line above
  // where nvim would put it, or below when nvim put it above), flipped when it doesn't fit
  // or would cover the cursor's line.
  placeFloat(f, m) {
    const g = this.grid, viewH = (this.px?.height ?? 600), viewW = this.px?.width ?? 800;
    const w = f.cols * m.cw + FLOAT.x * 2, h = f.rows * m.lh + FLOAT.y * 2;
    const below = !/^S/.test(f.float.anchor);
    const line = below ? f.row - 1 : f.row + f.rows; // the screen row it's about
    const under = PAD.y + (line + 1) * m.lh + FLOAT.gap, over = PAD.y + line * m.lh - FLOAT.gap - h;
    const cg = g.grids.get(g.cursor.grid);
    const cursorRow = (cg?.row ?? 0) + g.cursor.row;
    const covers = (y) => cursorRow * m.lh + PAD.y < y + h && (cursorRow + 1) * m.lh + PAD.y > y;
    let y = below ? under : over;
    if (y + h > viewH || y < 0 || covers(y)) {
      const other = below ? over : under;
      if (other >= 0 && other + h <= viewH && !covers(other)) y = other;
    }
    const x = Math.max(0, Math.min(PAD.x + f.col * m.cw - FLOAT.x, viewW - w - 4));
    return { x, y: Math.max(0, y), w, h };
  }

  // Hover and diagnostic floats in the completion popup's frame; nvim draws their text.
  floatFrame(f, m, t) {
    const r = this.placeFloat(f, m);
    return div().absolute().left(r.x).top(r.y).w(r.w).h(r.h).rounded(6).bg(t.popover).border_1().border_color(t.border)
      .shadow_md().overflow_hidden()
      .children(Array.from({ length: f.rows }, (_, row) => this.row(f.id, row, FLOAT.x - 1, FLOAT.y - 1 + row * m.lh, t.popover?.toLowerCase(), m, t)));
  }

  caret(m, t) {
    const g = this.grid, { grid, row, col } = g.cursor;
    const cg = g.grids.get(grid);
    if (!cg || row >= cg.rows || col >= cg.cols || cg.hidden) return null;
    let x, y;
    if (cg.float) { const r = this.placeFloat(cg, m); x = r.x + FLOAT.x + col * m.cw; y = r.y + FLOAT.y + row * m.lh; }
    else { x = PAD.x + (cg.col + col) * m.cw; y = PAD.y + (cg.row + row) * m.lh + ((this.slides.get(grid)?.pred ?? 0) + (this.slides.get(grid)?.anim ?? 0)); }
    const { shape, percentage } = g.cursorShape();
    // A bar between two characters, over neither: centred on the cells' boundary. Steady and
    // dimmed while the editor doesn't have the keyboard.
    if (shape === "vertical") {
      if (this.focused !== false && !this.blink) return null;
      return div().absolute().left(x - 0.75).top(y + 1).w(1.5).h(m.lh - 2).rounded(1).bg(this.focused === false ? t.dim : t.accent);
    }
    if (shape === "horizontal") {
      const h = Math.max(2, Math.round((m.lh * (percentage || 20)) / 100));
      return div().absolute().left(x).top(y + m.lh - h).w(m.cw).h(h).bg(t.accent);
    }
    // A block shows the character under it in the background's color.
    const [text] = cg.lines[row]?.[col] ?? [" "];
    return div().absolute().left(x).top(y).w(m.cw).h(m.lh).bg(t.accent).text_color(g.defaults.bg ?? t.background)
      .line_height(`${m.lh}px`).whitespace_nowrap().overflow_hidden().child(text || " ");
  }

  // Neovim's completion menu, drawn by us under the word it completes: at most 8 rows
  // around the selection, as wide as its content within [200, 360].
  popup(m, t) {
    const p = this.grid.popup;
    if (!p || !p.items.length) return null;
    const visible = 8, rowH = 26, wordW = 12.5 * 0.6, kindW = 11 * 0.58;
    const first = Math.max(0, Math.min(p.items.length - visible, (p.selected ?? 0) - Math.floor(visible / 2)));
    const items = p.items.slice(first, first + visible);
    const content = Math.max(...items.map(([word, kind]) => word.length * wordW + (kind ? kind.length * kindW + 8 : 0))) + 16 + 8;
    const width = Math.min(360, Math.max(200, content));
    const pg = this.grid.grids.get(p.grid) ?? { row: 0, col: 0 };
    const row = pg.row + p.row, col = pg.col + p.col;
    const height = items.length * rowH + 8;
    const below = PAD.y + (row + 1) * m.lh + FLOAT.gap;
    const top = below + height > (this.px?.height ?? 600) && row * m.lh > height ? PAD.y + row * m.lh - height - FLOAT.gap : below;
    const left = Math.max(0, Math.min(PAD.x + col * m.cw - 12, (this.px?.width ?? 800) - width - 8));
    return v_flex().absolute().left(left).top(top).w(width).p(4).rounded(6).bg(t.popover).border_1().border_color(t.border).shadow_md()
      .children(items.map(([word, kind], i) => {
        const on = first + i === p.selected;
        return h_flex().h(rowH).px(8).gap(8).items_center().rounded(4).when(on, (e) => e.bg(t.selected))
          .child(div().flex_1().min_w(0).truncate().font_family(m.mono).text_size(12.5).text_color(on ? t.foreground : t.muted).child(word))
          .when(Boolean(kind), (e) => e.child(div().flex_none().font_family("Inter").text_size(11).text_color(t.dim).child(kind)));
      }));
  }

  // ":" commands and "/" searches (Cmd+F), typed on a line at the bottom of the editor.
  cmdline(m, t) {
    const c = this.grid.cmdline;
    const h = m.lh + 12;
    const caret = PAD.x + (c.lead.length + c.pos) * m.cw;
    return div().absolute().left(0).bottom(0).w_full().h(h).bg(t.chrome).border_t(1).border_color(t.border)
      .child(div().absolute().left(PAD.x).top(6).h(m.lh).line_height(`${m.lh}px`).whitespace_nowrap().overflow_hidden()
        .child(h_flex().child(div().text_color(t.dim).child(c.lead)).child(div().text_color(t.foreground).child(c.text))))
      .child(div().absolute().left(caret).top(6).w(2).h(m.lh).bg(t.accent));
  }

  statusBar(t) {
    const s = this.status ?? {};
    const file = s.file ?? this.file ?? "";
    const rel = this.root && file.startsWith(this.root + "/") ? file.slice(this.root.length + 1) : file;
    // init.lua reports the attached servers, "ts_ls (starting)" until initialized.
    const servers = Array.isArray(s.lsp) ? s.lsp : [];
    const state = !this.status ? "starting" : !servers.length ? "none" : servers.some((n) => n.endsWith("(starting)")) ? "starting" : "ready";
    const name = "TS";
    const msg = this.flash ?? this.grid.message;
    const count = (n, color) => h_flex().flex_none().gap(5).items_center()
      .child(div().size(6).rounded(3).bg(color)).child(String(n));
    return h_flex().h(STATUS).flex_none().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted)
      .when(Boolean(msg), (e) => e.child(div().flex_1().min_w(0).truncate().whitespace_nowrap().text_color(msg.error ? t.blocked : t.muted).child(msg.text.replace(/\s+/g, " "))))
      .when(!msg, (e) => e.child(div().flex_1().min_w(0).text_ellipsis_start().whitespace_nowrap().text_color(t.dim).child(rel)))
      .when(Boolean(s.modified), (e) => e.child(count("modified", t.dim)))
      .when(s.errors > 0, (e) => e.child(count(s.errors, t.blocked)))
      .when(s.warnings > 0, (e) => e.child(count(s.warnings, t.ansi3)))
      .child(div().flex_none().text_color(state === "ready" ? t.dim : t.muted).child(`${name} ${state}`));
  }

  // Herdr's theme, handed to init.lua (herdr_theme): nvim's background follows the
  // appearance, and the surfaces and the groups the design sets take the theme's colors.
  followTheme() {
    if (!this.nvim) return;
    const t = theme();
    const key = JSON.stringify([t.background, t.foreground, t.popover, t.accent, t.selection, t.blocked]);
    if (key === this.themeKey) return;
    this.themeKey = key;
    const int = (hex) => (hex ? parseInt(hex.slice(1, 7), 16) : null);
    const colors = { appearance: appearance(t.background) };
    for (const name of ["background", "foreground", "popover", "border", "selection", "accent", "accent_foreground", "raised", "blocked", "ansi3", "ansi4", "dim"])
      colors[name] = int(t[name]);
    this.nvim.notify("nvim_exec_lua", "_G.herdr_theme(...)", [colors]);
  }

  // A file a panel asked for (nix-editor.goto, ../_lib/editor.js): its tab page, a new one,
  // or a split beside the current file; then its line. Keys go to the editor after.
  followGoto() {
    const want = shared("nix-editor.goto");
    if (!want?.file || want.n === this.gotoSeen || !this.nvim) return;
    this.tab ??= this.findTab(this.named ?? basename(this.file ?? ""));
    if (want.tab && want.tab !== this.tab) return; // another editor's
    this.gotoSeen = want.n;
    this.nvim.notify("nvim_exec_lua", "_G.herdr_open(...)", [want.file, want.line ?? 0, Boolean(want.side)]);
    this.handle.focus();
  }

  // The Herdr tab: in the panels' state (unsaved changes keep the editor where it is), and
  // named after the file it shows.
  followTabs() {
    const tabs = this.status?.tabs ?? [];
    const modified = tabs.some((x) => x.modified);
    if (modified !== this.modified) {
      this.modified = modified;
      setShared("nix-editor.state", { modified });
    }
    const name = basename(this.status?.file || this.file || "");
    if (name && name !== this.named) {
      this.tab ??= this.findTab(this.named ?? basename(this.file ?? ""));
      this.named = name;
      if (this.tab) run("tab.rename", { id: this.tab, name });
    }
  }

  // Its Herdr tab, which props don't name: the editor tab called `name` (the name it was
  // given), the focused one if several are. Other spaces can hold editor tabs too.
  findTab(name) {
    const names = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, t.name])));
    const tabs = panes().filter((x) => x.mod === "nix-editor" && names.get(x.tab) === name).map((x) => x.tab);
    return tabs.length === 1 ? tabs[0] : tabs.find((t) => t === focused()?.tab) ?? null;
  }

  // Closing a file's tab page: unsaved changes keep it (⌥-click discards them); the last
  // one closes the Herdr tab.
  closeTab(n, force) {
    this.nvim?.request("nvim_exec_lua", "return _G.herdr_close_tab(...)", [n, force]).catch(() => null).then((r) => {
      if (r === "modified") {
        this.flash = { text: "Unsaved changes: ⌘S saves them, ⌥-click × discards them", error: true };
        const n = (this.flashes = (this.flashes ?? 0) + 1);
        this.cx.timer.after(4000, () => { if (n === this.flashes) { this.flash = null; this.cx.notify(); } }, { owner: this });
        this.cx.notify();
      } else if (r === "last" && this.tab) {
        run("tab.close", { id: this.tab, confirmed: true });
      }
    });
  }


  // The files open, as the terminal tabs above draw theirs: the current one on the editor's
  // background; a dot for unsaved changes; a folder name when two share a file name.
  tabStrip(t) {
    const tabs = this.status?.tabs ?? [];
    if (tabs.length < 2) return null;
    const bg = this.grid.defaults.bg ?? t.background;
    const names = tabs.map((x) => basename(x.file) || "[No Name]");
    const twice = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    return h_flex().id("editor-tabs").h(TABS).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scroll()
      .children(tabs.map((x, i) => {
        const on = x.current;
        const dir = twice.has(names[i]) ? basename(dirname(x.file)) : null;
        return h_flex().id(`editor-tab-${i}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().border_r(1).border_color(t.border)
          .cursor_pointer().text_size(12).when(on, (e) => e.bg(bg)).when(!on, (e) => e.hover((e) => e.bg(t.hover)).active((e) => e.bg(t.selected)))
          .on_click(() => { this.nvim?.notify("nvim_command", `tabnext ${i + 1}`); this.handle.focus(); })
          .when(x.modified, (e) => e.child(div().size(6).rounded(3).flex_none().bg(t.dim)))
          .child(div().flex_none().whitespace_nowrap().text_color(on ? t.foreground : t.muted).child(names[i]))
          .when(Boolean(dir), (e) => e.child(div().flex_none().whitespace_nowrap().text_color(t.dim).child(dir)))
          .when(x.splits > 1, (e) => e.child(svg("mods/nix-head/icons/split-right.svg").size(12).flex_none().text_color(t.dim)))
          .child(div().id(`editor-tab-close-${i}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).hover((e) => e.bg(t.input + "80").text_color(t.foreground)).active((e) => e.bg(t.input + "b3"))
            .tooltip(x.modified ? "Close (⌥-click: discard the changes)" : "Close")
            .on_click((e, cx) => { cx.stop_propagation(); this.closeTab(i + 1, e.modifiers.alt); })
            .child(svg("mods/nix-head/icons/x.svg").size(12)));
      }));
  }

  render(cx) {
    const t = theme(), m = this.metrics(), g = this.grid;
    const strip = this.tabStrip(t);
    this.followGoto();
    this.followTheme();
    const body = div().id("editor-grid").flex_1().min_h(0).relative().overflow_hidden()
      .bg(g.defaults.bg ?? t.background).font_family(m.mono).text_size(m.size).line_height(`${m.lh}px`)
      .on_size_change((px, cx) => { this.px = px; this.resized(px); })
      .on_mouse_down("left", (e, cx) => this.mouseDown(e, cx))
      .on_mouse_move((e) => this.mouseMove(e))
      .on_hover((hovered) => { if (!hovered) { this.hover = null; this.followLink(false); } })
      .when(Boolean(this.link), (e) => e.cursor_pointer()).when(!this.link, (e) => e.cursor_text())
      .on_mouse_up("left", (e) => this.mouseUp(e))
      .on_scroll_wheel((e) => this.scroll(e))
      .when(Boolean(this.error), (e) => e.child(div().p(16).text_size(12).text_color(t.blocked).child(this.error)))
      .when(!this.error && !g.rows, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child("Starting Neovim…")))
      .children(g.windows().flatMap((w) => this.windowRows(w, m, t)))
      .children(g.floats().map((f) => this.floatFrame(f, m, t)))
      .when(Boolean(this.link), (e) => e.child(this.linkLine(m, t)))
      .when(g.rows > 0 && Boolean(this.caret(m, t)), (e) => e.child(this.caret(m, t)))
      .when(Boolean(this.popup(m, t)), (e) => e.child(this.popup(m, t)))
      .when(Boolean(g.cmdline), (e) => e.child(this.cmdline(m, t)));
    // 100 cells laid out where nobody sees them: the font's real advance, so a character
    // drawn inside a run sits where its cell is (a caret between two never covers one).
    const measure = div().absolute().top(0).left(0).invisible().whitespace_nowrap().font_family(m.mono).text_size(m.size)
      .on_size_change((px) => {
        const cw = px.width / 100, key = `${m.mono}/${m.size}`;
        if (px.width > 0 && (this.advance?.key !== key || Math.abs(this.advance.cw - cw) > 0.01)) {
          this.advance = { key, cw };
          if (this.px) { this.size = null; this.resized(this.px); }
          this.cx.notify();
        }
      }).child("0".repeat(100));
    return v_flex().id("nix-editor").size_full().min_h(0).relative().child(measure).bg(g.defaults.bg ?? t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_modifiers_changed((e) => this.followLink(e.modifiers.platform))
      .when(Boolean(strip), (e) => e.child(strip))
      .child(body).child(this.statusBar(t));
  }
}
