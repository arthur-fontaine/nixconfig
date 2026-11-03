// The status bar, and the one always-shown mod, so it also runs the keys bound
// to `nix-status.<command>` (a key reaches shown copies only):
//   jump      the agent that needs you (blocked, then done), most recent first
//   back      where jump came from
//   dispatch  new worktree: a branch, then Pi or a terminal in it
//   worktree  the worktree dialog (new), worktrees (open)
//   review    the diff of the focused checkout, in the middle
//   editor    the focused checkout in Zed, else $VISUAL's GUI editor, else a Neovim tab
// Left: machine, branch, agents (needs you in red). Right: the focused repo and the palette hint.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, nextCommand, openOverlay, exec, shared, setShared } from "herdr";

const RANK = { blocked: 2, done: 1 };

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
      openOverlay({ mod: "nix-dispatch", kind: "dialog", width: 320, height: 114, props: { space: space?.id, folder: cwd, machine: on } });
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

  // The palette key as actually bound, not a hardcoded one.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const show = (action) => {
      const b = keys().find((k) => k.section === "global" && k.action === action);
      const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
      return parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    };
    return [["nix-status.dispatch", "new worktree"], ["nix-status.jump", "needs you"], ["app.palette", "commands"]]
      .map(([a, label]) => (show(a) ? `${show(a)} ${label}` : null)).filter(Boolean).join("   ");
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const done = list.filter((a) => a.status === "done").length;
    const working = list.filter((a) => a.status === "working").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(8).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().id("agents-count").gap(6).items_center().cursor_pointer().on_click(() => this.command("jump"))
        .child(div().size(6).rounded(3).bg(needs ? t.blocked : working ? t.working : t.dim))
        .child(`${list.length} agents`)
        .when(working > 0, (el) => el.child(div().child(`· ${working} working`)))
        .when(needs > 0, (el) => el.child(div().child(`· ${needs} needs you`)))
        .when(done > 0, (el) => el.child(div().child(`· ${done} done`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint()));
  }
}
