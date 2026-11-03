// A lazy file browser for the focused pane's folder. Shipped: files preview in
// the panel. Here a file opens in the editor (nix-editor), in a tab of its own.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, shared, setShared, notify } from "herdr";
import { openInEditor } from "../_lib/editor.js";

// The editor (../_lib/editor.js) gets the herdr functions it uses.
const HERDR = { spaces, panes, run, shared, setShared, notify };

function location() {
  const space = spaces().find(s => s.active), f = focused();
  // A mod pane (a diff, a board) has no folder: use the tab's terminal, else the space's.
  const ps = panes(), tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const own = (p) => p.terminal && p.cwd;
  const pane = (f?.pane ? ps.find((p) => p.pane === f.pane && own(p)) : null)
    ?? ps.find((p) => p.tab === f?.tab && own(p)) ?? ps.find((p) => tabs.has(p.tab) && own(p)) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.changedOnly = localStorage.getItem("changedOnly") === "1";
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // ⌥-click: beside the file the editor shows.
  edit(path, side) {
    if (this.root) openInEditor(HERDR, `${this.root}/${path}`, { side });
  }

  // A tree row: a 16px indent per level with its guide (rows touch, so guides join into lines),
  // the chevron's 10px box, the icon, the name, and the git mark or a changed-folder dot.
  row(path, name, dir, depth, t) {
    const open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`] ?? this.marks[`${this.root}/${path}/`];
    const on = this.opened === path;
    const changed = dir && !mark && this.markedDirs.has(path);
    const color = { A: t.ansi2, D: t.ansi1, U: t.ansi5 }[mark] ?? t.ansi3;
    return h_flex().id(`file-${path}`).h(26).flex_none().pl(6).pr(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
      .when(on, (s) => s.bg(t.selected)).when(!on, (s) => s.hover((s) => s.bg(t.hover)))
      .on_click((e, cx) => { if (!dir) this.opened = path; dir ? this.toggle(path, cx) : this.edit(path, e.modifiers.alt); })
      .children(Array.from({ length: depth }, () => div().w(16).h_full().flex_none().child(div().ml(11).w(1).h_full().bg(t.border))))
      .child(div().w(10).mr(6).flex_none().flex().items_center().justify_center()
        .when(dir, (e) => e.child(svg(`mods/nix-head/icons/chevron-${open || this.changedOnly ? "down" : "right"}.svg`).size(10).text_color(t.dim))))
      .child(svg(`mods/nix-head/icons/${dir ? "folder" : "file"}.svg`).size(14).mr(6).flex_none().text_color(t.muted))
      // Dotfiles in dim.
      .child(div().flex_1().min_w(0).truncate().text_color(name.startsWith(".") ? t.dim : t.foreground).child(name))
      .when(Boolean(mark), (el) => el.child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).font_medium().text_color(color).child(mark)))
      .when(changed, (el) => el.child(div().flex_none().size(5).rounded(3).bg(t.dim)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(this.row(path, entry.name, entry.dir, depth, t));
      if (entry.dir && this.folders.has(path)) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Changed files only: the folders on the way to a marked file, all open, and the marked files.
  changedRows(t) {
    const prefix = `${this.root}/`, tree = new Map([["", new Map()]]);
    for (const abs of Object.keys(this.marks)) {
      if (!abs.startsWith(prefix)) continue;
      const parts = abs.slice(prefix.length).replace(/\/$/, "").split("/");
      let at = "";
      parts.forEach((name, i) => {
        const path = at ? `${at}/${name}` : name, dir = i < parts.length - 1;
        tree.get(at).set(name, { name, dir });
        if (dir && !tree.has(path)) tree.set(path, new Map());
        at = path;
      });
    }
    const out = [];
    const walk = (at, depth) => {
      const kids = [...(tree.get(at)?.values() ?? [])].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
      for (const k of kids) {
        const path = at ? `${at}/${k.name}` : k.name;
        out.push(this.row(path, k.name, k.dir, depth, t));
        if (k.dir) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const branch = spaces().find((s) => s.active)?.branch;
    // Folders that hold a marked file, for their dot.
    this.markedDirs = new Set();
    for (const abs of Object.keys(this.marks)) {
      if (!this.root || !abs.startsWith(`${this.root}/`)) continue;
      const parts = abs.slice(this.root.length + 1).replace(/\/$/, "").split("/");
      for (let i = 1; i < parts.length; i++) this.markedDirs.add(parts.slice(0, i).join("/"));
    }
    const only = this.changedOnly;
    return v_flex().id("files").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").size(20).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.show(null); cx.notify(); })
          .child(svg("mods/nix-head/icons/chevron-left.svg").size(12))))
        .child(div().flex_none().font_medium().child("Files"))
        .child(div().ml(6).flex_1().min_w(0).text_ellipsis_start().text_size(11).text_color(t.dim).child(this.file ?? branch ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file, el => el.child(div().id("changed-only").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(only, (e) => e.bg(t.selected).text_color(t.foreground)).when(!only, (e) => e.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .tooltip("Changed files only")
          .on_click((_e, cx) => { this.changedOnly = !only; localStorage.setItem("changedOnly", this.changedOnly ? "1" : "0"); cx.notify(); })
          .child(svg("mods/nix-head/icons/git-compare.svg").size(14)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(4).children(only ? this.changedRows(t) : this.rows("", 0, [], t))
        .when(only && !this.error && !this.markedDirs.size && !Object.keys(this.marks).length, el => el.child(div().p(12).text_size(12).text_color(t.dim).child("No changed files")))
        .when(!only && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(12).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(12).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
