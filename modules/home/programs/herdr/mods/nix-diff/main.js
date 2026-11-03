// A diff in the middle of the window, as Zed shows one: every changed file one
// under the other, each under a header that folds it, its hunks with line
// numbers, syntax colors, a bar in the margin (green added, yellow modified,
// red removed) and the changed words highlighted. Opened by nix-changes as a
// tab, with props { root, on, commit? }: the uncommitted changes, or a commit.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { props, exec, readTextFile, watchFolder, theme, settings, shared, setShared, spaces, run } from "herdr";
import { addedFile, parsePatch, rowsOf } from "./model.js";
import { languageOf, splitAt, tokenize } from "./syntax.js";

// A file in the editor (nix-editor): the tab it already has in this space, else a new one
// named after it. nix-files and nix-diff share the tab → file map, so either finds the
// other's tab; a line moves that editor there through nix-editor.goto.
function openInEditor(file, line) {
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const tabs = shared("nix.editorTabs") ?? {};
  const known = space.tabs.find((t) => tabs[t.id] === file);
  if (known) {
    run("tab.select", { id: known.id });
    if (line) setShared("nix-editor.goto", { file, line, n: Date.now() });
    return;
  }
  const before = new Set(space.tabs.map((t) => t.id));
  run("tab.new", { name: file.split("/").pop(), mod: "nix-editor", props: { file, ...(line ? { line } : {}) } });
  const added = spaces().find((s) => s.id === space.id)?.tabs.find((t) => !before.has(t.id));
  if (added) setShared("nix.editorTabs", { ...tabs, [added.id]: file });
}

// Writes nothing under .git, so the folder watch doesn't wake itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "-U3"];
const ICON = (name) => `mods/nix-head/icons/${name}.svg`;
const SIZE = { file: 36, gap: 6, hunk: 24, line: 20, note: 28, end: 10 };
const UNTRACKED_MAX = 200;

const ago = (s) => {
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

export default class Diff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root; this.on = p.on ?? null; this.commit = p.commit ?? null;
    this.files = []; this.rows = []; this.folded = new Set(); this.meta = null; this.error = null; this.loading = true;
    this.scroll = VirtualListScrollHandle.new();
    this.focusSeen = null;
    this.load(cx);
    // A commit never changes; the working tree does.
    if (!this.commit && !this.on && this.root) this.watch(cx);
    else if (!this.commit) cx.timer.every(10000, (cx) => this.load(cx));
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
        this.layout();
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; this.busy = false; cx.notify();
        if (this.again) { this.again = false; this.load(cx); }
      }
    });
  }

  layout() {
    this.rows = rowsOf(this.files, this.folded);
    this.sizes = this.rows.map((r) => SIZE[r.type]);
    const longest = Math.max(0, ...this.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.text.length))));
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
    const i = this.rows.findIndex((r) => r.type === "file" && this.files[r.file].path === want.path);
    if (i < 0) return;
    this.focusSeen = want.n;
    if (this.folded.delete(want.path)) this.layout();
    this.scroll.scroll_to_item(i, "top");
  }

  openFile(path, line) {
    openInEditor(`${this.root}/${path}`, line ?? 1);
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
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.status === "R" && f.oldPath ? `${dir}  ← ${f.oldPath}` : dir))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(5).text_size(11)
        .when(f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${f.del}`))));
  }

  // One handler for the whole list (rows can't hold their own): a header folds
  // its file, a line opens the file in the editor there, as clicking a line in Zed's
  // diff jumps to it.
  click(key, cx) {
    const r = this.rows[+key.split(":")[1]];
    if (!r) return;
    const f = this.files[r.file];
    if (r.type === "file") return this.toggle(f.path, cx);
    if (r.type === "line" && f.status !== "D") this.openFile(f.path, r.line.new ?? r.line.old);
  }

  lineRow(f, line, t, syn) {
    const lang = (f.lang ??= languageOf(f.path));
    const bar = line.block === "modified" ? t.ansi3 : line.block === "added" ? t.ansi2 : line.block === "removed" ? t.ansi1 : null;
    const bg = line.kind === "+" ? t.ansi2 + "1a" : line.kind === "-" ? t.ansi1 + "1a" : null;
    const strong = line.kind === "+" ? t.ansi2 + "40" : t.ansi1 + "40";
    const sign = line.kind === "+" ? ["+", t.ansi2] : line.kind === "-" ? ["−", t.ansi1] : [" ", t.dim];
    const parts = (line.parts ??= splitAt(tokenize(line.text, lang), line.changed));
    const number = line.kind === "-" ? line.old : line.new;
    return h_flex().w_full().h(SIZE.line).flex_none().items_center().cursor_pointer().font_family(this.mono).text_size(13).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(Boolean(bar), (e) => e.bg(bar)))
      .child(div().w(48).flex_none().pr(10).text_right().text_size(11).text_color(t.dim).child(String(number)))
      .child(div().w(16).flex_none().text_color(sign[1]).child(sign[0]))
      .child(h_flex().flex_none().whitespace_nowrap().children(parts.map((p) =>
        div().flex_none().text_color(p.kind ? syn[p.kind] ?? t.foreground : t.foreground)
          .when(p.changed, (e) => e.bg(strong).rounded(2)).child(p.text))));
  }

  // Zed's fold line between hunks: lines were skipped here.
  hunkRow(t) {
    return h_flex().w_full().h(SIZE.hunk).flex_none().items_center().bg(t.chrome).text_size(12).text_color(t.muted)
      .child(div().w(51).flex_none().pr(10).text_right().font_family(this.mono).child("⋯"));
  }

  row(r, t, syn) {
    const f = this.files[r.file];
    if (r.type === "file") return this.fileRow(f, t);
    if (r.type === "hunk") return this.hunkRow(t);
    if (r.type === "gap") return div().w_full().h(SIZE.gap).flex_none();
    if (r.type === "line") return this.lineRow(f, r.line, t, syn);
    if (r.type === "note") return div().w_full().h(SIZE.note).flex_none().px(72).flex().items_center().text_color(t.dim).italic().child(r.text);
    return div().w_full().h(SIZE.end).flex_none();
  }

  header(t) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const allFolded = this.files.length > 0 && this.files.every((f) => this.folded.has(f.path));
    const bar = h_flex().h(36).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(svg(ICON(this.commit ? "git-branch" : "git-compare")).size(14).flex_none().text_color(t.muted))
      .child(div().font_medium().min_w(0).truncate().child(this.commit ? (this.meta?.subject ?? this.commit.slice(0, 7)) : "Uncommitted Changes"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${this.files.length} ${this.files.length === 1 ? "file" : "files"}`))
      .child(div().flex_1())
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
            .child(div().min_w(this.width).w_full().h_full().child(
              v_virtual_list("diff-rows", this.rows.length, this.sizes, (i) => `${this.rows[i].type}:${i}`,
                (range) => this.rows.slice(range.start, range.end).map((r) => this.row(r, t, syn)))
                .track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)).size_full())))
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.header(t)).child(body);
  }
}
