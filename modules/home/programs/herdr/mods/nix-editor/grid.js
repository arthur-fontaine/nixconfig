// Neovim's UI from its `redraw` events (ext_linegrid + ext_multigrid), the way Neovide
// keeps it: grid 1 is the screen, every window has a grid of its own placed on it
// (win_pos) or floating over it (win_float_pos); cells are text + highlight id; then the
// highlight table, the cursor and its shape per mode, the popup menu, messages and the
// cmdline. Pure, so `node --test` checks it; main.js draws it.

export const hex = (n) => (n == null || n < 0 ? null : "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6));

const blank = (n) => Array.from({ length: n }, () => [" ", 0]);

export class Grid {
  constructor() {
    // id → { id, cols, rows, lines, row, col, float, hidden }
    this.grids = new Map();
    this.hl = new Map([[0, {}]]);
    this.defaults = { fg: null, bg: null, sp: null };
    this.cursor = { grid: 1, row: 0, col: 0 };
    this.modes = [];
    this.mode = 0;
    this.popup = null; // { items: [[word, kind, menu, info]], selected, row, col, grid }
    this.title = "";
    this.busy = false;
    this.mouse = true;
    this.options = {};
    this.message = null; // { kind, text, error } from ext_messages, the latest one
    this.cmdline = null; // { lead, text, pos } from ext_cmdline
    this.flushed = false;
    // Whole-window scrolls since the view last took them (takeScrolls): { id, rows, lines },
    // `lines` the rows that left the window, top first, for the view to draw while it
    // slides the window's content to its new place.
    this.scrolls = [];
  }

  // The screen: grid 1's size.
  get cols() { return this.grids.get(1)?.cols ?? 0; }
  get rows() { return this.grids.get(1)?.rows ?? 0; }

  grid(id) {
    let g = this.grids.get(id);
    if (!g) {
      g = { id, cols: 0, rows: 0, lines: [], row: 0, col: 0, float: null, hidden: false };
      this.grids.set(id, g);
    }
    return g;
  }

  // Applies one `redraw` notification's params: [[name, args...], ...]. Returns whether a
  // `flush` came, i.e. whether the screen should be drawn now.
  apply(events) {
    let flush = false;
    for (const [name, ...calls] of events) {
      if (name === "flush") { flush = true; continue; }
      for (const args of calls) this.event(name, args);
    }
    if (flush) this.flushed = true;
    return flush;
  }

  event(name, args) {
    switch (name) {
      case "grid_resize": {
        const [id, width, height] = args;
        const g = this.grid(id), old = g.lines;
        g.cols = width;
        g.rows = height;
        g.lines = Array.from({ length: height }, (_, r) => {
          const row = blank(width);
          for (let c = 0; c < Math.min(width, old[r]?.length ?? 0); c++) row[c] = old[r][c];
          return row;
        });
        break;
      }
      case "grid_clear": {
        const g = this.grid(args[0]);
        g.lines = Array.from({ length: g.rows }, () => blank(g.cols));
        break;
      }
      case "grid_destroy":
      case "win_close":
        this.grids.delete(args[0]);
        break;
      case "grid_line": {
        // [grid, row, col_start, cells, wrap]; a cell is [text, hl?, repeat?] and an
        // omitted hl repeats the previous cell's in this event.
        const [id, row, colStart, cells] = args;
        const g = this.grid(id), line = g.lines[row];
        if (!line) break;
        let col = colStart, hl = 0;
        for (const cell of cells) {
          const [text] = cell;
          if (cell.length > 1) hl = cell[1];
          const repeat = cell.length > 2 ? cell[2] : 1;
          for (let k = 0; k < repeat && col < g.cols; k++) line[col++] = [text, hl];
        }
        break;
      }
      case "grid_scroll": {
        // [grid, top, bot, left, right, rows, cols]: the region [top, bot) × [left, right)
        // moves up by `rows` (down when negative); what it uncovers is redrawn by nvim.
        const [id, top, bot, left, right, rows] = args;
        const g = this.grid(id), lines = g.lines;
        if (id !== 1 && top === 0 && bot === g.rows && left === 0 && right === g.cols && Math.abs(rows) < g.rows) {
          const gone = rows > 0 ? lines.slice(0, rows) : lines.slice(bot + rows, bot);
          this.scrolls.push({ id, rows, lines: gone.map((l) => l.slice()) });
        }
        const copy = (to, from) => { for (let c = left; c < right; c++) lines[to][c] = lines[from][c]; };
        if (rows > 0) for (let r = top; r < bot - rows; r++) copy(r, r + rows);
        else for (let r = bot - 1; r >= top - rows; r--) copy(r, r + rows);
        break;
      }
      case "grid_cursor_goto": {
        const [grid, row, col] = args;
        this.cursor = { grid, row, col };
        break;
      }
      case "win_pos": {
        // [grid, win, startrow, startcol, width, height]: a window on the screen.
        const [id, , row, col] = args;
        Object.assign(this.grid(id), { row, col, float: null, hidden: false });
        break;
      }
      case "win_float_pos": {
        // [grid, win, anchor, anchor_grid, anchor_row, anchor_col, mouse_enabled, zindex,
        //  compindex, screen_row, screen_col]: Neovim's own placement is screen_row/col.
        const [id, , anchor, anchorGrid, anchorRow, anchorCol, mouse, zindex, , screenRow, screenCol] = args;
        const g = this.grid(id);
        Object.assign(g, {
          row: screenRow ?? 0, col: screenCol ?? 0, hidden: false,
          float: { anchor, anchorGrid, anchorRow, anchorCol, mouse: mouse !== false, zindex: zindex ?? 50 },
        });
        break;
      }
      case "win_viewport": {
        // [grid, win, topline, botline, curline, curcol, line_count, scroll_delta]: lines are
        // 0-based, botline past the last shown. Whether the window can scroll either way.
        const [id, , topline, botline, , , count] = args;
        this.grid(id).viewport = { top: topline, bottom: botline, count };
        break;
      }
      case "win_hide":
        this.grid(args[0]).hidden = true;
        break;
      case "default_colors_set": {
        const [fg, bg, sp] = args;
        this.defaults = { fg: hex(fg), bg: hex(bg), sp: hex(sp) };
        break;
      }
      case "hl_attr_define": {
        const [id, rgb] = args;
        this.hl.set(id, rgb ?? {});
        break;
      }
      case "mode_info_set":
        this.modes = args[1] ?? [];
        break;
      case "mode_change":
        this.mode = args[1] ?? 0;
        break;
      case "busy_start": this.busy = true; break;
      case "busy_stop": this.busy = false; break;
      case "mouse_on": this.mouse = true; break;
      case "mouse_off": this.mouse = false; break;
      case "set_title": this.title = args[0] ?? ""; break;
      case "option_set": this.options[args[0]] = args[1]; break;
      case "popupmenu_show": {
        const [items, selected, row, col, grid] = args;
        this.popup = { items, selected, row, col, grid: grid ?? 1 };
        break;
      }
      case "popupmenu_select":
        if (this.popup) this.popup.selected = args[0];
        break;
      case "popupmenu_hide":
        this.popup = null;
        break;
      // ext_messages: no message area and no hit-enter prompt; the latest message is shown
      // in the status strip until nvim clears it.
      case "msg_show": {
        const [kind, content, replaceLast, , append] = args;
        const text = chunks(content);
        if (!text.trim() && kind !== "") break;
        const prev = append && this.message ? this.message.text : "";
        this.message = { kind, text: (replaceLast ? "" : prev) + text, error: ERROR_KINDS.has(kind) };
        break;
      }
      case "msg_clear":
        this.message = null;
        break;
      // ext_cmdline: [content, pos, firstc, prompt, indent, level]; pos is a byte offset.
      case "cmdline_show": {
        const [content, pos, firstc, prompt, indent] = args;
        const text = chunks(content);
        this.cmdline = { lead: (firstc || "") + (prompt || "") + " ".repeat(indent || 0), text, pos: charIndex(text, pos) };
        break;
      }
      case "cmdline_pos":
        if (this.cmdline) this.cmdline.pos = charIndex(this.cmdline.text, args[0]);
        break;
      case "cmdline_hide":
        this.cmdline = null;
        break;
      default:
        break;
    }
  }

  takeScrolls() {
    const out = this.scrolls;
    this.scrolls = [];
    return out;
  }

  // A row of cells (a grid's, or one kept by a scroll) as runs of one highlight.
  runsOf(line) {
    const out = [];
    for (let c = 0; c < (line?.length ?? 0); c++) {
      const [text, hl] = line[c];
      const last = out[out.length - 1];
      if (last && last.hl === hl) { last.cells++; last.text += text; }
      else out.push({ col: c, cells: 1, text, hl });
    }
    return out;
  }

  // The windows to draw under the floats: grid 1, then each placed window grid.
  // The cell [text, hl] at a grid's row and column, and the word (letters, digits, _ and $)
  // around it: its first and past-last columns.
  cellAt(id, row, col) {
    return this.grids.get(id)?.lines?.[row]?.[col];
  }

  wordAt(id, row, col) {
    const line = this.grids.get(id)?.lines?.[row];
    const word = (c) => /^[\p{L}\p{N}_$]$/u.test(line?.[c]?.[0] ?? "");
    if (!line || !word(col)) return null;
    let start = col, end = col + 1;
    while (start > 0 && word(start - 1)) start--;
    while (end < line.length && word(end)) end++;
    return { start, end };
  }

  windows() {
    const out = [];
    for (const g of this.grids.values()) if (!g.float && !g.hidden && g.rows) out.push(g);
    return out.sort((a, b) => (a.id === 1 ? -1 : b.id === 1 ? 1 : a.id - b.id));
  }

  floats() {
    const out = [];
    for (const g of this.grids.values()) if (g.float && !g.hidden && g.rows) out.push(g);
    return out.sort((a, b) => a.float.zindex - b.float.zindex);
  }

  // The grid under a screen cell, and the cell in it: the top float first, then the
  // windows, else the screen itself.
  at(row, col) {
    const inside = (g) => row >= g.row && row < g.row + g.rows && col >= g.col && col < g.col + g.cols;
    const hit = [...this.floats().filter((g) => g.float.mouse).reverse(), ...this.windows().filter((g) => g.id !== 1)].find(inside);
    const g = hit ?? this.grids.get(1) ?? { id: 1, row: 0, col: 0 };
    return { grid: g.id, row: row - g.row, col: col - g.col };
  }

  // A highlight's colors with nvim's rules: unset falls back to the defaults, reverse
  // swaps foreground and background.
  style(id) {
    const a = this.hl.get(id) ?? {};
    let fg = hex(a.foreground) ?? this.defaults.fg, bg = hex(a.background) ?? this.defaults.bg;
    if (a.reverse) [fg, bg] = [bg, fg];
    return {
      fg, bg,
      sp: hex(a.special) ?? this.defaults.sp ?? fg,
      // A line drawn in its own color (diagnostics) rather than the text's.
      spSet: a.special != null,
      bold: Boolean(a.bold), italic: Boolean(a.italic),
      underline: Boolean(a.underline), undercurl: Boolean(a.undercurl || a.underdouble || a.underdotted || a.underdashed),
      strikethrough: Boolean(a.strikethrough),
    };
  }

  // A grid row as runs of one highlight: [{ col, cells, text, hl }]. A double-width
  // character is followed by an empty cell, which only adds to the run's width.
  runs(id, row) {
    return this.runsOf(this.grids.get(id)?.lines[row] ?? []);
  }

  // The cursor's shape in the current mode: "block", "vertical" or "horizontal", and how
  // much of the cell it covers.
  cursorShape() {
    const m = this.modes[this.mode] ?? {};
    return { shape: m.cursor_shape ?? "block", percentage: m.cell_percentage ?? 100, name: m.name ?? "" };
  }
}

const ERROR_KINDS = new Set(["emsg", "echoerr", "lua_error", "rpc_error"]);
// A message's or the cmdline's content: [[attr, text, hl?], ...].
const chunks = (content) => (content ?? []).map((c) => c[1] ?? "").join("");
// Neovim counts bytes (UTF-8); the view counts characters.
export function charIndex(text, bytes) {
  let b = 0, i = 0;
  for (const ch of text) {
    if (b >= bytes) break;
    const cp = ch.codePointAt(0);
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += ch.length;
  }
  return i;
}

// Herdr's keystroke ("cmd-shift-z", "alt-left") and the character it types as Neovim key
// notation, or null when nothing should be sent.
const SPECIAL = {
  escape: "Esc", enter: "CR", tab: "Tab", backspace: "BS", delete: "Del", up: "Up", down: "Down",
  left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  space: "Space", insert: "Insert",
};
export function nvimKey(event) {
  const { key, key_char: char, modifiers: m } = event;
  const special = SPECIAL[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : null);
  // Option on macOS types characters (é, ∑): send what it typed, unless it moves or deletes.
  if (!special && char && !m.control && !m.platform) return char === "<" ? "<lt>" : char;
  const name = special ?? (key.length === 1 ? (key === "<" ? "lt" : key) : null);
  if (!name) return null;
  const mods = (m.control ? "C-" : "") + (m.alt ? "A-" : "") + (m.platform ? "D-" : "") + (m.shift ? "S-" : "");
  if (!mods && special) return `<${name}>`;
  if (!mods) return name;
  return `<${mods}${name}>`;
}
