import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, props } from "herdr";
import { tabLabel, tabLabelIsPath, tabSlot, tabMoveIndex, tabWheel } from "../_lib/tabs.js";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;
// Pi's mark as Herdr's program table has it, for when the pane's program isn't at hand.
const PI = { icon: "icons/pi.svg", tint: true };

// Pi's program mark, as Herdr draws it for any agent: its icon, tinted for a one-color glyph.
function piMark(t, program, on) {
  const p = program?.icon ? program : PI;
  return p.tint ? svg(p.icon).size(14).flex_none().text_color(on ? t.foreground : t.muted) : image(p.icon).size(14).flex_none();
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null; // the tab pressed: { id, moved }
    this.hovered = null;
    this.slot = null; // while dragging: the gap it would land in, 0..n
    this.ghostX = null; // while dragging: the pointer's x in the bar, where the ghost tab is drawn
    this.scroll = ScrollHandle.new(); // the strip, stepped a tab at a time by a vertical wheel
    this.wheel = { acc: 0, index: 0 };
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The + popover (nix-new) for the shown space's project, under the pointer and inside the window.
  openNew(cx) {
    const height = 404;
    let at = "pointer";
    try {
      const m = cx.mouse_position(), v = cx.viewport_size();
      at = { x: Math.max(8, Math.min(m.x - 8, v.width - 360 - 12)), y: Math.max(8, Math.min(m.y + 12, v.height - height - 8)) };
    } catch {}
    openOverlay({ mod: "nix-new", kind: "popup", width: 360, height, at, props: { space: spaces().find((s) => s.active)?.id, level: 2 } });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    // The tab look, from the layout's block props (the islands variants); none: today's folder tab.
    //   handle  the bar sits on the well and the active tab grows out of the panes' island
    const style = props()?.style ?? null;
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(28).flex_none().self_center().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected))
      .when(Boolean(tip), el => el.tooltip(tip)).on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      // Named as in the sidebar (_lib/tabs.js): its agent's session, a mod's title, the program
      // running, else the folder in the worktree. Nothing is renamed, Herdr's numbering holds.
      const own = panes().filter(p => p.tab === c.id);
      const lead = own.find(p => p.program?.agent) ?? own.find(p => p.focused) ?? own[0];
      const named = { named: c.named, name: c.name, lead, folder: space.folder };
      const name = tabLabel(named), path = tabLabelIsPath(named);
      const dragging = this.pressed?.moved && this.pressed.id === c.id;
      const shownClose = c.active || this.hovered === c.id;
      const line = (side) => div().absolute().top(6).bottom(6).w(2).rounded(1).bg(t.foreground).when(side === "left", el => el.left(-3)).when(side === "right", el => el.right(-3));
      // Full height; the active tab takes the terminal's color and covers the bar's bottom
      // hairline, so it joins the pane below it.
      const body = h_flex().id(`tab-${c.id}`).relative().px(12).gap(8).items_center().flex_none().text_size(13)
        .when(dragging, el => el.opacity(0.45))
        .on_hover((on, cx) => { const next = on ? c.id : this.hovered === c.id ? null : this.hovered; if (next !== this.hovered) { this.hovered = next; cx.notify(); } })
        .h(36).rounded_t(style === "handle" ? 10 : 6)
        .when(c.active && !style, el => el.bg(t.background).border_l(1).border_t(1).border_r(1).border_color(t.border).text_color(t.foreground))
        // Capped in a neutral line (no accent): it keeps the handle clear on a dark well.
        .when(c.active && style === "handle", el => el.bg(t.background).border_t(2).border_color(t.input).text_color(t.foreground).font_medium())
        .when(!c.active, el => el.text_color(t.muted).hover(s => s.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = { id: c.id, moved: false }; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        // Dragging: the pressed tab fades, a line shows the gap it lands in (the pointer's side).
        .on_mouse_move((e, cx) => {
          if (!this.pressed) return;
          const slot = tabSlot(i, e.local_position.x, e.bounds.width);
          if (!this.pressed.moved && this.pressed.id === c.id && slot >= i && slot <= i + 1) return;
          if (slot !== this.slot || !this.pressed.moved) { this.pressed.moved = true; this.slot = slot; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const p = this.pressed, slot = this.slot;
          this.pressed = null; this.slot = null; this.ghostX = null;
          if (!p?.moved) { run("tab.select", { id: c.id }); return; }
          const index = tabMoveIndex(space.tabs.map(x => x.id), shown.map(x => x.id), p.id, slot);
          if (index) run("tab.move", { id: p.id, index });
          cx.notify();
        })
        // A middle click closes, as in a browser.
        .on_mouse_up("middle", (_e, cx) => { cx.stop_propagation(); run(`nix-status.close-tab:${c.id}`); })
        .when(this.pressed?.moved && this.slot === i, el => el.child(line("left")))
        .when(this.pressed?.moved && this.slot === i + 1 && i === shown.length - 1, el => el.child(line("right")))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "nix-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(lead?.app === "pi", el => el.child(piMark(t, lead?.program, c.active)))
        .when(lead?.app !== "pi" && Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).flex_none().text_color(t.dim) : image(program.icon).size(14).flex_none()))
        // A folder keeps its end (what tells two tabs apart); a name or session, its start.
        .child(div().max_w(170).when(path, el => el.text_ellipsis_start()).when(!path, el => el.truncate()).child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg(ICON("loader")).size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        // × on every tab, shown on hover (always on the active one); its room is kept so a
        // hover never shifts the tabs.
        .child(div().id(`close-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .when(!shownClose, el => el.invisible())
          .hover(s => s.bg(t.input + "80").text_color(t.foreground)).active(s => s.bg(t.input + "b3")).tooltip("Close tab").on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run(`nix-status.close-tab:${c.id}`); }).child(svg(ICON("x")).size(12)));
      if (style !== "handle") return body;
      // The handle grows out of the panes' island: inverse-radius fillets where it meets the
      // island's top (the well's color, rounded on the tab's side, over the island's). Every tab
      // keeps their room, so a tab doesn't move when it becomes the shown one.
      const fillet = (side) => div().w(10).h(10).flex_none()
        .when(c.active && Boolean(t.well), el => el.bg(t.background).child(div().size(10).bg(t.well)
          .when(side === "left", e => e.rounded_br(10)).when(side === "right", e => e.rounded_bl(10))));
      return h_flex().id(`tabw-${c.id}`).flex_none().h_full().items_end().child(fillet("left")).child(body).child(fillet("right"));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(8, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 8;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes", "info"];
    this.syncPanel(space, panel, body, enabled);
    // Icon toggles; the shown panel's is on.
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return div().id(`panel-${id}`).size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .when(on, s => s.bg(t.selected)).when(!on && !style, s => s.bg(t.chrome)).text_color(on ? t.foreground : t.dim)
        .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).active(s => s.bg(on ? t.input + "80" : t.selected)).tooltip(label).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(ICON(icon)).size(14));
    };
    const ghost = this.pressed?.moved && this.ghostX !== null ? shown.find(x => x.id === this.pressed.id) : null;
    return h_flex().id("tab-bar").relative().size_full().min_w(0).px(8).pl(style === "handle" ? Math.max(lightsPadding, 14) : lightsPadding).gap(4).items_stretch().when(style !== "handle", el => el.bg(t.chrome))
      // Released off the tabs: the drag is dropped. The wheel scrolls the strip (no tab switch).
      .on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = null; this.slot = null; this.ghostX = null; cx.notify(); } })
      // Released outside the window's bar: no release reaches it, so leaving it ends the drag.
      .on_hover((on, cx) => { if (!on && this.pressed) { this.pressed = null; this.slot = null; this.ghostX = null; cx.notify(); } })
      // The dragged tab follows the pointer (only over the bar: moves reach it only there).
      .on_mouse_move((e, cx) => { if (this.pressed?.moved) { this.ghostX = e.local_position.x; cx.notify(); } })
      // A vertical wheel steps the strip a tab at a time (Herdr's scroller takes horizontal swipes
      // itself, and can only be moved to a child): coarse, by design of the API.
      .on_scroll_wheel(e => {
        const next = tabWheel(this.wheel, e.delta.y, e.delta.x, shown.length);
        this.wheel = { acc: next.acc, index: next.index };
        if (next.step) this.scroll.scroll_to_item(next.index);
      })
      // The bar's bottom hairline, drawn first so the active tab covers it.
      .when(!style, el => el.child(div().absolute().left_0().right_0().bottom(0).h(1).bg(t.border)))
      // The ghost: no id and no handlers, so the release still reaches the tabs under it.
      .when(Boolean(ghost), el => el.child(div().absolute().top(6).h(24).left(Math.max(0, this.ghostX - 60)).px(12).flex().items_center()
        .rounded(8).bg(t.popover).border_1().border_color(t.input).shadow_md().text_size(13).text_color(t.foreground).opacity(0.92)
        .child(tabLabel({ named: ghost.named, name: ghost.name, lead: (() => { const own = panes().filter(p => p.tab === ghost.id); return own.find(p => p.program?.agent) ?? own.find(p => p.focused) ?? own[0]; })(), folder: space?.folder }))))
      // + right after the last tab, as in a browser; the right group is the panels.
      // Handle style: tabs touch (their fillets), and no scrollbar is painted over the junction.
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_stretch().gap(style === "handle" ? 0 : 2)
        .when(style === "handle", el => el.overflow_x_scroll()).when(style !== "handle", el => el.overflow_x_scrollbar()).track_scroll(this.scroll).children(shown.map(item))
        .child(button("tab-new", svg(ICON("plus")).size(14), (_e, cx) => this.openNew(cx), "New tab")))
      .child(h_flex().flex_none().self_center().gap(2)
        .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "file")))
        .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "git-compare")))
        .when(enabled.includes("info"), el => el.child(panelButton("info", "Info", "info")))
        .when(enabled.includes("games"), el => el.child(panelButton("games", "Games", "gamepad"))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : svg(ICON("minus")).size(14), () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg(ICON("x")).size(14), () => run("window.close"))));
  }
}
