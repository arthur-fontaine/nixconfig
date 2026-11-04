// A diff in the middle of the window, as Zed shows one: every changed file one
// under the other, each under a header that folds it, its hunks with line
// numbers, syntax colors, a bar in the margin (green added, yellow modified,
// red removed) and the changed words highlighted. Opened by nix-changes as a
// tab, with props { root, on, commit? }: the uncommitted changes, or a commit.
// The uncommitted changes are editable where they are: a click puts the caret in a line,
// keys go to the tab's Neovim (../../nix-editor/diff.lua), which holds the changed files,
// diffs them against HEAD after each change and sends the hunks back (edit.js). ⌘S saves,
// Esc leaves the text, ⌘-click opens the file in the editor.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { props, exec, readTextFile, watchFolder, theme, settings, shared, setShared, spaces, panes, run, notify, home, appHome } from "herdr";
import { addedFile, parsePatch, rowsOf } from "./model.js";
import { languageOf, splitAt, tokenize } from "./syntax.js";
import { columnAt, editableFiles, liveFile, selectedCols, CELL } from "./edit.js";
import { openInEditor } from "../_lib/editor.js";
import { nvimKey } from "../nix-editor/grid.js";
import { startNvim } from "../nix-editor/nvim.js";

// The editor (../_lib/editor.js) gets the herdr functions it uses.
const HERDR = { spaces, panes, run, shared, setShared, notify };

// Writes nothing under .git, so the folder watch doesn't wake itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "-U3"];
const ICON = (name) => `mods/nix-head/icons/${name}.svg`;
const SIZE = { file: 36, gap: 6, hunk: 24, line: 20, note: 28, end: 10 };
const UNTRACKED_MAX = 200;
// Cmd chords the diff's text keeps while it has the caret; the others stay Herdr's.
const OWN_CMD = new Set(["s", "z", "a", "c", "x", "v", "left", "right", "up", "down", "backspace"]);

