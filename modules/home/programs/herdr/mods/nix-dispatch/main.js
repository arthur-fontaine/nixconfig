// Dispatch: start a piece of work in one step. A task, the branch it gets
// (from the task's first words, editable), where (a new worktree, or this
// checkout) and which agent. A new worktree goes where the repo's others are
// (../_lib/repo.js); outside git, or for "here", the agent starts in a new tab.
// Props: { space, folder }.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, exec, home, knownAgents } from "herdr";
import { repoOf, createWorktree, slug } from "../_lib/repo.js";

// Agents that take their first message as an argument start with it; the
// others get it through Herdr's `task`, typed once they are ready.
const PROMPT_ARG = new Set(["pi", "claude", "codex", "opencode"]);
const STOP = new Set("a an the to of in on for and or with from into by is are be fix add make".split(" "));

// "Fix the hover state of popovers" -> "fix-hover-state-popovers".
export function branchFor(task) {
  const words = task.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const verb = ["fix", "add", "feat", "refactor", "docs", "chore", "test"].includes(words[0]) ? words[0] : null;
  const rest = words.slice(verb ? 1 : 0).filter((w) => !STOP.has(w)).slice(0, 4);
  return [verb, ...rest].filter(Boolean).join("-").slice(0, 48).replace(/-+$/, "");
}

const git = (on) => async (cwd, args) => {
  const r = await exec("git", args, { cwd, on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

export default class Dispatch extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
    this.on = this.space?.machine ?? null;
    this.folder = p.folder || this.space?.folder;
    this.where = "worktree"; this.agents = []; this.agent = 0; this.repo = undefined;
    this.branchEdited = false; this.busy = false; this.error = "";
    this.task = TextareaState.new({ placeholder: "What should the agent do?", rows: 4 });
    this.task.set_auto_grow(4, 8);
    this.task.on("change", (_e, cx) => {
      if (!this.branchEdited) this.branch.set_value(branchFor(this.task.value()));
      cx.notify();
    });
    this.branch = InputState.new({ placeholder: "branch" });
    this.branch.on("change", (_e, cx) => { this.branchEdited = this.branch.value() !== branchFor(this.task.value()); cx.notify(); });
    this.branch.on("submit", (_e, cx) => this.go(cx));
    this.handle = cx.focus_handle();
    this.task.focus();
    cx.timer.after(300, () => this.task.focus());
    cx.spawn(async (cx) => {
      try {
        const userHome = this.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).stdout.trim() : home();
        this.repo = this.folder ? await repoOf(git(this.on), this.folder, userHome) : null;
      } catch { this.repo = null; }
      if (!this.repo) this.where = "here";
      try {
        const all = await knownAgents({ on: this.on });
        // Installed ones, as Herdr ranks them (most picked first), then a plain shell.
        this.agents = [...all.filter((a) => a.installed), { key: "shell", name: "Shell", run: null, icon: "icons/shell.svg", tint: true }];
        // The agent picked last time, else Herdr's most picked.
        this.agent = Math.max(0, this.agents.findIndex((a) => a.key === localStorage.getItem("agent")));
      } catch { this.agents = [{ key: "shell", name: "Shell", run: null, icon: "icons/shell.svg", tint: true }]; }
      cx.notify();
    });
  }

  close() { if (props()?.overlay) closeOverlay(props().overlay); }

  go(cx) {
    if (this.busy) return;
    const task = this.task.value().trim();
    const branch = this.branch.value().trim();
    const agent = this.agents[this.agent];
    if (!agent) return;
    localStorage.setItem("agent", agent.key);
    if (this.where === "worktree" && !branch) { this.error = "Give the branch a name."; return cx.notify(); }
    const argv = agent.run ? (task && PROMPT_ARG.has(agent.key) ? [...agent.run, task] : agent.run) : undefined;
    const viaHerdr = task && agent.run && !PROMPT_ARG.has(agent.key) ? task : undefined;
    const name = branch || (task ? branchFor(task) : agent.name);
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.where === "worktree") {
          const { path } = await createWorktree(git(this.on), this.repo, branch);
          run("space.new", { folder: path, machine: this.on, tab: name, argv, task: viaHerdr });
        } else {
          run("tab.new", { name, space: this.space?.id, folder: this.folder, argv, task: viaHerdr });
        }
        this.close();
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    // Cmd+Enter starts from anywhere in the dialog; Enter in the task makes a new line.
    if (e.key === "enter" && e.modifiers.platform) { cx.stop_propagation(); return this.go(cx); }
  }

  choice(id, on, label, onClick, t, extra) {
    return h_flex().id(id).h(30).px(10).gap(7).items_center().rounded(7).border_1().cursor_pointer()
      .border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .when(Boolean(extra), (e) => e.child(extra)).child(label);
  }

  render(cx) {
    const t = theme(), r = this.repo;
    const tilde = (p) => (p && home() && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
    const field = (label, child) => v_flex().gap(6).child(div().text_size(11.5).text_color(t.dim).child(label)).child(child);
    const target = this.where === "worktree" && r
      ? `${tilde(r.root)}/${slug(this.branch.value() || "…")}: a branch on origin is tracked, a new one starts from origin's default branch.`
      : `A new tab in ${tilde(this.folder) ?? "this space"}.`;
    return v_flex().id("dispatch").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("New task"))
        .when(Boolean(r), (e) => e.child(div().text_color(t.dim).child(`in ${r.name}`))))
      .child(Textarea.new(this.task).px(10).py(8).rounded(8).border_1().border_color(t.input ?? t.border).bg(t.background))
      .child(h_flex().gap(14).items_start()
        .child(field("Where", h_flex().gap(6)
          .child(this.choice("where-worktree", this.where === "worktree", "New worktree", () => { if (r) this.where = "worktree"; }, t))
          .child(this.choice("where-here", this.where === "here", "Here", () => { this.where = "here"; }, t))))
        .when(this.where === "worktree", (e) => e.child(div().flex_1().child(field("Branch",
          Input.new(this.branch).h(30).px(10).items_center().rounded(7).border_1().border_color(t.input ?? t.border).bg(t.background))))))
      .child(field("Agent", h_flex().gap(6).flex_wrap().children(this.agents.map((a, i) =>
        this.choice(`agent-${a.key}`, i === this.agent, a.name, () => { this.agent = i; }, t,
          a.icon ? (a.tint ? svg(a.icon).size(13).text_color(t.foreground) : image(a.icon).size(13)) : null)))))
      .child(div().text_size(11.5).text_color(t.dim).child(r === undefined ? "Looking at the folder…" : target))
      .when(Boolean(this.error), (e) => e.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("⌘↵ start · esc cancel"))
        .child(div().id("start").h(30).px(14).flex().items_center().rounded(7).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).on_click((_e, cx) => this.go(cx))
          .child(this.busy ? "Starting…" : "Start")));
  }
}
