// Changes, as Zed's git panel: the changed files in Tracked and Untracked
// sections with a box to stage each, the branch with ahead/behind, a commit
// box, and the branch's history, the focused agent's commits first. Diffs open
// in the middle, as a tab (the nix-diff mod): a file jumps to its place in
// "Uncommitted Changes", a commit opens its own diff, shown the same way.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, agents, hc, exec, watchFolder, theme, settings, shared, setShared, run } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  // A mod pane (a diff, a board) has no folder: use the tab's terminal, else the space's.
  const ps = panes(), tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const own = (p) => p.terminal && p.cwd;
  const pane = (f?.pane ? ps.find((p) => p.pane === f.pane && own(p)) : null)
    ?? ps.find((p) => p.tab === f?.tab && own(p)) ?? ps.find((p) => tabs.has(p.tab) && own(p)) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
const LOG = 40;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

function ago(s) {
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.commits = []; this.branch = null; this.started = {}; this.tabs = {};
    this.message = ""; this.handle = cx.focus_handle(); this.focusN = 0;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  git(args, extra = READ) {
    return exec("git", [...extra, ...args], { cwd: this.root, on: this.on });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.commits = []; this.branch = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.commits = []; this.error = "Not a git repository"; return; }
        this.root = top.stdout.trim(); this.on = on;
        const [status, numstat, branch] = await Promise.all([
          this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
          this.git(["diff", "HEAD", "--numstat", "-z", "--no-renames"]),
          this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        const stats = {};
        for (const entry of numstat.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0 };
        }
        const files = [];
        const entries = status.stdout.split("\0");
        for (let i = 0; i < entries.length && files.length < 1000; i++) {
          const entry = entries[i];
          if (!entry) continue;
          const x = entry[0], y = entry[1], path = entry.slice(3);
          // A rename's old path follows it as its own field.
          if (x === "R" || x === "C") i++;
          const untracked = x === "?";
          const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
          const s = conflict ? "U" : untracked || x === "A" ? "A" : x === "D" || y === "D" ? "D" : x === "R" ? "R" : "M";
          const staged = untracked ? "none" : x !== " " && y === " " ? "all" : x !== " " ? "some" : "none";
          files.push({ path, status: s, untracked, staged, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        const b = { name: null, ahead: 0, behind: 0, upstream: null };
        for (const line of branch.stdout.split("\n")) {
          if (line.startsWith("# branch.head ")) b.name = line.slice(14);
          else if (line.startsWith("# branch.upstream ")) b.upstream = line.slice(18);
          else if (line.startsWith("# branch.ab ")) {
            const [a, d] = line.slice(12).split(" ");
            b.ahead = Math.abs(parseInt(a, 10)) || 0; b.behind = Math.abs(parseInt(d, 10)) || 0;
          }
        }
        if (key() !== context) return;
        this.files = files; this.branch = b; this.error = null;
        await this.loadLog(context);
        this.watch(this.root, cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The agent whose session the history marks: the focused one, else the last
  // one seen in this space (a diff tab in front doesn't change it).
  sessionAgent() {
    const f = focused(), list = agents();
    const now = list.find((a) => a.focused) ?? list.find((a) => a.tab === f?.tab);
    if (now) this.lastAgent = now.address;
    return list.find((a) => a.address === this.lastAgent) ?? null;
  }

  async sessionStart() {
    const a = this.sessionAgent();
    if (!a) return null;
    if (!(a.address in this.started)) {
      const r = await hc(["get", a.address, "--json"]).catch(() => null);
      let ms = null;
      try { ms = JSON.parse(r?.stdout ?? "").created_ms ?? null; } catch {}
      this.started[a.address] = ms;
    }
    return this.started[a.address];
  }

  async loadLog(context) {
    const r = await this.git(["log", `-n${LOG}`, "--format=%H%x00%h%x00%ct%x00%an%x00%s"]).catch(() => null);
    if (key() !== context) return;
    if (r?.code !== 0) { this.commits = []; return; }
    const since = await this.sessionStart();
    this.commits = r.stdout.split("\n").filter(Boolean).map((line) => {
      const [sha, short, time, author, subject] = line.split("\0");
      return { sha, short, time: +time, author, subject, session: since !== null && +time * 1000 >= since };
    });
  }

  // A diff in the middle: the tab it already has, else a new one. The new tab's
  // id shows up in spaces() a moment after tab.new.
  openDiff(commit, title, cx) {
    const space = spaces().find((s) => s.active);
    if (!space || !this.root) return;
    const id = `${this.root}\0${commit ?? ""}`;
    const known = this.tabs[id];
    if (known && space.tabs.some((t) => t.id === known)) { run("tab.select", { id: known }); return; }
    const before = new Set(space.tabs.map((t) => t.id));
    run("tab.new", { name: title, mod: "nix-diff", props: { root: this.root, on: this.on, commit } });
    cx.spawn(async (cx) => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => cx.timer.after(100, r));
        const added = spaces().find((s) => s.id === space.id)?.tabs.find((t) => !before.has(t.id));
        if (added) { this.tabs[id] = added.id; break; }
      }
    });
  }

  showFile(path, cx) {
    this.openDiff(null, "Uncommitted Changes", cx);
    setShared("nix-diff.focus", { n: `${Date.now()}-${++this.focusN}`, root: this.root, commit: null, path });
  }

  // git add / unstage; the folder watch refreshes the list.
  act(args, cx) {
    if (this.busy || !this.root) return;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.git(args, []);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { this.note = String(e.message ?? e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggleStage(f, cx) {
    if (f.staged === "all") this.act(this.commits.length ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path], cx);
    else this.act(["add", "--", f.path], cx);
  }

  stageAll(cx) {
    const all = this.files.length && this.files.every((f) => f.staged === "all");
    this.act(all ? ["reset", "-q"] : ["add", "-A"], cx);
  }

  // Zed commits what is staged, or every change when nothing is.
  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const message = this.message.trim(), context = this.context, anyStaged = this.files.some((f) => f.staged !== "none");
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [...(anyStaged ? [] : [["add", "-A"]]), ["commit", "-m", message]]) {
          const r = await this.git(args, []);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  checkbox(state, t, onClick, id) {
    return div().id(id).size(15).flex_none().rounded(4).border_1().cursor_pointer()
      .border_color(state === "none" ? t.input ?? t.border : t.accent).when(state !== "none", (e) => e.bg(t.accent))
      .flex().items_center().justify_center()
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(state === "all", (e) => e.child(svg(ICON("check")).size(11).text_color(t.accent_foreground ?? t.background)))
      .when(state === "some", (e) => e.child(div().w(7).h(2).rounded(1).bg(t.accent_foreground ?? t.background)));
  }

  statusIcon(status, t) {
    const color = status === "A" ? t.ansi2 : status === "D" || status === "U" ? t.ansi1 : status === "R" ? t.ansi4 : t.ansi3;
    const mark = status === "A" ? "plus" : status === "D" ? "minus" : null;
    return div().size(14).flex_none().rounded(3).border_1().border_color(color).flex().items_center().justify_center()
      .child(mark ? svg(ICON(mark)).size(10).text_color(color) : div().size(4).rounded(2).bg(color));
  }

  fileRow(f, t) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "", name = f.path.slice(slash + 1);
    return h_flex().id(`change-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.showFile(f.path, cx))
      .child(this.checkbox(f.staged, t, (cx) => this.toggleStage(f, cx), `stage-${f.path}`))
      .child(this.statusIcon(f.status, t))
      .child(h_flex().flex_1().min_w(0)
        .child(div().min_w(0).flex_shrink(1).truncate().text_color(t.dim).child(dir))
        .child(div().flex_none().text_color(f.status === "D" ? t.muted : t.foreground).when(f.status === "D", (e) => e.line_through()).child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  section(label, files, t) {
    if (!files.length) return [];
    const state = files.every((f) => f.staged === "all") ? "all" : files.some((f) => f.staged !== "none") ? "some" : "none";
    const toggle = (cx) => this.act(state === "all" ? ["reset", "-q", "--", ...files.map((f) => f.path)] : ["add", "--", ...files.map((f) => f.path)], cx);
    return [
      h_flex().h(26).flex_none().px(8).mt(4).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(this.checkbox(state, t, toggle, `stage-section-${label}`)).child(label),
      ...files.map((f) => this.fileRow(f, t)),
    ];
  }

  commitRow(c, t) {
    return h_flex().id(`commit-${c.sha}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openDiff(c.sha, c.subject.length > 32 ? `${c.subject.slice(0, 31)}…` : c.subject, cx))
      .child(div().size(7).flex_none().rounded(4).bg(c.session ? t.accent : t.border))
      .child(div().flex_1().min_w(0).truncate().text_color(c.session ? t.foreground : t.muted).child(c.subject))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.time)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const tracked = this.files.filter((f) => !f.untracked), untracked = this.files.filter((f) => f.untracked);
    const allStaged = this.files.length > 0 && this.files.every((f) => f.staged === "all");
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && this.files.length);
    const mine = this.commits.filter((c) => c.session).length;
    const b = this.branch;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      // Header: "12 Changes", the whole diff, Stage All.
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(this.files.length ? `${this.files.length} ${this.files.length === 1 ? "Change" : "Changes"}` : "No Changes"))
        .child(div().flex_1())
        .when(this.files.length > 0, (e) => e
          .child(div().id("open-diff").px(7).py(3).rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.openDiff(null, "Uncommitted Changes", cx)).child("View Diff"))
          .child(div().id("stage-all").px(7).py(3).rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.stageAll(cx)).child(allStaged ? "Unstage All" : "Stage All"))))
      // The files.
      .child(v_flex().id("changes-list").flex_1().min_h(80).overflow_y_scrollbar().px(6).pb(6)
        .children([...this.section("Tracked", tracked, t), ...this.section("Untracked", untracked, t)])
        .when(!this.files.length, (e) => e.child(div().p(10).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading changes…" : this.root ? "Nothing to commit" : "No folder")))))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(11.5).text_color(t.ansi1).child(this.note)))
      // Branch, then the commit box.
      .child(v_flex().flex_none().border_t(1).border_color(t.border)
        .when(Boolean(b?.name), (e) => e.child(h_flex().h(32).px(12).gap(7).items_center().text_size(12).text_color(t.muted)
          .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().child(b.upstream ? `${b.upstream.split("/")[0]}/${b.name}` : b.name))
          .child(div().flex_1())
          .when(b.behind > 0, (e) => e.child(div().text_color(t.ansi1).child(`↓${b.behind}`)))
          .when(b.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${b.ahead}`)))))
        .child(v_flex().px(10).pb(10).gap(8)
          .child(div().id("commit-message").h(34).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().text_size(11.5).text_color(t.dim)
              .child(this.files.some((f) => f.staged !== "none") ? "Commits the staged changes" : this.files.length ? "Commits every change" : ""))
            .child(div().id("commit").h(28).px(14).flex().items_center().rounded(7).bg(enabled ? t.solid : t.raised)
              .text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer())
              .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")))))
      // History: the session's commits marked.
      .when(this.commits.length > 0, (e) => e.child(v_flex().flex_none().h(Math.min(260, 40 + this.commits.length * 28)).border_t(1).border_color(t.border)
        .child(h_flex().h(32).flex_none().px(12).gap(8).items_center()
          .child(div().text_size(11.5).text_color(t.dim).child("History"))
          .when(mine > 0, (e) => e.child(div().px(6).py(1).rounded(4).bg(t.accent + "26").text_size(11).text_color(t.accent)
            .child(`${mine} this session`))))
        .child(v_flex().id("changes-commits").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6)
          .children(this.commits.map((c) => this.commitRow(c, t))))));
  }
}
