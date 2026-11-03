// The left sidebar, as one tree: repos, their worktrees (one per space), and
// each worktree's tabs (agents by their session name, terminals, diffs). What
// needs you is pinned on top. A repo's checkouts without a space fold under it,
// and repos seen once stay listed, folded, until forgotten. Outside git a space
// is a plain folder row. Click to go there; + on a repo makes a worktree, + on a
// worktree starts Pi or a terminal in it; right-click a worktree for its menu.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, machines, run, openOverlay, exec, theme, window, layout, watchFolder, setAgentOrder, pickFolder } from "herdr";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;
// Repo state can only change on its own this rarely while nothing happens here.
const FALLBACK = 60000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();
// A repo's name from its common git dir: `repo/.git`, `repo.git`, or a bare `repo/.bare`.
function repoName(common) {
  const dir = common.replace(/\/+$/, "");
  return base(dir).startsWith(".") ? base(dir.slice(0, dir.lastIndexOf("/"))) : base(dir).replace(/\.git$/, "");
}
// The repo's own folder from its common git dir, as segments.
function repoPath(common) {
  const dir = common.replace(/\/+$/, "");
  const root = base(dir).startsWith(".") ? dir.slice(0, dir.lastIndexOf("/")) : dir.replace(/\.git$/, "");
  return root.split("/").filter(Boolean);
}
// Names that tell repos apart: a name shared by several repos takes parent folders
// until each is unique (ddd-ts/monorepo, application/monorepo).
function distinctNames(commons) {
  const paths = new Map(commons.map((c) => [c, repoPath(c)]));
  const depth = new Map(commons.map((c) => [c, 1]));
  const name = (c) => paths.get(c).slice(-depth.get(c)).join("/");
  for (let changed = true; changed;) {
    changed = false;
    const seen = new Map();
    for (const c of commons) seen.set(name(c), [...(seen.get(name(c)) ?? []), c]);
    for (const group of seen.values()) {
      if (group.length < 2) continue;
      for (const c of group) if (depth.get(c) < paths.get(c).length) { depth.set(c, depth.get(c) + 1); changed = true; }
    }
  }
  return new Map(commons.map((c) => [c, name(c)]));
}
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
// Pi titles its terminal "π - <session name> - <folder>", or "π - <folder>" before it has one.
function piSession(title) {
  const parts = (title ?? "").split(" - ");
  return parts[0] === "π" && parts.length > 2 ? parts.slice(1, -1).join(" - ") : "";
}

