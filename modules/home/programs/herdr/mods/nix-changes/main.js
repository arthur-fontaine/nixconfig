// Changes, for reviewing what agents did: one list of changed files (a box to stage each
// shows on hover), a one-line commit box, and the branch's history with the session's
// commits marked, which gets the room whenever the list doesn't need it. Diffs open
// in the middle, as a tab (the nix-diff mod): a file jumps to its place in
// "Uncommitted Changes", a commit opens its own diff, shown the same way.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, agents, hc, exec, watchFolder, theme, settings, shared, setShared, run, openOverlay } from "herdr";

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
// A PR's state is asked at most this often per branch (gh/glab are slow and rate-limited).
const PR_TTL = 120000;

// GitHub's checks as one word: "fail", "pending", "pass", or null when there are none.
function checksOf(rollup) {
  if (!rollup?.length) return null;
  const bad = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  if (rollup.some((c) => bad.has(c.conclusion) || bad.has(c.state))) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "pass";
}
const PIPELINE = { success: "pass", failed: "fail", canceled: "fail", running: "pending", pending: "pending", created: "pending" };
const ICON = (name) => `mods/nix-head/icons/${name}.svg`;

function ago(s) {
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.commits = []; this.branch = null; this.started = {}; this.tabs = {};
    this.prs = {}; // root\0branch -> { at, pr: {...} | null, tool }
    this.message = ""; this.handle = cx.focus_handle(); this.focusN = 0;
    this.shown = null; this.hovered = null;
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
        const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
        this.mainCheckout = common.code === 0 && common.stdout.trim() === `${this.root}/.git` ? this.root : null;
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
        this.loadPr(context, cx);
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

  // The PR (GitHub, through gh) or MR (GitLab, through glab) of this branch.
  // Nothing for the default branch, a detached HEAD, other hosts, or without the tool.
  loadPr(context, cx, force = false) {
    const b = this.branch, root = this.root, on = this.on;
    if (!b?.name || b.name === "(detached)" || !root) return;
    const id = `${root}\0${b.name}`, known = this.prs[id];
    if (!force && known && Date.now() - known.at < PR_TTL) return;
    this.prs[id] = { ...(known ?? { pr: null, tool: null }), at: Date.now() };
    cx.spawn(async (cx) => {
      const run = (cmd, args) => exec(cmd, args, { cwd: root, on }).catch(() => null);
      const remote = await run("git", ["remote", "get-url", "origin"]);
      const url = remote?.code === 0 ? remote.stdout.trim() : "";
      const head = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      if (head?.code === 0 && head.stdout.trim().replace(/^origin\//, "") === b.name) return;
      let pr = null, tool = null;
      if (/github\.com[:/]/.test(url)) {
        tool = "gh";
        const r = await run("gh", ["pr", "view", b.name, "--json", "number,title,state,isDraft,url,reviewDecision,statusCheckRollup"]);
        if (r?.code === 0) {
          const d = JSON.parse(r.stdout);
          pr = { number: d.number, title: d.title, state: d.state.toLowerCase(), draft: d.isDraft, url: d.url, checks: checksOf(d.statusCheckRollup), review: d.reviewDecision || null };
        } else if (!/no pull requests found/i.test(r?.stderr ?? "")) tool = null; // not installed or not logged in
      } else if (/gitlab/.test(url)) {
        tool = "glab";
        const r = await run("glab", ["mr", "view", b.name, "-F", "json"]);
        if (r?.code === 0) {
          const d = JSON.parse(r.stdout);
          pr = { number: d.iid, title: d.title, state: d.state === "opened" ? "open" : d.state, draft: d.draft, url: d.web_url, checks: PIPELINE[d.head_pipeline?.status] ?? null, review: null };
        } else if (!/no open merge request|not found/i.test(r?.stderr ?? "")) tool = null;
      }
      this.prs[id] = { at: Date.now(), pr, tool };
      if (key() === context) cx.notify();
    });
  }

  // Push the branch (setting its upstream), then ask about its PR again.
  push(cx) {
    this.act(["push", "-u", "origin", "HEAD"], cx);
    cx.spawn(async (cx) => { await new Promise((r) => cx.timer.after(4000, r)); this.loadPr(this.context, cx, true); });
  }

  createPr(tool, cx) {
    const args = tool === "gh" ? ["pr", "create", "--fill", "--web"] : ["mr", "create", "--fill", "--web"];
    exec(tool, args, { cwd: this.root, on: this.on }).catch(() => null);
  }

  // A merged branch's worktree can go: the worktree dialog, branch deletion checked.
  reap() {
    const space = spaces().find((s) => s.active);
    openOverlay({ mod: "nix-worktree", kind: "dialog", width: 480, height: 300, props: { space: space?.id, folder: this.root, machine: this.on, action: "remove" } });
  }

  prSection(t) {
    const b = this.branch;
    const entry = b?.name && this.root ? this.prs[`${this.root}\0${b.name}`] : null;
    if (!entry?.tool) return null;
    const pr = entry.pr, word = entry.tool === "gh" ? "PR" : "MR";
    const button = (id, label, onClick) => div().id(id).h(26).px(8).flex().items_center().flex_none().rounded(6).text_size(12).font_medium()
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground)).active((s) => s.bg(t.selected)).on_click(onClick).child(label);
    const row = h_flex().h(32).flex_none().px(12).gap(8).items_center().text_size(12).border_t(1).border_color(t.border);
    if (!pr) {
      return row.child(div().text_size(11).text_color(t.dim).child(b.upstream ? `No ${word} yet` : "Not pushed yet")).child(div().flex_1())
        .when(!b.upstream || b.ahead > 0, (e) => e.child(button("push", b.upstream ? `Push ↑${b.ahead}` : "Push", (_e, cx) => this.push(cx))))
        .when(Boolean(b.upstream), (e) => e.child(button("create-pr", `Create ${word}`, (_e, cx) => this.createPr(entry.tool, cx))));
    }
    const state = pr.state === "merged" ? ["Merged", t.ansi5] : pr.state === "closed" ? ["Closed", t.ansi1] : pr.draft ? ["Draft", t.dim] : ["Open", t.ansi2];
    const checks = { pass: ["✓", t.ansi2], fail: ["✗", t.ansi1], pending: ["●", t.ansi3] }[pr.checks];
    const review = pr.review === "APPROVED" ? ["approved", t.ansi2] : pr.review === "CHANGES_REQUESTED" ? ["changes requested", t.ansi1] : null;
    return row
      .child(div().flex_none().text_size(11).font_medium().text_color(state[1]).child(state[0]))
      .child(div().id("pr-open").min_w(0).flex_1().truncate().cursor_pointer().text_color(t.foreground).hover((s) => s.text_color(t.accent).underline()).active((s) => s.opacity(0.7))
        .on_click(() => exec("open", [pr.url]).catch(() => null)).child(`#${pr.number} ${pr.title}`))
      .when(Boolean(checks), (e) => e.child(div().flex_none().text_color(checks[1]).child(checks[0])))
      .when(Boolean(review), (e) => e.child(div().flex_none().text_size(11).text_color(review[1]).child(review[0])))
      .when(pr.state === "open" && b.ahead > 0, (e) => e.child(button("push", `Push ↑${b.ahead}`, (_e, cx) => this.push(cx))))
      .when(pr.state === "merged" && this.root !== this.mainCheckout, (e) => e.child(button("reap", "Remove worktree…", () => this.reap())));
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
    this.shown = path;
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

  // 14px, the input border at rest; staged: solid with a check; partly staged: a solid square.
  checkbox(state, t, onClick, id) {
    return div().id(id).size(14).flex_none().rounded(3).border_1().cursor_pointer()
      .border_color(state === "all" ? t.solid : t.input ?? t.border).when(state === "all", (e) => e.bg(t.solid))
      .when(state !== "all", (e) => e.hover((x) => x.border_color(t.muted)).active((x) => x.bg(t.hover)))
      .flex().items_center().justify_center()
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(state === "all", (e) => e.child(svg(ICON("check")).size(10).text_color(t.solid_foreground ?? t.background)))
      .when(state === "some", (e) => e.child(div().size(6).rounded(1).bg(t.solid)));
  }

  statusIcon(status, t) {
    const color = { A: t.ansi2, D: t.ansi1, R: t.ansi4, U: t.ansi5 }[status] ?? t.ansi3;
    return div().w(10).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).font_medium()
      .text_color(color).text_center().child(status);
  }

  fileRow(f, t) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash >= 0 ? f.path.slice(0, slash) : "", name = f.path.slice(slash + 1);
    const id = `change-${f.path}`, on = this.shown === f.path;
    // The box's column is kept at rest, so nothing shifts when it shows.
    const box = this.hovered === id || f.staged !== "none";
    return h_flex().id(id).h(26).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .on_hover((hovered, cx) => {
        const next = hovered ? id : this.hovered === id ? null : this.hovered;
        if (next !== this.hovered) { this.hovered = next; cx.notify(); }
      })
      .on_click((_e, cx) => this.showFile(f.path, cx))
      .child(box ? this.checkbox(f.staged, t, (cx) => this.toggleStage(f, cx), `stage-${f.path}`) : div().size(14).flex_none())
      .child(this.statusIcon(f.status, t))
      .child(h_flex().flex_1().min_w(0).gap(5).items_baseline()
        .child(div().flex_none().max_w(180).truncate().text_color(f.status === "D" ? t.muted : t.foreground).when(f.status === "D", (e) => e.line_through()).child(name))
        .child(div().flex_1().min_w(0).text_ellipsis_start().text_size(11).text_color(t.dim).child(dir)))
      .child(h_flex().flex_none().gap(4).text_size(11)
        .child(div().w(34).text_right().text_color(t.ansi2).child(f.add > 0 ? `+${f.add}` : ""))
        .child(div().w(34).text_right().text_color(t.ansi1).child(f.del > 0 ? `−${f.del}` : "")));
  }

  commitRow(c, t) {
    return h_flex().id(`commit-${c.sha}`).h(26).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => this.openDiff(c.sha, c.subject.length > 32 ? `${c.subject.slice(0, 31)}…` : c.subject, cx))
      // Only this session's commits are marked.
      .child(div().w(8).flex_none().flex().justify_center().when(Boolean(c.session), (e) => e.child(div().size(5).rounded(3).bg(t.accent))))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.time)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    // One list: conflicts first, then by path (untracked files read as A).
    const files = [...this.files].sort((a, b) => (a.status === "U") !== (b.status === "U") ? (a.status === "U" ? -1 : 1) : a.path.localeCompare(b.path));
    const allStaged = files.length > 0 && files.every((f) => f.staged === "all");
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && files.length);
    const mine = this.commits.filter((c) => c.session).length;
    const b = this.branch;
    const n = files.length;
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0);
    // The list takes what its rows need, at most half the panel; History has the rest.
    // Capped at half the panel, rounded down to whole rows so none is cut in half.
    const cap = Math.max(120, (this.height ?? 600) / 2);
    const listH = Math.min(n * 26 + 8, 8 + 26 * Math.floor((cap - 8) / 26));
    const textButton = (id, label, onClick) => div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(12).font_medium()
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).on_click(onClick).child(label);
    const empty = this.error || (this.loading && !this.root ? "Loading changes…" : this.root ? "Nothing to commit" : "No folder");
    return v_flex().id("changes").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (size.height !== this.height) { this.height = size.height; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      // Header: "Changes", the totals, the whole diff; Stage all on hover.
      .child(h_flex().id("changes-head").h(36).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .on_hover((hovered, cx) => { if (hovered !== this.headHover) { this.headHover = hovered; cx.notify(); } })
        .child(div().flex_none().font_medium().child("Changes"))
        .child(div().ml(6).min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(this.root === null && !this.loading ? "Not a git repository" : n ? `${n} · +${add} −${del}` : ""))
        .child(div().flex_1())
        .when(Boolean(this.headHover && n > 0), (e) => e.child(textButton("stage-all", allStaged ? "Unstage all" : "Stage all", (_e, cx) => this.stageAll(cx))))
        .when(n > 0, (e) => e.child(textButton("open-diff", "View diff", (_e, cx) => this.openDiff(null, "Uncommitted Changes", cx)))))
      // The files, or one line when there are none.
      .when(n > 0, (e) => e.child(v_flex().id("changes-list").flex_none().h(listH).overflow_y_scrollbar().px(6).py(4)
        .children(files.map((f) => this.fileRow(f, t)))))
      .when(!n, (e) => e.child(h_flex().h(36).flex_none().px(12).items_center().text_size(12).text_color(t.dim).child(empty)))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.ansi1).child(this.note)))
      // A one-line commit box and Commit, while there is something to commit.
      .when(n > 0, (e) => e.child(h_flex().flex_none().border_t(1).border_color(t.border).px(12).py(8).gap(8).items_center()
        .child(div().id("commit-message").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(6).bg(t.background).border_1()
          .border_color(this.typing ? t.ring ?? t.accent : t.border).cursor_text().text_size(12.5)
          .when(!this.typing, (e) => e.hover((x) => x.border_color(t.input ?? t.muted)))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.input.focus())
          .child(Input.new(this.input).w_full().text_size(12.5).text_color(t.foreground)))
        .child(div().id("commit").h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(12).font_medium()
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .when(enabled, (e) => e.cursor_pointer().hover((x) => x.opacity(0.88)).active((x) => x.opacity(0.75)))
          .tooltip(files.some((f) => f.staged !== "none") ? "Commits the staged changes" : "Commits every change")
          .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))))
      // The branch's PR or MR.
      .when(Boolean(this.prSection(t)), (e) => e.child(this.prSection(t)))
      // History: this session's commits marked; the branch and its upstream in its header.
      .child(v_flex().flex_1().min_h(0).border_t(1).border_color(t.border).px(6).pt(4).pb(6)
        .when(this.commits.length > 0 || Boolean(b?.name), (e) => e.child(h_flex().h(28).flex_none().px(6).gap(8).items_center()
          .child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child("History"))
          .when(mine > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${mine} this session`)))
          .child(div().flex_1())
          .when(Boolean(b?.name), (e) => e.child(h_flex().min_w(0).gap(5).items_center().text_size(11).text_color(t.dim)
            .child(svg(ICON("git-branch")).size(12).flex_none())
            .child(div().min_w(0).truncate().child(b.name))
            .when(b.ahead > 0, (e) => e.child(div().flex_none().child(`↑${b.ahead}`)))
            .when(b.behind > 0, (e) => e.child(div().flex_none().child(`↓${b.behind}`)))))))
        .child(v_flex().id("changes-commits").flex_1().min_h(0).overflow_y_scrollbar()
          .children(this.commits.map((c) => this.commitRow(c, t)))));
  }
}
