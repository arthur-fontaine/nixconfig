// Neovim's UI as a grid, from its `redraw` events (ext_linegrid, one grid: no
// ext_multigrid), the way Neovide keeps it: cells of text + highlight id, the
// highlight table, the cursor and its shape per mode, and the popup menu. Pure,
// so `node --test` checks it; main.js draws it.

export const hex = (n) => (n == null || n < 0 ? null : "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6));

export class Grid {
  constructor() {
    this.cols = 0;
    this.rows = 0;
    this.lines = []; // rows of cells: [text, hl]
    this.hl = new Map([[0, {}]]);
    this.defaults = { fg: null, bg: null, sp: null };
    this.cursor = { row: 0, col: 0 };
    this.modes = [];
    this.mode = 0;
    this.popup = null; // { items: [[word, kind, menu, info]], selected, row, col }
    this.title = "";
    this.busy = false;
    this.mouse = true;
    this.options = {};
    this.message = null; // { kind, text, error } from ext_messages, the latest one
    this.cmdline = null; // { text, pos } from ext_cmdline: what's typed after ":" or "/"
    this.dirty = new Set(); // rows changed since the last flush
    this.flushed = false;
  }

  // Applies one `redraw` notification's params: [[name, args...], ...]. Returns
  // whether a `flush` came, i.e. whether the screen should be drawn now.
  apply(events) {
    let flush = false;
    for (const [name, ...calls] of events) {
      if (name === "flush") { flush = true; continue; }
      for (const args of calls) this.event(name, args);
    }
    if (flush) this.flushed = true;
    return flush;
  }

  blank(n) {
    return Array.from({ length: n }, () => [" ", 0]);
  }

  event(name, args) {
    switch (name) {
      case "grid_resize": {
        const [, width, height] = args;
        const old = this.lines;
        this.cols = width;
        this.rows = height;
        this.lines = Array.from({ length: height }, (_, r) => {
          const row = this.blank(width);
          for (let c = 0; c < Math.min(width, old[r]?.length ?? 0); c++) row[c] = old[r][c];
          return row;
        });
        for (let r = 0; r < height; r++) this.dirty.add(r);
        break;
      }
      case "grid_clear":
        this.lines = Array.from({ length: this.rows }, () => this.blank(this.cols));
        for (let r = 0; r < this.rows; r++) this.dirty.add(r);
        break;
      case "grid_line": {
        // [grid, row, col_start, cells, wrap]; a cell is [text, hl?, repeat?] and an
        // omitted hl repeats the previous cell's in this event.
        const [, row, colStart, cells] = args;
        const line = this.lines[row];
        if (!line) break;
        let col = colStart, hl = 0;
        for (const cell of cells) {
          const [text] = cell;
          if (cell.length > 1) hl = cell[1];
          const repeat = cell.length > 2 ? cell[2] : 1;
          for (let k = 0; k < repeat && col < this.cols; k++) line[col++] = [text, hl];
        }
        this.dirty.add(row);
        break;
      }
      case "grid_scroll": {
        // [grid, top, bot, left, right, rows, cols]: the region [top, bot) × [left, right)
        // moves up by `rows` (down when negative); what it uncovers is redrawn by nvim.
        const [, top, bot, left, right, rows] = args;
        const copy = (to, from) => { for (let c = left; c < right; c++) this.lines[to][c] = this.lines[from][c]; };
        if (rows > 0) for (let r = top; r < bot - rows; r++) copy(r, r + rows);
        else for (let r = bot - 1; r >= top - rows; r--) copy(r, r + rows);
        for (let r = top; r < bot; r++) this.dirty.add(r);
        break;
      }
      case "grid_cursor_goto": {
        const [, row, col] = args;
        this.dirty.add(this.cursor.row);
        this.cursor = { row, col };
        this.dirty.add(row);
        break;
      }
      case "default_colors_set": {
        const [fg, bg, sp] = args;
        this.defaults = { fg: hex(fg), bg: hex(bg), sp: hex(sp) };
        for (let r = 0; r < this.rows; r++) this.dirty.add(r);
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
        this.dirty.add(this.cursor.row);
        break;
      case "busy_start": this.busy = true; break;
      case "busy_stop": this.busy = false; break;
      case "mouse_on": this.mouse = true; break;
      case "mouse_off": this.mouse = false; break;
      case "set_title": this.title = args[0] ?? ""; break;
      case "option_set": this.options[args[0]] = args[1]; break;
      case "popupmenu_show": {
        const [items, selected, row, col] = args;
        this.popup = { items, selected, row, col };
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
      case "msg_showmode": case "msg_showcmd": case "msg_ruler": case "msg_history_show":
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

  // A highlight's colors with nvim's rules: unset falls back to the defaults,
  // reverse swaps foreground and background.
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

  // A row as runs of one highlight: [{ col, cells, text, hl }]. A double-width
  // character is followed by an empty cell, which only adds to the run's width.
  runs(row) {
    const line = this.lines[row] ?? [];
    const out = [];
    for (let c = 0; c < line.length; c++) {
      const [text, hl] = line[c];
      const last = out[out.length - 1];
      if (last && last.hl === hl) { last.cells++; last.text += text; }
      else out.push({ col: c, cells: 1, text, hl });
    }
    return out;
  }

  // The cursor's shape in the current mode: "block", "vertical" or "horizontal", and how
  // much of the cell it covers.
  cursorShape() {
    const m = this.modes[this.mode] ?? {};
    return { shape: m.cursor_shape ?? "block", percentage: m.cell_percentage ?? 100, name: m.name ?? "" };
  }

  takeDirty() {
    const d = this.dirty;
    this.dirty = new Set();
    return d;
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
