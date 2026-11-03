// The status bar, and the one always-shown mod, so it also runs the keys bound
// to `nix-status.<command>` (a key reaches shown copies only):
//   jump      the agent that needs you (blocked, then done), most recent first
//   back      where jump came from
//   dispatch  new worktree: a branch, then Pi or a terminal in it
//   worktree  the worktree dialog (new), worktrees (open)
//   review    the diff of the focused checkout, in the middle
//   editor    the focused checkout in Zed, else $VISUAL's GUI editor, else a Neovim tab
// Left: machine, branch, then the agents that matter (need you, done, working). Right: key hints.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, nextCommand, openOverlay, exec, shared, setShared } from "herdr";

const RANK = { blocked: 2, done: 1 };
const ICON = (n) => `mods/nix-head/icons/${n}.svg`;

// The focused checkout: the focused pane's folder, else a terminal of the tab, else the space's.
function place() {
  const space = spaces().find((s) => s.active), f = focused(), ps = panes();
  const own = (p) => p.terminal && p.cwd;
  const pane = (f?.pane ? ps.find((p) => p.pane === f.pane && own(p)) : null) ?? ps.find((p) => p.tab === f?.tab && own(p));
  return { space, cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}

export default class Status extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        try { await this.command(command, cx); } catch {}
        cx.notify();
      }
    });
  }

  async command(c) {
    const { space, cwd, on } = place();
    if (c === "jump") {
      const list = agents().filter((a) => RANK[a.status]).sort((a, b) => RANK[b.status] - RANK[a.status] || b.seq - a.seq);
      const target = list.find((a) => !a.focused) ?? list[0];
      if (!target) return;
      const f = focused();
      if (f?.pane) setShared("nix.jumpBack", f.pane);
      run("agent.focus", { terminal: target.address });
    } else if (c === "back") {
      const pane = shared("nix.jumpBack");
      if (pane && panes().some((p) => p.pane === pane)) run("pane.focus", { pane });
    } else if (c === "dispatch") {
      // A popup from + elsewhere; from a key the pointer could be anywhere, so centered here.
      openOverlay({ mod: "nix-new", kind: "dialog", width: 360, height: 404, props: { space: space?.id, folder: cwd, machine: on } });
    } else if (c === "worktree" || c === "worktrees") {
      openOverlay({ mod: "nix-worktree", kind: "dialog", ...(c === "worktrees" ? { width: 560, height: 480 } : { width: 480, height: 300 }), props: { space: space?.id, folder: cwd, action: c === "worktrees" ? "open" : "new" } });
    } else if (c === "review") {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (top?.code !== 0) return;
      const root = top.stdout.trim();
      // The diff tab already open for this checkout, else a new one.
      const tab = space?.tabs.find((t) => panes().some((p) => p.tab === t.id && p.mod === "nix-diff" && t.name === "Uncommitted Changes" && shared("nix.diffRoots")?.[t.id] === root));
      if (tab) return run("tab.select", { id: tab.id });
      const before = new Set(space?.tabs.map((t) => t.id));
      run("tab.new", { name: "Uncommitted Changes", mod: "nix-diff", props: { root, on } });
      const added = spaces().find((s) => s.id === space?.id)?.tabs.find((t) => !before.has(t.id));
      if (added) setShared("nix.diffRoots", { ...(shared("nix.diffRoots") ?? {}), [added.id]: root });
    } else if (c === "editor") {
      // A GUI editor when one is installed (here only), else Neovim in a tab, on any machine.
      for (const app of on ? [] : ["zed", "zed-preview", "cursor", "code"]) {
        const r = await exec("sh", ["-lc", `command -v "$1" >/dev/null && "$1" "$2"`, "sh", app, cwd]).catch(() => null);
        if (r?.code === 0) return;
      }
      run("tab.new", { name: cwd.split("/").pop(), folder: cwd, argv: ["sh", "-c", 'nvim .; hc kill "$HC_TERMINAL_ID"'] });
    }
  }

  // The keys as actually bound, not hardcoded ones: [[keys, label]].
  hints() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const show = (action) => {
      const b = keys().find((k) => k.section === "global" && k.action === action);
      const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
      return parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    };
    return [["nix-status.dispatch", "New worktree"], ["nix-status.jump", "Needs you"], ["app.palette", "Commands"]]
      .flatMap(([a, label]) => (show(a) ? [[show(a), label, a]] : []));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const done = list.filter((a) => a.status === "done").length;
    const working = list.filter((a) => a.status === "working").length;
    const label = (icon, text) => h_flex().gap(5).items_center().child(svg(ICON(icon)).size(12).flex_none().text_color(t.dim)).child(text);
    const count = (id, n, word, color) => h_flex().id(id).gap(5).items_center().cursor_pointer().text_color(color ?? t.muted)
      .on_click(() => this.command("jump")).when(Boolean(color), (el) => el.child(div().size(6).flex_none().rounded(3).bg(color))).child(`${n} ${word}`);
    return h_flex().size_full().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("git-branch", space.branch)))
      .when(needs > 0, (el) => el.child(count("agents-need", needs, needs === 1 ? "needs you" : "need you", t.blocked)))
      .when(done > 0, (el) => el.child(count("agents-done", done, "done", t.done)))
      .when(working > 0, (el) => el.child(count("agents-working", working, "working")))
      .child(div().flex_1())
      .child(h_flex().gap(14).items_center().text_color(t.dim).children(this.hints().map(([key, text, action]) =>
        h_flex().id(`hint-${action}`).gap(4).items_center().cursor_pointer().on_click(() => run(action))
          .child(div().font_medium().text_color(t.muted).child(key)).child(text))));
  }
}
