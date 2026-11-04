// The + popover, in two levels. Level 1 picks where: a worktree of the project already open, one
// git knows but nothing has open, a branch without a worktree yet (local, or only on origin), or
// a new one named here. Level 2 picks what, in that worktree: a
// new Pi session, a terminal, or one of its past Pi sessions to resume (an open one is focused).
// Typing on level 1 also searches the sessions of every worktree of the project.
// Props: { repo?, name?, folder?, machine?, space?, level?, path?, branch?, worktrees? } (level 2 opens on `space`, or `path`;
// worktrees: the sidebar's prefetched checkouts, so the list shows at once).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, knownAgents, keys, window, shared } from "herdr";
import { repoOf, createWorktree, defaultBranch, remoteOnly, slug } from "../_lib/repo.js";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;
const HEIGHT = 404;
// Not the person's own chats: orchestrators ("Orchestrator" before they were named after their
// worktree, "<worktree>-orchestrator" since), and pi-subagents' workers ("general-purpose#534df88b").
const hidden = (name) => /^Orchestrator$|-(project-)?orchestrator$|#[0-9a-f]{6,}$/.test(name ?? "");

const git = (on) => async (cwd, args) => {
  const r = await exec("git", args, { cwd, on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

// Where a space's terminals are, as the sidebar reads it.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const base = (p) => p.replace(/\/+$/, "").split("/").pop();

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : m < 10080 ? `${Math.floor(m / 1440)}d` : `${Math.floor(m / 10080)}w`;
}

// Pi titles its terminal "π - <session name> - <folder>", or "π - <folder>" before it has one.
function piSession(title) {
  const parts = (title ?? "").split(" - ");
  return parts[0] === "π" && parts.length > 2 ? parts.slice(1, -1).join(" - ") : "";
}

// Pi keeps a worktree's sessions in one folder named after its path.
const sessionDir = (userHome, path) => `${userHome}/.pi/agent/sessions/--${path.replace(/^\/+/, "").replaceAll("/", "-")}--`;

// One pass over a folder's session files (they reach 50 MB, so the mod never reads them): per file,
// its message count, its last session_info name and its first real user message.
const SESSION_AWK = String.raw`function out() { if (f != "") printf "%s\t%d\t%s\t%s\n", f, n, name, first }
FNR == 1 { out(); f = FILENAME; n = 0; name = ""; first = "" }
/"type":"message"/ { n++ }
/"type":"session_info"/ { if (match($0, /"name":"[^"]*"/)) name = substr($0, RSTART + 8, RLENGTH - 9) }
first == "" && /"role":"user","content":/ {
  if (match($0, /"role":"user","content":(\[\{"type":"text","text":)?"[^"]*/)) {
    s = substr($0, RSTART, RLENGTH); sub(/^.*"/, "", s)
    if (s !~ /^<command-/ && s !~ /^<local-command/) first = substr(s, 1, 120)
  }
}
END { out() }`;

// A first message as one plain line: JSON escapes and runs of space collapsed.
const oneLine = (text) => text.replace(/\\[nrt]/g, " ").replace(/\\(["\\/])/g, "$1").replace(/\s+/g, " ").trim();

// The key bound to an action, as macOS writes it ("⌘⇧N").
function shortcut(action) {
  const b = keys().find((k) => k.section === "global" && k.action === action);
  if (!b?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+" };
  return b.keys.trim().split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
}

// Branches with no checkout, local or only on origin (as last fetched: nothing is fetched to
// open the popover), together by last commit, newest first.
async function branchesOf(cwd, on, trees) {
  const refs = await exec("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], { cwd, on }).catch(() => null);
  const checked = new Set(trees.map((w) => w.branch).filter(Boolean));
  const local = [];
  for (const line of (refs?.stdout ?? "").split("\n")) {
    const [branch, at] = line.split("\t");
    if (branch && !checked.has(branch)) local.push({ branch, at: (Number(at) || 0) * 1000, remote: false });
  }
  const taken = new Set([...checked, ...local.map((b) => b.branch)]);
  const remote = (await remoteOnly(git(on), cwd, taken, 400)).map((b) => ({ ...b, at: b.at * 1000 }));
  return [...local, ...remote].sort((a, b) => b.at - a.at);
}

// A repo's checkouts with their branch's last commit, newest first (the sidebar's loadTrees).
async function checkouts(cwd, on) {
  const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd, on }).catch(() => null);
  if (list?.code !== 0) return [];
  const refs = await exec("git", ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], { cwd, on }).catch(() => null);
  const when = new Map((refs?.stdout ?? "").split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, (Number(at) || 0) * 1000]));
  const out = [];
  for (const block of list.stdout.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.at - a.at);
}

export default class New extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const ps = panes();
    this.space0 = spaces().find((s) => s.id === p.space) ?? (p.repo ? null : spaces().find((s) => s.active));
    this.on = p.machine ?? this.space0?.machine ?? null;
    this.folder = p.folder || (this.space0 ? place(this.space0, ps) : null) || (p.repo ? JSON.parse(p.repo)[1] : null);
    this.name = p.name ?? null;
    this.trees = p.worktrees ?? undefined;
    this.branches = []; // branches without a checkout, once read
    this.repo = undefined; this.from = null; this.userHome = null;
    this.query = ""; this.sel = null; this.busy = false; this.error = "";
    // Sessions by worktree path: undefined while read, then newest first.
    this.sessions = new Map();
    // Level 2's worktree: { space?, path, branch }.
    // (A checkout with no space yet comes as `path` + `branch`: starting there makes its space.)
    this.here = p.level !== 2 ? null
      : p.path ? { space: this.space0?.id ?? null, path: p.path, branch: p.branch ?? base(p.path) }
      : this.space0 ? { space: this.space0.id, path: place(this.space0, ps), branch: this.space0.branch ?? this.space0.name } : null;
    const field = (placeholder) => {
      const f = InputState.new({ placeholder });
      f.on("change", (_e, cx) => {
        this.query = f.value().trim(); this.sel = null; this.error = "";
        this.emptyAt = this.query ? null : Date.now();
        cx.notify();
      });
      f.on("submit", (e, cx) => (e?.shift && this.here ? this.terminal() : this.go(cx)));
      return f;
    };
    this.where = field("Worktree, or a new branch name");
    this.what = field("Session, or what to start");
    this.emptyAt = 0;
    this.handle = cx.focus_handle();
    this.field().focus();
    cx.timer.after(300, () => this.field().focus());
    // knownAgents asks a login shell, which takes a while: the last answer shows at once.
    const saved = `agent:${this.on ?? ""}`;
    try { this.agent = JSON.parse(localStorage.getItem(saved) ?? "null"); } catch { this.agent = null; }
    cx.spawn(async (cx) => {
      try {
        this.userHome = this.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).stdout.trim() : home();
        this.repo = this.folder ? await repoOf(git(this.on), this.folder, this.userHome) : null;
      } catch { this.repo = null; }
      cx.notify();
      if (this.here) this.loadSessions(this.here.path, cx);
      if (!this.repo) return;
      if (this.trees === undefined) { this.trees = await checkouts(this.repo.main, this.on); cx.notify(); }
      this.branches = await branchesOf(this.repo.main, this.on, this.trees).catch(() => []);
      cx.notify();
      this.from = await defaultBranch(git(this.on), this.repo.main).catch(() => null);
      cx.notify();
      // Level 1's search reaches every worktree's sessions: read them after the list shows.
      for (const w of this.trees ?? []) await this.loadSessions(w.path, cx);
    });
    cx.spawn(async (cx) => {
      try {
        // Pi when it's there, else the agent Herdr ranks first.
        const all = (await knownAgents({ on: this.on })).filter((a) => a.installed);
        const a = all.find((x) => x.key === "pi") ?? all[0] ?? null;
        this.agent = a && { key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run };
        localStorage.setItem(saved, JSON.stringify(this.agent));
      } catch {}
      cx.notify();
    });
  }

  field() { return this.here ? this.what : this.where; }

  close() { if (props()?.overlay) closeOverlay(props().overlay); }

  // A worktree's Pi sessions, newest first. Files are re-read only when their mtime changed;
  // the rest comes from localStorage.
  async loadSessions(path, cx) {
    if (this.sessions.has(path) || !this.userHome) return;
    this.sessions.set(path, undefined);
    const dir = sessionDir(this.userHome, path);
    const on = this.on;
    const listing = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; stat -f "%m %N" -- *.jsonl 2>/dev/null || stat -c "%Y %n" -- *.jsonl 2>/dev/null', "sh", dir], { on }).catch(() => null);
    const files = (listing?.stdout ?? "").split("\n").map((l) => l.match(/^(\d+) (.+\.jsonl)$/)).filter(Boolean).map((m) => ({ name: m[2], mtime: Number(m[1]) }));
    const key = `sessions:${on ?? ""}:${dir}`;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch {}
    const stale = files.filter((f) => cache[f.name]?.[0] !== f.mtime);
    if (stale.length) {
      const out = await exec("awk", [SESSION_AWK, ...stale.map((f) => `${dir}/${f.name}`)], { on }).catch(() => null);
      const mtime = new Map(stale.map((f) => [f.name, f.mtime]));
      for (const line of (out?.stdout ?? "").split("\n")) {
        const [file, n, name, first] = line.split("\t");
        if (!file) continue;
        const b = base(file);
        cache[b] = [mtime.get(b), Number(n) || 0, name ?? "", oneLine(first ?? "")];
      }
    }
    const kept = {};
    for (const f of files) if (cache[f.name]) kept[f.name] = cache[f.name];
    try { localStorage.setItem(key, JSON.stringify(kept)); } catch {}
    const list = files.filter((f) => kept[f.name] && !hidden(kept[f.name][2])).map((f) => {
      const [mtime, count, name, first] = kept[f.name];
      const when = f.name.split("_")[0];
      return { file: `${dir}/${f.name}`, path, at: mtime * 1000, count, name, label: name || first || when, named: Boolean(name) };
    }).sort((a, b) => b.at - a.at);
    this.sessions.set(path, list);
    cx.notify();
  }

  // The tab a session already runs in: a Pi pane in that worktree titled with its name.
  openTab(s) {
    if (!s.named) return null;
    const p = panes().find((x) => x.app === "pi" && piSession(x.title) === s.name && x.cwd && inside(x.cwd, s.path));
    if (!p) return null;
    const space = spaces().find((x) => (x.tabs ?? []).some((t) => t.id === p.tab));
    return space ? { space: space.id, tab: p.tab, status: p.status } : null;
  }

  // Level 1: [{ kind: "create" | "open" | "checkout" | "session", ... }] by group, filtered.
  model1() {
    const ps = panes();
    const q = this.query.toLowerCase();
    const owned = new Set(Object.values(shared("nix.orchestrators") ?? {}));
    const trees = this.trees ?? [];
    const mine = spaces().filter((s) => !owned.has(s.id) && (s.machine ?? null) === this.on);
    const open = [], idle = [];
    for (const w of trees) {
      const s = mine.find((x) => { const at = place(x, ps); return at && inside(at, w.path); });
      (s ? open : idle).push({ kind: s ? "open" : "checkout", space: s ?? null, branch: w.branch ?? base(w.path), path: w.path, at: w.at });
    }
    // Outside git, the space itself is the one place to start something.
    if (this.repo === null && this.space0) open.push({ kind: "open", space: this.space0, branch: this.space0.name, path: this.folder, at: 0 });
    const match = (r) => !q || r.branch.toLowerCase().includes(q);
    const exact = trees.some((w) => (w.branch ?? "") === this.query) || this.branches.some((b) => b.branch === this.query);
    // A few recent ones on their own; every match (up to 30) while typing.
    const branches = this.branches.filter(match).slice(0, q ? 30 : 8).map((b) => ({ kind: "branch", ...b }));
    const create = this.repo && this.query && slug(this.query) && !exact ? [{ kind: "create", name: this.query }] : [];
    const sessions = [];
    if (q) {
      for (const w of trees) for (const s of this.sessions.get(w.path) ?? [])
        if (s.label.toLowerCase().includes(q)) sessions.push({ kind: "session", ...s, branch: w.branch ?? base(w.path) });
      sessions.sort((a, b) => b.at - a.at).splice(20);
    }
    return { create, open: open.filter(match), idle: idle.filter(match), branches, sessions };
  }

  // Level 2: the two actions, then the worktree's sessions (40, or every match while typing).
  model2() {
    const q = this.query.toLowerCase();
    const all = this.sessions.get(this.here.path);
    const sessions = all === undefined ? undefined
      : (q ? all.filter((s) => s.label.toLowerCase().includes(q)) : all.slice(0, 40)).map((s) => ({ kind: "session", ...s }));
    return { actions: [{ kind: "pi" }, { kind: "terminal" }], sessions, total: all?.length ?? 0 };
  }

  items() {
    if (this.here) { const m = this.model2(); return [...m.actions, ...(m.sessions ?? [])]; }
    const m = this.model1();
    return [...m.create, ...m.open, ...m.idle, ...m.branches, ...m.sessions];
  }

  // The row ↵ acts on: the one moved to, else the space this was opened for, else the first.
  current(list) {
    if (this.sel !== null) return list[Math.min(this.sel, list.length - 1)] ?? null;
    const at = !this.here && this.space0 && !this.query ? list.findIndex((r) => r.space?.id === this.space0.id) : -1;
    return list[at >= 0 ? at : 0] ?? null;
  }

  move(by, cx) {
    const list = this.items();
    if (!list.length) return;
    const now = list.indexOf(this.current(list));
    this.sel = (now + by + list.length) % list.length;
    cx.notify();
  }

  // Into level 2 for a worktree; `space` may come later for one just opened.
  enter(here, cx) {
    this.here = here;
    this.query = ""; this.sel = null; this.error = ""; this.emptyAt = Date.now();
    this.what.set_value("");
    this.what.focus();
    this.loadSessions(here.path, cx);
    cx.notify();
  }

  up(cx) {
    if (!this.repo) return;
    this.here = null;
    this.query = this.where.value().trim(); this.sel = null; this.emptyAt = this.query ? null : Date.now();
    this.where.focus();
    cx.notify();
  }

  // A space just made for a worktree: found by its folder once Herdr has it.
  follow(path, cx) {
    const before = new Set(spaces().map((s) => s.id));
    const look = (tries) => {
      const made = spaces().find((s) => !before.has(s.id) && s.folder && inside(s.folder, path));
      if (made && this.here?.path === path) { this.here = { ...this.here, space: made.id }; cx.notify(); }
      else if (!made && tries > 0) cx.timer.after(100, () => look(tries - 1));
    };
    cx.timer.after(100, () => look(40));
  }

  pi() { return this.agent?.key === "pi" ? this.agent.run : ["pi"]; }

  // Starts something in level 2's worktree; without its space yet, a space with it.
  start(tab) {
    const h = this.here;
    if (h.space) { run("space.select", { id: h.space }); run("tab.new", { space: h.space, folder: h.path, ...tab }); }
    else run("space.new", { folder: h.path, machine: this.on, ...(tab.argv ? { tab: tab.name, argv: tab.argv } : {}) });
    this.close();
  }

  terminal() { if (this.here) this.start({}); }

  go(cx, row) {
    if (this.busy) return;
    const target = row ?? this.current(this.items());
    if (!target) return;
    if (target.kind === "pi") return this.start({ argv: this.pi(), name: this.agent?.name ?? "Pi" });
    if (target.kind === "terminal") return this.start({});
    if (target.kind === "session") {
      const open = this.openTab(target);
      if (open) { run("space.select", { id: open.space }); run("tab.select", { id: open.tab }); return this.close(); }
      if (!this.here || this.here.path !== target.path) {
        const s = this.model1().open.find((r) => r.path === target.path)?.space;
        this.here = { space: s?.id ?? null, path: target.path, branch: target.branch };
      }
      return this.start({ argv: [...this.pi(), "--session", target.file], name: target.label.slice(0, 60) });
    }
    if (target.kind === "open") return this.enter({ space: target.space.id, path: target.path, branch: target.branch }, cx);
    if (target.kind === "checkout") {
      run("space.new", { folder: target.path, machine: this.on });
      this.enter({ space: null, path: target.path, branch: target.branch }, cx);
      return this.follow(target.path, cx);
    }
    // A new branch (create), or one that has no worktree yet (branch): a worktree for it.
    const name = target.kind === "branch" ? target.branch : target.name;
    this.busy = name; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { path } = await createWorktree(git(this.on), this.repo, name);
        run("space.new", { folder: path, machine: this.on });
        this.busy = false;
        this.enter({ space: null, path, branch: name }, cx);
        this.follow(path, cx);
        return;
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  key(e, cx) {
    const k = e.key, ctrl = e.modifiers.control;
    if (k === "escape") return this.close();
    if (k === "down" || (ctrl && k === "n")) { cx.stop_propagation(); return this.move(1, cx); }
    if (k === "up" || (ctrl && k === "p")) { cx.stop_propagation(); return this.move(-1, cx); }
    // ⌫ on a field that was already empty (not the one that just emptied it) goes up.
    if (k === "backspace" && this.here && !this.query && this.emptyAt !== null && Date.now() - this.emptyAt > 80) { cx.stop_propagation(); return this.up(cx); }
  }

  tile(t, strong) {
    return div().size(14).flex_none().rounded(3).bg(t.raised).flex().items_center().justify_center()
      .font_family("JetBrains Mono").font_bold().text_size(10).text_color(strong ? t.foreground : t.muted).child("π");
  }

  status(t, status) {
    if (status === "working") return svg(ICON("loader")).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" || status === "done") return div().flex_none().size(6).mx(3).rounded(3).bg(t[status]);
    return null;
  }

  label(text, t) {
    return div().h(22).px(8).flex().items_center().flex_none().text_size(11).text_color(t.muted).child(text);
  }

  note(text, color, t) {
    return div().h(30).px(8).flex().items_center().flex_none().text_size(12).text_color(color).truncate().child(text);
  }

  shell(id, on, t) {
    return h_flex().id(id).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)));
  }

  row(r, on, t) {
    const el = this.shell(r.kind === "create" ? "create" : r.kind === "session" ? `s-${r.file}` : r.kind === "branch" ? `b-${r.branch}` : `row-${r.path ?? r.kind}`, on, t)
      .on_click((_e, cx) => this.go(cx, r));
    const hint = (text) => div().flex_none().text_size(11).text_color(t.dim).child(text);
    if (r.kind === "create") {
      const root = this.repo?.root ?? "";
      const tilde = this.userHome && root.startsWith(this.userHome) ? `~${root.slice(this.userHome.length)}` : root;
      const sub = this.error || `${tilde}/${slug(r.name)}${this.from ? ` · from origin/${this.from}` : ""}`;
      return el.h(40)
        .child(svg(ICON("plus")).size(13).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().text_size(12.5).text_color(t.foreground).child("Create worktree ").child(div().font_medium().truncate().child(r.name)))
          .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).text_ellipsis_start().child(this.busy === r.name ? "Creating…" : sub)))
        .child(hint("↵"));
    }
    if (r.kind === "pi")
      return el.h(30).text_size(12.5).text_color(t.foreground).child(this.tile(t, true)).child(div().flex_1().child(`New ${this.agent?.name ?? "Pi"} session`)).child(hint("↵"));
    if (r.kind === "terminal")
      return el.h(30).text_size(12.5).text_color(t.foreground).child(svg(ICON("terminal")).size(13).flex_none().text_color(t.muted)).child(div().flex_1().child("Terminal")).child(hint("⇧↵"));
    if (r.kind === "session") {
      const open = this.openTab(r);
      return el.h(30).text_size(12.5).tooltip(r.label)
        .child(this.tile(t, Boolean(open)))
        .child(h_flex().flex_1().min_w(0).items_baseline()
          .child(div().min_w(0).truncate().text_color(r.named ? t.foreground : t.muted).child(r.label))
          .when(!this.here, (e) => e.child(div().flex_none().ml(6).text_size(11).text_color(t.dim).child(r.branch))))
        .child(div().w(32).flex_none().text_right().text_size(11).text_color(t.dim).child(String(r.count)))
        .child(h_flex().w(24).flex_none().justify_end().text_size(11).text_color(t.dim)
          .child(open ? (this.status(t, open.status) ?? div()) : div().child(ago(r.at))));
    }
    if (r.kind === "branch") {
      const busy = this.busy === r.branch;
      return el.h(30).text_size(12.5).tooltip(busy ? "Creating its worktree…" : r.remote ? `origin/${r.branch}: a worktree tracking it` : `${r.branch}: a worktree for it`)
        .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.branch))
        .when(r.remote && !busy, (e) => e.child(hint("origin")))
        .child(hint(busy ? "Creating…" : r.at ? ago(r.at) : ""));
    }
    const right = r.kind === "open" ? this.status(t, r.space.status) : r.at ? hint(ago(r.at)) : null;
    return el.h(30).text_size(12.5).text_color(t.foreground).tooltip(r.path ?? "")
      .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(r.branch))
      .when(Boolean(right), (e) => e.child(right));
  }

  hint(key, text, t) {
    return h_flex().gap(4).items_center().child(div().font_medium().text_color(t.muted).child(key)).child(text);
  }

  rows(t) {
    const list = this.items(), cur = this.current(list);
    // The models are rebuilt per call, so rows are matched by what they stand for.
    const key = (r) => r && `${r.kind}:${r.file ?? r.path ?? r.space?.id ?? r.name ?? r.branch ?? ""}`;
    const rows = [];
    const add = (r) => rows.push(this.row(r, key(r) === key(cur), t));
    if (this.here) {
      const m = this.model2();
      m.actions.forEach(add);
      if (m.sessions === undefined) rows.push(this.note("…", t.dim, t));
      else if (m.total) {
        rows.push(this.label(`Sessions · ${m.total}`, t));
        m.sessions.forEach(add);
        if (!m.sessions.length) rows.push(this.note(`No session named ${this.query}`, t.dim, t));
      }
      return rows;
    }
    if (this.repo === undefined || (this.repo && this.trees === undefined)) return [this.note("…", t.dim, t)];
    const m = this.model1();
    m.create.forEach(add);
    if (m.open.length) { rows.push(this.label(this.query ? "Matching" : "Open", t)); m.open.forEach(add); }
    if (m.idle.length) { rows.push(this.label(this.query && !m.open.length ? "Matching" : "Worktrees", t)); m.idle.forEach(add); }
    if (m.branches.length) { rows.push(this.label("Branches without a worktree", t)); m.branches.forEach(add); }
    if (this.error && !m.create.length) rows.push(this.note(this.error, t.blocked, t));
    if (m.sessions.length) { rows.push(this.label("Sessions", t)); m.sessions.forEach(add); }
    if (this.repo === null) rows.push(this.note(`${this.folder ?? "This folder"} isn't in a git repository`, t.blocked, t));
    else if (!list.length) rows.push(this.note(`No worktree named ${this.query}`, t.dim, t));
    return rows;
  }

  render() {
    const t = theme();
    const name = this.name ?? this.repo?.name ?? (this.folder ? base(this.folder) : "");
    const key = shortcut("nix-status.dispatch");
    let head = h_flex().h(32).flex_none().px(12).gap(6).items_center().text_size(12.5).font_medium();
    if (this.here) {
      head = head.when(Boolean(this.repo), (e) => e.child(div().id("up").ml(-6).size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).cursor_pointer().tooltip("Worktrees")
          .on_click((_e, cx) => this.up(cx)).child(svg(ICON("chevron-left")).size(13))))
        .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().child(this.here.branch ?? base(this.here.path)))
        .child(div().flex_none().text_size(11).font_normal().text_color(t.dim).child(name));
    } else {
      head = head.child(svg(ICON("folder")).size(13).flex_none().text_color(t.muted)).child(div().min_w(0).truncate().child(name));
    }
    head = head.when(Boolean(this.on), (e) => e.child(h_flex().flex_none().gap(4).items_center().text_size(11).font_normal().text_color(t.dim)
        .child(svg(ICON("server")).size(11)).child(this.on)))
      .child(div().flex_1())
      .when(Boolean(key), (e) => e.child(div().flex_none().text_size(11).font_normal().text_color(t.dim).child(key)));
    // A popup is as tall as its content, and the list only fills what is left: the height is
    // stated here (the openers ask for 404 too), or the list and its actions collapse to nothing.
    return v_flex().id("nix-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().h(HEIGHT).bg(t.popover).text_color(t.foreground)
      .child(head)
      .child(h_flex().flex_none().mx(8).mb(6).h(30).px(9).gap(7).items_center().rounded(6).border_1().border_color(t.ring ?? t.accent).bg(t.background)
        .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.field()).flex_1().h_full().text_size(12.5)))
      .child(v_flex().id("nix-new-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(this.rows(t)))
      .child(h_flex().h(40).flex_none().px(8).gap(10).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.hint("↵", this.here ? "Open" : "Choose", t))
        .when(Boolean(this.here && this.repo), (e) => e.child(this.hint("⌫", "Worktrees", t)))
        .child(this.hint("esc", "Close", t)));
  }
}
