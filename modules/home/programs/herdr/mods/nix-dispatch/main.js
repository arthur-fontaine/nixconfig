// New worktree, a small popover: a branch name, then what to start in it (Pi, or a terminal to
// start anything by hand). The worktree goes where the repo's others are
// (../_lib/repo.js): a branch on origin is tracked, a new one starts from
// origin's default branch. What to do is typed into the agent itself.
// Props: { space?, folder, machine? }.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, exec, home, knownAgents } from "herdr";
import { repoOf, createWorktree, slug } from "../_lib/repo.js";

const git = (on) => async (cwd, args) => {
  const r = await exec("git", args, { cwd, on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

// The path's end is what tells worktrees apart, so a long one loses its start: "…/org/repo/branch".
const fit = (path, max) => {
  const parts = path.split("/");
  while (parts.length > 2 && `…/${parts.join("/")}`.length > max) parts.shift();
  return parts.join("/") === path ? path : `…/${parts.join("/")}`;
};

export default class NewWorktree extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const space = spaces().find((s) => s.id === p.space);
    this.on = p.machine ?? space?.machine ?? null;
    this.folder = p.folder || space?.folder;
    this.repo = undefined; this.agent = null; this.start = localStorage.getItem("start") ?? "agent";
    this.busy = false; this.error = "";
    this.branch = InputState.new({ placeholder: "branch-name" });
    this.branch.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.branch.on("submit", (_e, cx) => this.go(cx));
    this.handle = cx.focus_handle();
    this.branch.focus();
    cx.timer.after(300, () => this.branch.focus());
    // knownAgents asks a login shell, which takes a while: the last answer shows at once,
    // and the two lookups run side by side.
    const saved = `agent:${this.on ?? ""}`;
    try { this.agent = JSON.parse(localStorage.getItem(saved) ?? "null"); } catch {}
    cx.spawn(async (cx) => {
      try {
        const userHome = this.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).stdout.trim() : home();
        this.userHome = userHome;
        this.repo = this.folder ? await repoOf(git(this.on), this.folder, userHome) : null;
      } catch { this.repo = null; }
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

  go(cx) {
    const branch = this.branch.value().trim();
    if (this.busy || !this.repo) return;
    if (!branch) { this.error = "Name the branch."; return cx.notify(); }
    localStorage.setItem("start", this.start);
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { path } = await createWorktree(git(this.on), this.repo, branch);
        const agent = this.start === "agent" ? this.agent : null;
        run("space.new", { folder: path, machine: this.on, ...(agent ? { tab: agent.name, argv: agent.run } : {}) });
        this.close();
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    // Tab switches what starts, without leaving the branch field.
    if (e.key === "tab" && this.agent) { cx.stop_propagation(); this.start = this.start === "agent" ? "terminal" : "agent"; cx.notify(); }
  }

  option(id, on, icon, label, onClick, t) {
    return h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(icon).child(div().text_size(12).text_color(on ? t.foreground : t.muted).child(label));
  }

  render() {
    const t = theme(), r = this.repo;
    const tilde = (p) => (p && this.userHome && p.startsWith(this.userHome) ? `~${p.slice(this.userHome.length)}` : p);
    const name = this.branch.value().trim();
    const a = this.agent;
    const where = r === undefined ? "…"
      : r === null ? `${tilde(this.folder) ?? "This folder"} isn't in a git repository.`
      : fit(`${tilde(r.root)}/${name ? slug(name) : "…"}`, 50);
    return v_flex().id("new-worktree").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(8).gap(8).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().h(30).px(8).gap(7).items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/git-branch.svg").size(13).flex_none().text_color(t.muted))
        .child(Input.new(this.branch).flex_1().h_full().text_size(13)))
      .child(div().px(2).text_size(11).text_color(r === null || this.error ? t.blocked : t.dim).truncate()
        .child(this.error || (this.busy ? "Creating…" : where)))
      .child(h_flex().gap(2).items_center()
        .when(Boolean(a), (e) => e.child(this.option("start-agent", this.start === "agent",
          a?.tint ? svg(a.icon).size(12).text_color(t.foreground) : image(a?.icon ?? "icons/pi.svg").size(12), a?.name ?? "", () => { this.start = "agent"; }, t)))
        .child(this.option("start-terminal", this.start === "terminal", svg("icons/shell.svg").size(12).text_color(t.foreground), "Terminal", () => { this.start = "terminal"; }, t))
        .child(div().flex_1())
        .child(div().pr(2).text_size(11).text_color(t.dim).child(a ? "⇥ ↵" : "↵")));
  }
}