const ago = (s) => {
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

export default class Diff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root; this.on = p.on ?? null; this.commit = p.commit ?? null;
    this.files = []; this.view = []; this.rows = []; this.folded = new Set(); this.meta = null; this.error = null; this.loading = true;
    this.scroll = VirtualListScrollHandle.new();
    this.focusSeen = null;
    // The editable diff: its Neovim, each file's hunks as it last sent them, its caret
    // ({ rel, line, col, mode, sel }), the file being typed in, the rows on screen.
    this.cx = cx;
    this.handle = cx.focus_handle();
    this.nvim = null; this.live = new Map(); this.caret = null; this.editing = null;
    this.visible = { start: 0, end: 0 }; this.pointer = null;
    this.editable = !this.commit && !this.on && Boolean(this.root) && typeof startNvim === "function";
    if (this.editable) this.startEditor();
    this.load(cx);
    // A commit never changes; the working tree does.
    if (!this.commit && !this.on && this.root) this.watch(cx);
    else if (!this.commit) cx.timer.every(10000, (cx) => this.load(cx));
  }

  // No async function and no task: Herdr's script runtime frees what they capture once they
  // return (nix-editor's lesson); the connection's callbacks live as long as the view.
  startEditor() {
    const onNotify = (name, args) => {
      if (name === "herdr_diff") this.onLive(args?.[0]);
      else if (name === "herdr_diff_caret") this.onCaret(args?.[0]);
      else if (name === "nvim_closed") { this.nvim = null; this.editing = null; this.cx.notify(); }
    };
    startNvim({ home: home(), appHome: appHome(), cwd: this.root, width: 120, height: 40, config: "diff.lua", onRedraw: () => {}, onNotify })
      .then((nvim) => { this.nvim = nvim; this.syncFiles(); }, () => {});
  }

  close() {
    this.nvim?.close();
    this.nvim = null;
  }

  // The files git lists, for Neovim to hold (and to diff against HEAD).
  syncFiles() {
    if (!this.nvim || this.loading) return;
    this.nvim.notify("nvim_exec_lua", "_G.herdr_diff_files(...)", [editableFiles(this.files, this.root)]);
  }

  rel(path) {
    return path?.startsWith(this.root + "/") ? path.slice(this.root.length + 1) : null;
  }

  onLive(msg) {
    const rel = this.rel(msg?.file);
    if (!rel) return;
    this.live.set(rel, liveFile({}, msg));
    this.layout();
    this.cx.notify();
  }

  // The caret where Neovim has it, kept in sight.
  onCaret(msg) {
    const rel = this.rel(msg?.file);
    if (!rel) return;
    this.caret = { ...msg, rel };
    const i = this.rows.findIndex((r) => r.type === "line" && r.line.kind !== "-" && r.line.new === msg.line && this.view[r.file]?.path === rel);
    if (i >= 0 && (i < this.visible.start || i >= this.visible.end - 1)) this.scroll.scroll_to_item(i, "center");
    this.cx.notify();
  }

  // A click on a line of an editable file: the caret there, keys to Neovim.
  edit(path, line, col) {
    if (!this.nvim) return;
    this.editing = path;
    this.handle.focus();
    this.nvim.notify("nvim_exec_lua", "_G.herdr_diff_focus(...)", [`${this.root}/${path}`, line, col]);
    this.cx.notify();
  }

  stopEditing() {
    this.editing = null;
    this.nvim?.notify("nvim_exec_lua", "_G.herdr_diff_blur()", []);
    this.cx.notify();
  }

  // Keys while a file has the caret, as the editor sends them (Neovim notation); the system
  // clipboard through ⌘C/⌘X/⌘V. Esc leaves the text (a selection first).
  key(e, cx) {
    if (!this.editing || !this.nvim) return;
    const m = e.modifiers;
    if (e.key === "escape" && !m.platform && !this.caret?.sel) { cx.stop_propagation(); return this.stopEditing(); }
    if (m.platform && !OWN_CMD.has(e.key)) return;
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
      this.cx.timer.after(30, (cx) => {
        this.nvim?.request("nvim_call_function", "getreg", ["+"]).then((text) => {
          if (typeof text === "string" && text) cx.write_to_clipboard(text);
        }, () => {});
      }, { owner: this });
    }
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(this.root); this.load(cx); } } catch {}
    });
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root, on: this.on });
  }

  load(cx) {
    if (!this.root) { this.error = "No repository"; this.loading = false; return; }
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        let files;
        if (this.commit) {
          const [show, head] = await Promise.all([
            this.git(["show", "--format=", ...DIFF, this.commit]),
            this.git(["show", "-s", "--format=%H%x00%h%x00%an%x00%at%x00%s%x00%b", this.commit]),
          ]);
          if (show.code !== 0) throw new Error(show.stderr.trim() || "git show failed");
          const [sha, short, author, time, subject, body] = head.stdout.split("\0");
          this.meta = { sha, short, author, time: +time, subject, body: (body ?? "").trim() };
          files = parsePatch(show.stdout);
        } else {
          const hasHead = (await this.git(["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
          const diff = await this.git(["diff", ...(hasHead ? ["HEAD"] : ["--cached"]), ...DIFF]);
          if (diff.code !== 0) throw new Error(diff.stderr.trim() || "git diff failed");
          files = parsePatch(diff.stdout);
          const others = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
          for (const path of others.stdout.split("\0").filter(Boolean).slice(0, UNTRACKED_MAX)) {
            const text = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
            files.push(text === null || text.includes("\0")
              ? { path, oldPath: null, status: "A", binary: true, hunks: [], add: 0, del: 0, lines: 0, cut: false }
              : addedFile(path, text.slice(0, 400000)));
          }
          files.sort((a, b) => a.path.localeCompare(b.path));
        }
        this.files = files; this.error = null;
        this.loading = false;
        this.layout();
        this.syncFiles();
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; this.busy = false; cx.notify();
        if (this.again) { this.again = false; this.load(cx); }
      }
    });
  }

  // The files as drawn: git's, each editable one with the hunks its Neovim sent last.
  layout() {
    this.view = this.files.map((f) => {
      const live = !f.binary && f.status !== "D" ? this.live.get(f.path) : null;
      return live ? { ...f, ...live } : f;
    });
    this.rows = rowsOf(this.view, this.folded);
    this.sizes = this.rows.map((r) => SIZE[r.type]);
    const longest = Math.max(0, ...this.view.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.text.length))));
    this.width = Math.max(600, longest * 7.9 + 130);
  }

  toggle(path, cx) {
    this.folded.has(path) ? this.folded.delete(path) : this.folded.add(path);
    this.layout(); cx.notify();
  }

  foldAll(cx) {
    const all = this.files.every((f) => this.folded.has(f.path));
    this.folded = all ? new Set() : new Set(this.files.map((f) => f.path));
    this.layout(); cx.notify();
  }

  // nix-changes asks a shown diff to jump to a file through shared state.
  followFocus() {
    const want = shared("nix-diff.focus");
    if (!want || want.n === this.focusSeen || want.commit !== this.commit || want.root !== this.root) return;
    const i = this.rows.findIndex((r) => r.type === "file" && this.view[r.file].path === want.path);
    if (i < 0) return;
    this.focusSeen = want.n;
    if (this.folded.delete(want.path)) this.layout();
    this.scroll.scroll_to_item(i, "top");
  }

  openFile(path, line) {
    openInEditor(HERDR, `${this.root}/${path}`, { line: line ?? 1 });
  }

  colors(t) {
    return {
      keyword: t.ansi5, string: t.ansi2, number: t.ansi3, constant: t.ansi3, function: t.ansi4,
      type: t.ansi6, property: t.ansi1, comment: t.dim, operator: t.ansi6, punctuation: t.muted,
    };
  }

  // The git status letter, mono, as the Changes panel shows it.
  statusIcon(status, t) {
    const color = { A: t.ansi2, D: t.ansi1, R: t.ansi4, U: t.ansi5 }[status] ?? t.ansi3;
    return div().w(10).flex_none().font_family(this.mono).text_size(11).font_medium().text_color(color).text_center().child(status);
  }

  fileRow(f, t) {
    const open = !this.folded.has(f.path);
    const slash = f.path.lastIndexOf("/");
    const name = f.path.slice(slash + 1), dir = slash >= 0 ? f.path.slice(0, slash) : "";
    // A 36px bar like the panels' headers, on chrome between hairlines.
    return h_flex().w_full().h(SIZE.file).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(12.5)
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none().text_color(t.dim))
      .child(this.statusIcon(f.status, t))
      .child(div().flex_none().font_medium().text_color(t.foreground).child(name))
      .when(Boolean(f.modified), (e) => e.child(div().size(6).rounded(3).flex_none().bg(t.ansi3)))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.status === "R" && f.oldPath ? `${dir}  ← ${f.oldPath}` : dir))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(5).text_size(11)
        .when(f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${f.del}`))));
  }

  // One handler for the whole list (rows can't hold their own): a header folds its file;
  // a line of an editable file gets the caret where it was clicked (this.pointer, from the
  // list's mouse-down); ⌘-click, or a line of a commit, opens the file in the editor there.
  click(key, cx) {
    const r = this.rows[+key.split(":")[1]];
    if (!r) return;
    const f = this.view[r.file];
    if (r.type === "file") return this.toggle(f.path, cx);
    if (r.type !== "line" || f.status === "D") return;
    if (f.live && this.nvim && !this.pointer?.cmd) {
      if (r.line.kind !== "-") this.edit(f.path, r.line.new, columnAt(this.pointer?.x ?? 0));
      return;
    }
    this.openFile(f.path, r.line.new ?? r.line.old);
  }

  lineRow(f, line, t, syn) {
    const lang = (f.lang ??= languageOf(f.path));
    const bar = line.block === "modified" ? t.ansi3 : line.block === "added" ? t.ansi2 : line.block === "removed" ? t.ansi1 : null;
    const bg = line.kind === "+" ? t.ansi2 + "1a" : line.kind === "-" ? t.ansi1 + "1a" : null;
    const strong = line.kind === "+" ? t.ansi2 + "40" : t.ansi1 + "40";
    const sign = line.kind === "+" ? ["+", t.ansi2] : line.kind === "-" ? ["−", t.ansi1] : [" ", t.dim];
    const parts = (line.parts ??= splitAt(tokenize(line.text, lang), line.changed));
    const number = line.kind === "-" ? line.old : line.new;
    // An editable line takes a text cursor; a removed one is only read; a commit's opens.
    const editable = f.live && line.kind !== "-";
    const here = editable && this.editing === f.path && this.caret?.rel === f.path ? this.caret : null;
    const sel = here ? selectedCols(here.sel, line.new, line.text.length) : null;
    const caret = here && here.line === line.new ? here.col : null;
    const text = h_flex().flex_none().relative().whitespace_nowrap()
      .when(Boolean(sel), (e) => e.child(div().absolute().top(1).bottom(1).left(sel[0] * CELL).w((sel[1] - sel[0]) * CELL).bg(t.selection ?? t.accent + "40")))
      .children(parts.map((p) =>
        div().flex_none().text_color(p.kind ? syn[p.kind] ?? t.foreground : t.foreground)
          .when(p.changed, (e) => e.bg(strong).rounded(2)).child(p.text)))
      .when(caret !== null, (e) => e.child(div().absolute().top(1).bottom(1).left(caret * CELL - 1).w(2).bg(t.accent)));
    return h_flex().w_full().h(SIZE.line).flex_none().items_center().font_family(this.mono).text_size(13).when(Boolean(bg), (e) => e.bg(bg))
      .when(editable, (e) => e.cursor_text()).when(!f.live && f.status !== "D", (e) => e.cursor_pointer())
      // The line the caret is on stands out a little, as in the editor.
      .when(caret !== null && !bg, (e) => e.bg(t.hover))
      .child(div().w(3).h_full().flex_none().when(Boolean(bar), (e) => e.bg(bar)))
      .child(div().w(48).flex_none().pr(10).text_right().text_size(11).text_color(caret !== null ? t.foreground : t.dim).child(String(number)))
      .child(div().w(16).flex_none().text_color(sign[1]).child(sign[0]))
      .child(text);
  }

  // Zed's fold line between hunks: lines were skipped here.
  hunkRow(t) {
    return h_flex().w_full().h(SIZE.hunk).flex_none().items_center().bg(t.chrome).text_size(12).text_color(t.muted)
      .child(div().w(51).flex_none().pr(10).text_right().font_family(this.mono).child("⋯"));
  }

  row(r, t, syn) {
    const f = this.view[r.file];
    if (r.type === "file") return this.fileRow(f, t);
    if (r.type === "hunk") return this.hunkRow(t);
    if (r.type === "gap") return div().w_full().h(SIZE.gap).flex_none();
    if (r.type === "line") return this.lineRow(f, r.line, t, syn);
    if (r.type === "note") return div().w_full().h(SIZE.note).flex_none().px(72).flex().items_center().text_color(t.dim).italic().child(r.text);
    return div().w_full().h(SIZE.end).flex_none();
  }

  header(t) {
    const add = this.view.reduce((n, f) => n + f.add, 0), del = this.view.reduce((n, f) => n + f.del, 0);
    const allFolded = this.files.length > 0 && this.files.every((f) => this.folded.has(f.path));
    const unsaved = this.view.filter((f) => f.modified).length;
    const bar = h_flex().h(36).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(svg(ICON(this.commit ? "git-branch" : "git-compare")).size(14).flex_none().text_color(t.muted))
      .child(div().font_medium().min_w(0).truncate().child(this.commit ? (this.meta?.subject ?? this.commit.slice(0, 7)) : "Uncommitted Changes"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${this.files.length} ${this.files.length === 1 ? "file" : "files"}`))
      .child(div().flex_1())
      .when(unsaved > 0, (e) => e.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.muted)
        .child(div().size(6).rounded(3).bg(t.ansi3)).child(`${unsaved} unsaved · ⌘S`)))
      .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`))
      .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`))
      .when(this.files.length > 0, (e) => e.child(
        div().id("fold-all").flex_none().h(24).px(8).flex().items_center().rounded(6).text_size(12).font_medium().text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.foldAll(cx)).child(allFolded ? "Expand all" : "Collapse all")));
    if (!this.commit || !this.meta) return bar;
    const m = this.meta;
    return v_flex().flex_none().child(bar).child(
      v_flex().flex_none().px(12).py(10).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(10).items_center().text_size(12).text_color(t.muted)
          .child(div().px(6).py(1).rounded(3).bg(t.raised).font_family(this.mono).text_size(11).child(m.short))
          .child(div().child(m.author))
          .child(div().text_color(t.dim).child(ago(m.time))))
        .when(Boolean(m.body), (e) => e.child(div().text_size(12.5).text_color(t.muted).child(m.body))),
    );
  }

  render(cx) {
    const t = theme(), syn = this.colors(t);
    this.mono = settings().font_family ?? "JetBrains Mono";
    this.followFocus();
    const body = this.error
      ? div().p(16).text_size(12).text_color(t.ansi1).child(this.error)
      : !this.files.length
        ? div().p(16).text_size(12).text_color(t.dim).child(this.loading ? "Loading changes…" : this.commit ? "This commit changes no files" : "No uncommitted changes")
        : div().flex_1().min_h(0).relative()
          .child(div().id("diff-x").size_full().overflow_x_scrollbar()
            .child(div().min_w(this.width).w_full().h_full()
              // Where a click lands (the list's click knows only the row): x for the column.
              .on_mouse_down("left", (e) => { this.pointer = { x: e.local_position?.x ?? 0, cmd: Boolean(e.modifiers?.platform) }; })
              .child(
              v_virtual_list("diff-rows", this.rows.length, this.sizes, (i) => `${this.rows[i].type}:${i}`,
                (range) => { this.visible = range; return this.rows.slice(range.start, range.end).map((r) => this.row(r, t, syn)); })
                .track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)).size_full())))
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
    return v_flex().id("nix-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(this.header(t)).child(body);
  }
}
