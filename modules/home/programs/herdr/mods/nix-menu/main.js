// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "project" | "global", target }. A project's target is
// the sidebar's repo: { key, spaces (its worktrees' open spaces), project (its orchestrator's
// space, or null), newProps (nix-new's, for its +) }. Every close goes through nix-status,
// which asks only when something would be lost.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, setShared, home } from "herdr";
import { wtOrchestrator } from "../_lib/worktree.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null; and its top folder.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return { kind: common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked", top: top.stdout.trim() };
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", `nix-status.close-pane:${tg.pane}`, {}],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", `nix-status.close-tab:${tg.id}`, {}],
      ];
    case "project":
      return [
        ["New worktree", "worktree", { action: "new-project", props: tg.newProps }],
        // The project's orchestrator stays unless asked: the kanban dispatches to it.
        ...(tg.spaces?.length ? [["Close worktrees", "project.close", { spaces: tg.spaces }]] : []),
        ...(tg.project ? [["Close worktrees and project chat", "project.close", { spaces: [...(tg.spaces ?? []), tg.project] }]] : []),
        ...(!tg.spaces?.length && !tg.project ? [["Hide from the list", "project.forget", { key: tg.key }]] : []),
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["Orchestrator", "orchestrator", { space: tg.id, top: git.top }]] : []),
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git?.kind === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", `nix-status.close-space:${tg.id}`, {}],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

const isClose = (command) => command.endsWith(".close") || command.includes(".close-");

function menuIcon(command) {
  const name = command === "orchestrator" ? "radio" : command.endsWith(".close") || command.includes(".close-") ? "x" : command === "project.forget" ? "minus" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "split-right" : command === "pane.zoom" ? "zoom" : "terminal";
  return `mods/nix-head/icons/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    // Closing a project's worktrees is one close (one question at most); hiding it from the
    // list is its own item, offered only when nothing of it is open.
    if (it[1] === "project.close") return run(`nix-status.close-spaces:${it[2].spaces.join(",")}`);
    if (it[1] === "project.forget") {
      setShared("nix-sidebar.forget", { key: it[2].key, n: Date.now() });
      return;
    }
    // The worktree's orchestrator: the one in the space, else a new one named after its folder.
    if (it[1] === "orchestrator") {
      const space = spaces().find((s) => s.id === it[2].space) ?? null;
      const top = it[2].top;
      for (const [name, args] of wtOrchestrator({ space, label: top.replace(/\/+$/, "").split("/").pop(), folder: top, home: home(), machine: space?.machine ?? null })) run(name, args);
      return;
    }
    if (it[1] === "worktree" && it[2].action === "new-project") return openOverlay({ mod: "nix-new", kind: "dialog", width: 360, height: 404, props: it[2].props });
    if (it[1] === "worktree" && it[2].action === "new") openOverlay({ mod: "nix-new", kind: "dialog", width: 360, height: 404, props: { space: it[2].space } });
    else if (it[1] === "worktree") openOverlay({ mod: "nix-worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 480, height: 300 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (isClose(it[1]) || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(8).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(28)
            .px(8)
            .gap(8)
            .rounded(6)
            .items_center()
            .justify_between()
            // Closing is the one destructive item: it says so in the needs-you red.
            .text_color(isClose(it[1]) ? t.blocked : t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(isClose(it[1]) ? t.blocked : t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
