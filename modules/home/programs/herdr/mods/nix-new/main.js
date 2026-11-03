// The + popover: start Pi or a terminal in a worktree of the project, one already open, one git
// knows but nothing has open, or a new one named here. Replaces the sidebar's idle-worktree rows.
// Props: { repo?, name?, folder?, machine?, space?, worktrees? } (worktrees: the sidebar's
// prefetched checkouts, so the list shows at once; without them they're read here).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, knownAgents, keys, window, shared } from "herdr";
import { repoOf, createWorktree, defaultBranch, slug } from "../_lib/repo.js";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;

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

// The key bound to an action, as macOS writes it ("⌘⇧N").
function shortcut(action) {
  const b = keys().find((k) => k.section === "global" && k.action === action);
  if (!b?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+" };
  return b.keys.trim().split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
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
    this.repo = undefined; this.from = null; this.userHome = null;
    this.query = ""; this.sel = null; this.busy = false; this.error = "";
    this.start = localStorage.getItem("start") ?? "agent";
    this.field = InputState.new({ placeholder: "Worktree, or a new branch name" });
    this.field.on("change", (_e, cx) => { this.query = this.field.value().trim(); this.sel = null; this.error = ""; cx.notify(); });
    this.field.on("submit", (_e, cx) => this.go(cx));
    this.handle = cx.focus_handle();
    this.field.focus();
    cx.timer.after(300, () => this.field.focus());
    // knownAgents asks a login shell, which takes a while: the last answer shows at once.
    const saved = `agent:${this.on ?? ""}`;
    try { this.agent = JSON.parse(localStorage.getItem(saved) ?? "null"); } catch { this.agent = null; }
    cx.spawn(async (cx) => {
      try {
        this.userHome = this.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).stdout.trim() : home();
        this.repo = this.folder ? await repoOf(git(this.on), this.folder, this.userHome) : null;
      } catch { this.repo = null; }
      cx.notify();
      if (!this.repo) return;
      if (this.trees === undefined) { this.trees = await checkouts(this.repo.main, this.on); cx.notify(); }
      this.from = await defaultBranch(git(this.on), this.repo.main).catch(() => null);
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        // Pi when it's there, else the agent Herdr ranks first.
        const all = (await knownAgents({ on: this.on })).filter((a) => a.installed);
        const a = all.find((x) => x.key === "pi") ?? all[0] ?? null;
        this.agent = a && { key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run };
        localStorage.setItem(saved, JSON.stringify(this.agent));
      } catch {}
      if (!this.agent) this.start = "terminal";
      cx.notify();
    });
  }

  close() { if (props()?.overlay) closeOverlay(props().overlay); }

  // [{ kind: "create" | "open" | "checkout", ... }] in display order, filtered by the field.
  model() {
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
    const exact = trees.some((w) => (w.branch ?? "") === this.query);
    const create = this.repo && this.query && slug(this.query) && !exact ? [{ kind: "create", name: this.query }] : [];
    return { create, open: open.filter(match), idle: idle.filter(match) };
  }

  items(m) { return [...m.create, ...m.open, ...m.idle]; }

  // The row ↵ acts on: the one moved to, else the space this was opened for, else the first.
  current(list) {
    if (this.sel !== null) return list[Math.min(this.sel, list.length - 1)] ?? null;
    const at = this.space0 && !this.query ? list.findIndex((r) => r.space?.id === this.space0.id) : -1;
    return list[at >= 0 ? at : 0] ?? null;
  }

  move(by, cx) {
    const list = this.items(this.model());
    if (!list.length) return;
    const now = list.indexOf(this.current(list));
    this.sel = (now + by + list.length) % list.length;
    cx.notify();
  }

  go(cx, row) {
    if (this.busy) return;
    const target = row ?? this.current(this.items(this.model()));
    if (!target) return;
    localStorage.setItem("start", this.start);
    const agent = this.start === "agent" ? this.agent : null;
    const program = agent ? { argv: agent.run, name: agent.name } : {};
    if (target.kind === "open") {
      run("space.select", { id: target.space.id });
      run("tab.new", { space: target.space.id, ...program });
      return this.close();
    }
    if (target.kind === "checkout") {
      run("space.new", { folder: target.path, machine: this.on, ...(agent ? { tab: agent.name, argv: agent.run } : {}) });
      return this.close();
    }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { path } = await createWorktree(git(this.on), this.repo, target.name);
        run("space.new", { folder: path, machine: this.on, ...(agent ? { tab: agent.name, argv: agent.run } : {}) });
        this.close();
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  key(e, cx) {
    const k = e.key, ctrl = e.modifiers.control;
    if (k === "escape") return this.close();
    if (k === "down" || (ctrl && k === "n")) { cx.stop_propagation(); return this.move(1, cx); }
    if (k === "up" || (ctrl && k === "p")) { cx.stop_propagation(); return this.move(-1, cx); }
    // Tab switches what starts, without leaving the field.
    if (k === "tab" && this.agent) { cx.stop_propagation(); this.start = this.start === "agent" ? "terminal" : "agent"; cx.notify(); }
  }

  pi(t, strong) {
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

  row(r, on, t) {
    const id = r.kind === "create" ? "create" : `row-${r.path}`;
    const el = h_flex().id(id).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.go(cx, r));
    if (r.kind === "create") {
      const root = this.repo?.root ?? "";
      const tilde = this.userHome && root.startsWith(this.userHome) ? `~${root.slice(this.userHome.length)}` : root;
      const sub = this.error || `${tilde}/${slug(r.name)}${this.from ? ` · from origin/${this.from}` : ""}`;
      return el.h(40)
        .child(svg(ICON("plus")).size(13).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().text_size(12.5).text_color(t.foreground).child("Create worktree ").child(div().font_medium().truncate().child(r.name)))
          .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).text_ellipsis_start().child(this.busy ? "Creating…" : sub)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("↵"));
    }
    const right = r.kind === "open" ? this.status(t, r.space.status) : r.at ? div().flex_none().text_size(11).text_color(t.dim).child(ago(r.at)) : null;
    return el.h(30).text_size(12.5).text_color(t.foreground).tooltip(r.path ?? "")
      .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(r.branch))
      .when(Boolean(right), (e) => e.child(right));
  }

  option(id, on, icon, label, pick, t) {
    return h_flex().id(id).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { pick(); cx.notify(); })
      .child(icon).child(div().text_size(12).text_color(on ? t.foreground : t.muted).child(label));
  }

  hint(key, text, t) {
    return h_flex().gap(4).items_center().child(div().font_medium().text_color(t.muted).child(key)).child(text);
  }

  render() {
    const t = theme(), a = this.agent;
    const m = this.model(), list = this.items(m), cur = this.current(list);
    const name = this.name ?? this.repo?.name ?? (this.folder ? base(this.folder) : "");
    const rows = [];
    if (this.repo === undefined || (this.repo && this.trees === undefined)) rows.push(div().h(30).px(8).flex().items_center().text_size(12.5).text_color(t.dim).child("…"));
    else {
      for (const r of m.create) rows.push(this.row(r, r === cur, t));
      if (m.open.length) rows.push(this.label(this.query ? "Matching" : "Open", t), ...m.open.map((r) => this.row(r, r === cur, t)));
      if (m.idle.length) rows.push(this.label(this.query && !m.open.length ? "Matching" : "Worktrees", t), ...m.idle.map((r) => this.row(r, r === cur, t)));
      if (this.repo === null) rows.push(div().h(30).px(8).flex().items_center().text_size(12).text_color(t.blocked).truncate().child(`${this.folder ?? "This folder"} isn't in a git repository`));
      else if (!list.length) rows.push(div().h(30).px(8).flex().items_center().text_size(12).text_color(t.dim).truncate().child(`No worktree named ${this.query}`));
    }
    const key = shortcut("nix-status.dispatch");
    return v_flex().id("nix-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(32).flex_none().px(12).gap(6).items_center()
        .child(svg(ICON("folder")).size(13).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(12.5).font_medium().child(name))
        .when(Boolean(this.on), (e) => e.child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim)
          .child(svg(ICON("server")).size(11)).child(this.on)))
        .child(div().flex_1())
        .when(Boolean(key), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(key))))
      .child(h_flex().flex_none().mx(8).mb(6).h(30).px(9).gap(7).items_center().rounded(6).border_1().border_color(t.ring ?? t.accent).bg(t.background)
        .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.field).flex_1().h_full().text_size(12.5)))
      .child(v_flex().id("nix-new-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(rows))
      .child(h_flex().h(40).flex_none().px(8).gap(2).items_center().border_t(1).border_color(t.border)
        .when(Boolean(a), (e) => e.child(this.option("start-agent", this.start === "agent",
          a?.key === "pi" ? this.pi(t, this.start === "agent") : svg(a?.icon ?? ICON("terminal")).size(12).text_color(t.foreground),
          a?.name ?? "", () => { this.start = "agent"; }, t)))
        .child(this.option("start-terminal", this.start === "terminal", svg(ICON("terminal")).size(12).text_color(t.muted), "Terminal", () => { this.start = "terminal"; }, t))
        .child(div().flex_1())
        .child(h_flex().flex_none().gap(10).items_center().text_size(11).text_color(t.dim)
          .when(Boolean(a), (e) => e.child(this.hint("⇥", `${a?.name ?? "Pi"} / Terminal`, t)))
          .child(this.hint("↵", "Start", t))));
  }
}
