// The sidebar's head and footer (workspace-chrome's two slots), reduced to their controls.
// Head: the macOS traffic lights' inset, then the sidebar toggle. Footer: Settings (with
// the update dot) and Add machine as icon buttons. Props: { footer? }.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 256) : window()?.platform === "macos" ? 76 : 44 });
}

export default class Head extends View {
  button(id, icon, tip, action, size = 28) {
    const t = theme();
    return div().id(id).size(size).flex_none().relative().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .child(svg(ICON(icon)).size(14));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const mac = window()?.platform === "macos";
    if (props()?.footer) {
      const settings = this.button("settings", "settings", "Settings", () => run("app.settings"))
        .when(Boolean(updates().app.ready), (el) => el.child(div().absolute().top(5).right(5).size(6).rounded(3).bg(t.accent)));
      // The rail has room for one button: Add machine stays in the command palette.
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).gap(2).items_center()
        .when(collapsed, (el) => el.justify_center())
        .child(settings)
        .when(!collapsed, (el) => el.child(this.button("machine", "server", "Add machine", () => run("mod.open", { name: "machine-add" }))));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 12).pr(10).items_center()
      .when(mac && !window()?.fullscreen && !collapsed, (el) => el.pl(76))
      .child(div().flex_1())
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && mac), (el) => el.child(this.button("sidebar-toggle", "panel-left", collapsed ? "Show sidebar" : "Hide sidebar", toggleSidebar, 24)));
  }
}
