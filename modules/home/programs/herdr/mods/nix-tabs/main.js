import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

// Pi titles its terminal "π - <session name> - <folder>", or "π - <folder>" before it has one.
function piSession(title) {
  const parts = (title ?? "").split(" - ");
  return parts[0] === "π" && parts.length > 2 ? parts.slice(1, -1).join(" - ") : "";
}

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;

// Pi's program glyph: a π in a small raised tile, as the sidebar draws it.
function piTile(t, on) {
  return div().size(14).flex_none().rounded(3).bg(t.raised).flex().items_center().justify_center()
    .font_family("JetBrains Mono").font_bold().text_size(10).text_color(on ? t.foreground : t.muted).child("π");
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
    this.pressed = null;
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
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(28).flex_none().self_center().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), el => el.tooltip(tip)).on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      // An unnamed tab reads as its agent's session: Pi's "π - <name> - <folder>" title,
      // else Herdr's label. Nothing is renamed, so Herdr's numbering still holds.
      const lead = panes().find(p => p.tab === c.id && p.program?.agent);
      const session = !c.named && lead?.app === "pi" ? piSession(lead.title) : "";
      const name = session || (/^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name);
      // Full height; the active tab takes the terminal's color and covers the bar's bottom
      // hairline, so it joins the pane below it.
      return h_flex().id(`tab-${c.id}`).h(36).px(12).gap(8).rounded_t(6).items_center().flex_none().text_size(13)
        .when(c.active, el => el.bg(t.background).border_l(1).border_t(1).border_r(1).border_color(t.border).text_color(t.foreground))
        .when(!c.active, el => el.text_color(t.muted).hover(s => s.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "nix-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(lead?.app === "pi", el => el.child(piTile(t, c.active)))
        .when(lead?.app !== "pi" && Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).flex_none().text_color(t.dim) : image(program.icon).size(14).flex_none()))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg(ICON("loader")).size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover(s => s.text_color(t.foreground)).tooltip("Close tab").on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg(ICON("x")).size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(8, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 8;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    // Icon toggles; the shown panel's is on.
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return div().id(`panel-${id}`).size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
        .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).tooltip(label).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(ICON(icon)).size(14));
    };
    return h_flex().relative().size_full().min_w(0).px(8).pl(lightsPadding).gap(4).items_stretch().bg(t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      // The bar's bottom hairline, drawn first so the active tab covers it.
      .child(div().absolute().left_0().right_0().bottom(0).h(1).bg(t.border))
      // + right after the last tab, as in a browser; the right group is the panels.
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_stretch().gap(2).overflow_x_scrollbar().children(shown.map(item))
        .child(button("tab-new", svg(ICON("plus")).size(14), (_e, cx) => this.openNew(cx), "New tab")))
      .child(h_flex().flex_none().self_center().gap(2)
        .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "file")))
        .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "git-compare"))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : svg(ICON("minus")).size(14), () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg(ICON("x")).size(14), () => run("window.close"))));
  }
}