export default class Sidebar extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { repo, common, name, branch, ahead, behind, dirty, linked } | null
    this.checked = {};
    this.born = {};
    this.trees = {}; // repo key -> its checkouts [{ path, branch, at }]
    this.busy = {}; // pane -> busy at the last look (a turn ending re-reads its repo)
    this.watching = new Set();
    this.hovered = null;
    this.filter = "";
    this.repos = JSON.parse(localStorage.getItem("repos") ?? "[]"); // [{ key, on, common, name }]
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.idleOpen = new Set(JSON.parse(localStorage.getItem("idleOpen") ?? "[]"));
    this.input = InputState.new({ placeholder: "Filter" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.timer.every(400, (cx) => this.tick(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  save(name, set) { localStorage.setItem(name, JSON.stringify([...set])); }

  toggle(set, name, id, cx) {
    set.has(id) ? set.delete(id) : set.add(id);
    this.save(name, set);
    if (set === this.idleOpen && set.has(id)) this.loadTrees(id, cx);
    cx.notify();
  }

  // Which places to read again: new ones, those where a turn just ended, and stale ones.
  tick(cx) {
    const now = Date.now(), sp = spaces(), ps = panes();
    const due = new Set();
    const keyOf = {};
    for (const s of sp) {
      const k = where(s, ps);
      keyOf[s.id] = k;
      this.born[s.id] ??= now;
      if (!(k in this.git) && !this.checking?.has(k)) due.add(k);
      else if (window()?.active && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
    }
    const spaceOfTab = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOfTab[t.id] = s;
    const busy = {};
    for (const p of ps) {
      const s = spaceOfTab[p.tab];
      if (!p.terminal || !s) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) due.add(keyOf[s.id]);
    }
    this.busy = busy;
    for (const k of due) this.check(k, cx);
  }

  check(key, cx) {
    (this.checking ??= new Set()).add(key);
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    cx.spawn(async (cx) => {
      try {
        const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
        if (st.code !== 0) { this.git[key] = null; return; }
        const rp = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd, on });
        const [common, top] = rp.stdout.trim().split("\n");
        const info = { common, repo: JSON.stringify([on, common]), name: repoName(common), branch: null, ahead: 0, behind: 0, dirty: 0, linked: top !== undefined && `${top}/.git` !== common };
        for (const line of st.stdout.split("\n")) {
          if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
          else if (line.startsWith("# branch.ab ")) {
            const [a, b] = line.slice(12).split(" ");
            info.ahead = Math.abs(parseInt(a, 10)) || 0;
            info.behind = Math.abs(parseInt(b, 10)) || 0;
          } else if (line && !line.startsWith("#")) info.dirty++;
        }
        this.git[key] = info;
        this.remember(info, on);
        await this.loadTrees(info.repo, cx);
        if (!on) this.watch(info.repo, common, cx);
      } catch { this.git[key] ??= null; }
      finally { this.checking.delete(key); cx.notify(); }
    });
  }

  remember(info, on) {
    if (this.repos.some((r) => r.key === info.repo)) return;
    this.repos.push({ key: info.repo, on, common: info.common, name: info.name });
    localStorage.setItem("repos", JSON.stringify(this.repos));
  }

  forget(key, cx) {
    this.repos = this.repos.filter((r) => r.key !== key);
    localStorage.setItem("repos", JSON.stringify(this.repos));
    cx.notify();
  }

  async loadTrees(repoKey, cx) {
    const [on, common] = JSON.parse(repoKey);
    const list = await exec("git", ["--git-dir", common, "worktree", "list", "--porcelain"], { cwd: common, on }).catch(() => null);
    if (list?.code !== 0) { this.trees[repoKey] = []; return; }
    const refs = await exec("git", ["--git-dir", common, "for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], { cwd: common, on }).catch(() => null);
    const when = new Map((refs?.stdout ?? "").split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, (Number(at) || 0) * 1000]));
    const out = [];
    for (const block of list.stdout.split(/\n\n+/)) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
      out.push({ path, branch, at: branch ? (when.get(branch) ?? 0) : 0 });
    }
    this.trees[repoKey] = out.sort((a, b) => b.at - a.at);
    cx?.notify();
  }

  // Commits, checkouts and new worktrees land in the common dir: read the repo's places again.
  watch(repoKey, common, cx) {
    if (this.watching.has(repoKey)) return;
    this.watching.add(repoKey);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(common);
          for (const [k, g] of Object.entries(this.git)) if (g?.repo === repoKey) this.check(k, cx);
        }
      } catch { this.watching.delete(repoKey); }
    });
  }

  // The tree: repos (in the order their first space comes), each with its spaces and
  // checkouts; plain folders; then repos seen before without a space now.
  model() {
    const sp = spaces(), ps = panes(), now = Date.now();
    const repos = new Map(), folders = [];
    for (const s of sp) {
      const k = where(s, ps), g = this.git[k];
      if (g === undefined && now - (this.born[s.id] ?? now) < 1500) continue; // a moment for its git, so it doesn't jump
      if (!g) { folders.push({ s, g: null }); continue; }
      if (!repos.has(g.repo)) repos.set(g.repo, { key: g.repo, name: g.name, on: s.machine ?? null, items: [] });
      repos.get(g.repo).items.push({ s, g });
    }
    for (const r of this.repos) if (!repos.has(r.key)) repos.set(r.key, { key: r.key, name: r.name, on: r.on, items: [], closed: true });
    // Each machine's repos are told apart among themselves.
    for (const on of new Set([...repos.values()].map((r) => r.on))) {
      const mine = [...repos.values()].filter((r) => r.on === on);
      const names = distinctNames(mine.map((r) => JSON.parse(r.key)[1]));
      for (const r of mine) r.name = names.get(JSON.parse(r.key)[1]);
    }
    this.names = new Map([...repos.values()].map((r) => [r.key, r.name]));
    const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
    for (const r of repos.values()) {
      const at = r.items.map(({ s }) => place(s, ps));
      r.idle = (this.trees[r.key] ?? []).filter((c) => !at.some((p) => p && inside(p, c.path)));
      r.ahead = r.items.reduce((n, { g }) => n + g.ahead, 0);
      r.behind = r.items.reduce((n, { g }) => n + g.behind, 0);
    }
    const open = [...repos.values()].filter((r) => !r.closed);
    const closed = [...repos.values()].filter((r) => r.closed).sort((a, b) => a.name.localeCompare(b.name));
    return { open, closed, folders, ps };
  }

  // A tab as people know it: the agent's session, else its own name, else what runs in it.
  tabInfo(tab, ps) {
    const own = ps.filter((p) => p.tab === tab.id);
    const lead = own.find((p) => p.program?.agent) ?? own.find((p) => p.focused) ?? own[0];
    const session = lead?.app === "pi" ? piSession(lead.title) : "";
    const label = !tab.named && session ? session
      : tab.named ? tab.name
      : lead?.mod ? lead.title
      : lead?.program?.shell ? "Terminal"
      : lead?.program?.name ?? "Terminal";
    return { lead, label };
  }

  matches(text) { return !this.filter || text.toLowerCase().includes(this.filter); }

  // Status at the end of a row: one vocabulary everywhere (working ring, needs-you and done dots).
  status(t, status) {
    if (status === "working") return svg(ICON("loader")).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" || status === "done") return div().flex_none().size(6).mx(3).rounded(3).bg(t[status]);
    return null;
  }

  // A program's mark: Pi as a small π tile, other agents their glyph, terminals the prompt icon.
  picture(lead, t, size, strong = false) {
    const p = lead?.program;
    if (lead?.app === "pi" || p?.key === "pi")
      return div().size(14).flex_none().rounded(3).bg(t.raised).flex().items_center().justify_center()
        .font_family("JetBrains Mono").font_bold().text_size(10).text_color(strong ? t.foreground : t.muted).child("π");
    if (lead?.mod) return svg(ICON("git-compare")).size(13).flex_none().text_color(t.dim);
    if (!p?.icon || p.shell) return svg(ICON("terminal")).size(13).flex_none().text_color(t.dim);
    return p.tint ? svg(p.icon).size(size).flex_none().text_color(strong ? t.foreground : t.muted) : image(p.icon).w(size).h(size).flex_none();
  }

  hoverable(id, el) {
    return el.id(id).on_hover((on, cx) => {
      if (on) this.hovered = id;
      else if (this.hovered === id) this.hovered = null;
      cx.notify();
    });
  }

  small(id, icon, tip, onClick, t) {
    return div().id(id).size(20).flex_none().rounded(6).flex().items_center().justify_center().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(ICON(icon)).size(12));
  }

  needsYou(t, ps, info) {
    const list = agents().filter((a) => a.status === "blocked" || a.status === "done")
      .sort((a, b) => (b.status === "blocked") - (a.status === "blocked") || b.seq - a.seq);
    if (!list.length) return null;
    const blocked = list.some((a) => a.status === "blocked");
    const row = (a) => {
      const space = spaces().find((s) => s.id === a.space);
      const tab = space?.tabs.find((x) => x.id === a.tab);
      const { lead, label } = tab ? this.tabInfo(tab, ps) : { lead: null, label: a.title };
      const g = space ? info(space) : null;
      const repo = g ? this.names?.get(g.repo) ?? g.name : null;
      const where = g ? [repo, g.branch && g.branch !== g.name ? g.branch : null].filter(Boolean).join(" / ") : space?.name ?? "";
      return h_flex().id(`need-${a.address}`).h(40).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .child(this.picture(lead ?? { program: a.program, app: a.app }, t, 14, true))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(label))
          .child(div().truncate().text_size(11).text_color(t.dim).child(where)))
        .child(this.status(t, a.status));
    };
    // A plain section, its label in the state's color; a hairline closes it.
    return v_flex().flex_none()
      .child(h_flex().h(24).px(10).gap(6).items_center().text_size(11).font_medium().text_color(blocked ? t.blocked : t.done)
        .child(blocked ? "Needs you" : "Done").child(div().text_color(t.dim).font_normal().child(String(list.length))))
      .children(list.slice(0, 5).map(row))
      .child(div().h(1).flex_none().mx(4).my(8).bg(t.border));
  }

  tabRow(s, tab, ps, t, order) {
    const { lead, label } = this.tabInfo(tab, ps);
    for (const a of agents()) if (a.tab === tab.id) order.push(a.address);
    const id = `tab-${tab.id}`, on = s.active && tab.active;
    const time = tab.status === "working" ? tab.working_since : tab.changed_at;
    return this.hoverable(id, h_flex().h(28).pl(40).pr(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((x) => x.bg(t.hover)))
      .on_click(() => { run("space.select", { id: s.id }); run("tab.select", { id: tab.id }); })
      .child(this.picture(lead, t, 14, on))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(label))
      .when(this.hovered === id, (e) => e.child(this.small(`close-${tab.id}`, "x", "Close", () => run("tab.close", { id: tab.id }), t)))
      .when(this.hovered !== id && Boolean(time) && tab.status !== "idle", (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(time))))
      .when(Boolean(this.status(t, tab.status)), (e) => e.child(this.status(t, tab.status))));
  }

  worktreeRow({ s, g }, ps, t, order) {
    const id = `space-${s.id}`, folded = this.folded.has(s.id);
    const title = g ? (g.branch ?? "detached") : s.name;
    const tabs = (s.tabs ?? []).filter((x) => !x.settled);
    const rows = [this.hoverable(id, h_flex().h(28).pl(24).pr(10).gap(7).items_center().rounded(6).cursor_pointer()
      .when(s.active && (folded || !tabs.length), (e) => e.bg(t.selected)).when(!(s.active && (folded || !tabs.length)), (e) => e.hover((x) => x.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "nix-menu", kind: "popup", width: 210, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(div().id(`fold-${s.id}`).w(12).h(14).flex_none().flex().items_center().justify_center().text_color(t.dim)
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(this.folded, "folded", s.id, cx); })
        .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(10)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(s.active ? t.foreground : t.muted).child(title))
      .when(this.hovered !== id && Boolean(g?.dirty || g?.behind || g?.ahead), (e) => e.child(h_flex().flex_none().gap(8).text_size(11).text_color(t.dim)
        .when(Boolean(g?.dirty), (e) => e.child(div().tooltip(`${g.dirty} changed files`).child(`±${g.dirty}`)))
        .when(g?.behind > 0, (e) => e.child(div().child(`↓${g.behind}`)))
        .when(g?.ahead > 0, (e) => e.child(div().child(`↑${g.ahead}`)))))
      .when(this.hovered === id, (e) => e.child(this.small(`add-${s.id}`, "plus", "Start Pi or a terminal here",
        () => openOverlay({ mod: "nix-new-menu", kind: "popup", width: 240, height: 140, props: { space: s.id } }), t)))
      .when(folded && this.hovered !== id, (e) => e.when(Boolean(this.status(t, s.status)), (e) => e.child(this.status(t, s.status)))))];
    if (!folded) for (const tab of tabs) rows.push(this.tabRow(s, tab, ps, t, order));
    return rows;
  }

  idleRows(r, t) {
    if (!r.idle.length) return [];
    const open = this.idleOpen.has(r.key) || Boolean(this.filter);
    const shown = r.idle.filter((c) => this.matches(c.branch ?? c.path) || this.matches(r.name));
    const rows = [h_flex().id(`idle-${r.key}`).h(26).pl(24).pr(10).gap(7).items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.muted))
      .on_click((_e, cx) => this.toggle(this.idleOpen, "idleOpen", r.key, cx))
      .child(div().w(12).h(14).flex_none().flex().items_center().justify_center().child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10)))
      .child(r.items.length ? `${r.idle.length} more ${r.idle.length === 1 ? "worktree" : "worktrees"}` : `${r.idle.length} ${r.idle.length === 1 ? "worktree" : "worktrees"}`)];
    if (open) for (const c of shown) {
      rows.push(h_flex().id(`checkout-${c.path}`).h(26).pl(40).pr(10).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(c.path)
        .on_click(() => run("space.new", { folder: c.path, machine: r.on }))
        .child(svg(ICON("git-branch")).size(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(c.branch ?? base(c.path)))
        .when(c.at > 0, (e) => e.child(div().flex_none().text_size(11).child(ago(c.at)))));
    }
    return rows;
  }

  repoBlock(r, ps, t, order) {
    const id = `repo-${r.key}`;
    const folded = r.closed ? !this.folded.has(`open:${r.key}`) : this.folded.has(r.key);
    const items = r.items.filter(({ s, g }) => this.matches(r.name) || this.matches(g.branch ?? "") ||
      (s.tabs ?? []).some((x) => this.matches(this.tabInfo(x, ps).label)));
    const idleMatch = r.idle.some((c) => this.matches(c.branch ?? c.path));
    if (this.filter && !items.length && !this.matches(r.name) && !idleMatch) return [];
    const machine = r.on ? h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim).child(svg(ICON("server")).size(11)).child(r.on) : null;
    const count = r.items.length + r.idle.length;
    const head = this.hoverable(id, h_flex().h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => r.closed ? this.toggle(this.folded, "folded", `open:${r.key}`, cx) : this.toggle(this.folded, "folded", r.key, cx))
      .child(svg(ICON("folder")).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(r.closed ? t.muted : t.foreground).child(r.name))
      .when(Boolean(machine), (e) => e.child(machine))
      .when(this.hovered === id, (e) => e
        .child(this.small(`new-wt-${r.key}`, "plus", "New worktree", () => {
          const first = r.items[0];
          openOverlay({ mod: "nix-dispatch", kind: "popup", width: 320, height: 114, props: { space: first?.s.id, folder: first ? place(first.s, ps) : JSON.parse(r.key)[1], machine: r.on } });
        }, t))
        .when(r.closed, (e) => e.child(this.small(`forget-${r.key}`, "x", "Hide from the list", (cx) => this.forget(r.key, cx), t))))
      .when(this.hovered !== id && folded && count > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${count}`)))
      .when(this.hovered !== id && folded && !r.closed && (r.behind > 0 || r.ahead > 0), (e) => e
        .when(r.behind > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`↓${r.behind}`)))
        .when(r.ahead > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`↑${r.ahead}`)))));
    if (folded && !this.filter) return [head];
    if (r.closed && !this.trees[r.key]) this.loadTrees(r.key, null);
    return [head, ...items.flatMap((it) => this.worktreeRow(it, ps, t, order)), ...this.idleRows(r, t)];
  }

  folderRow({ s }, ps, t, order) {
    const name = s.name === "~" ? "Home" : s.name;
    if (this.filter && !this.matches(name) && !(s.tabs ?? []).some((x) => this.matches(this.tabInfo(x, ps).label))) return [];
    const rows = this.worktreeRow({ s, g: null }, ps, t, order);
    // A folder has no repo row above it: its row carries the icon instead of the indent.
    rows[0] = this.hoverable(`space-${s.id}`, h_flex().h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(s.active, (e) => e.bg(t.selected)).when(!s.active, (e) => e.hover((x) => x.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "nix-menu", kind: "popup", width: 210, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(svg(ICON("folder")).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(s.active ? t.foreground : t.muted).child(name))
      .when(this.hovered === `space-${s.id}`, (e) => e.child(this.small(`add-${s.id}`, "plus", "Start Pi or a terminal here",
        () => openOverlay({ mod: "nix-new-menu", kind: "popup", width: 240, height: 140, props: { space: s.id } }), t))));
    return rows.map((r, i) => (i === 0 ? r : r.pl(24)));
  }

  rail(t) {
    // The narrow rail: one mark per space, its status beside it.
    const { open, folders } = this.model();
    const marks = [...open.flatMap((r) => r.items.map((it) => ({ ...it, r }))), ...folders];
    return v_flex().size_full().bg(t.chrome).pt(6).gap(4).items_center()
      .children(marks.map(({ s, r }) => h_flex().id(`rail-${s.id}`).size(30).rounded(6).items_center().justify_center().relative()
        .when(s.active, (e) => e.bg(t.selected)).when(!s.active, (e) => e.hover((x) => x.bg(t.hover)))
        .on_click(() => run("space.select", { id: s.id }))
        .child(div().size(18).rounded(3).bg(s.active ? t.background : t.raised).flex().items_center().justify_center()
          .text_size(10).font_medium().text_color(s.active ? t.foreground : t.muted).child([...(r?.name ?? s.name)][0]?.toUpperCase() ?? "?"))
        .when(s.status === "blocked" || s.status === "done", (e) => e.child(div().absolute().top(4).right(4).size(6).rounded(3).bg(t[s.status])))));
  }

  render() {
    const t = theme();
    if (narrow()) return this.rail(t);
    const { open, closed, folders, ps } = this.model();
    const order = [];
    const info = (s) => this.git[where(s, ps)] ?? null;
    const body = [
      ...open.flatMap((r) => [...this.repoBlock(r, ps, t, order), div().h(6).flex_none()]),
      ...folders.flatMap((f) => [...this.folderRow(f, ps, t, order), div().h(6).flex_none()]),
    ];
    const rest = closed.flatMap((r) => this.repoBlock(r, ps, t, order));
    setAgentOrder(order);
    const remote = machines().filter((m) => m.name && m.layout === "loading");
    return v_flex().size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      // The filter: a raised field without a border at rest, the focus ring while typing.
      .child(h_flex().flex_none().px(10).pb(8).gap(6).items_center()
        .child(h_flex().flex_1().h(28).px(9).gap(7).items_center().rounded(6).bg(t.raised)
          .border_1().border_color(this.typing ? (t.ring ?? t.accent) : t.raised)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("open-folder").size(28).flex_none().rounded(6).flex().items_center().justify_center().text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip("Open a folder or repo")
          .on_click((_e, cx) => cx.spawn(async () => {
            const folder = await pickFolder({ prompt: "Open" });
            if (folder) run("space.new", { folder });
          }))
          .child(svg(ICON("folder-plus")).size(14))))
      .child(v_flex().id("sidebar-tree").flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .when(Boolean(this.needsYou(t, ps, info)), (e) => e.child(this.needsYou(t, ps, info)))
        .child(v_flex().children(body))
        .when(rest.length > 0, (e) => e.child(v_flex().pt(6).mt(4).border_t(1).border_color(t.border).children(rest)))
        .when(remote.length > 0, (e) => e.child(div().px(16).py(6).text_size(11).text_color(t.dim).child(`Loading ${remote.map((m) => m.name).join(", ")}…`)))
        .when(!body.length && !rest.length, (e) => e.child(div().px(16).py(10).text_size(12).text_color(t.dim)
          .child(this.filter ? "Nothing matches." : "Open a folder to start."))));
  }
}
