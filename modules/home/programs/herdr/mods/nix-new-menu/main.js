// What + starts, in a space (props.space, else the shown one): Pi, or a plain
// terminal to start anything by hand (Claude Code, Codex…). The agent is Pi
// when it's installed, else the one Herdr ranks first. 1 and 2 pick from the keyboard.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces, knownAgents, run, closeOverlay, props, window, keys } from "herdr";

function shortcut(name) {
  const k = keys().find((b) => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } : { ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+", cmd: "Super+" };
  return k.keys.trim().split("-").map((p, i, all) => (i < all.length - 1 ? names[p] ?? p : p.toUpperCase())).join("");
}

export default class NewMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    // knownAgents asks a login shell, which takes a while: the last answer shows at once.
    const on = this.space()?.machine;
    const saved = `agent:${on ?? ""}`;
    try { this.agent = JSON.parse(localStorage.getItem(saved) ?? "undefined"); } catch { this.agent = undefined; }
    cx.spawn(async (cx) => {
      try {
        const all = (await knownAgents({ on })).filter((a) => a.installed);
        const a = all.find((x) => x.key === "pi") ?? all[0] ?? null;
        this.agent = a && { key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run };
        localStorage.setItem(saved, JSON.stringify(this.agent));
      } catch { this.agent = null; }
      cx.notify();
    });
  }

  space() {
    return spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
  }

  start(argv, name) {
    closeOverlay(props().overlay);
    const space = this.space();
    run("space.select", { id: space?.id });
    run("tab.new", { space: space?.id, ...(argv ? { argv, name } : {}) });
  }

  row(id, icon, label, hint, action, t) {
    return h_flex().id(id).h(28).px(8).gap(8).rounded(6).items_center().flex_none().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => action())
      .child(icon).child(div().flex_1().text_color(t.foreground).child(label))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme(), a = this.agent;
    const pic = a ? (a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14)) : null;
    return v_flex().id("new-menu").track_focus(this.handle).size_full().bg(t.popover).p(4).gap(1).text_size(12.5)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "1" && a) this.start(a.run, a.name);
        else if (e.key === "2" || (e.key === "1" && a === null)) this.start(null);
      })
      .when(Boolean(a), (el) => el.child(this.row("start-agent", pic, a.name, "1", () => this.start(a.run, a.name), t)))
      .when(a === undefined, (el) => el.child(div().h(28).px(8).flex().items_center().text_color(t.dim).child("…")))
      .child(this.row("start-terminal", svg("mods/nix-head/icons/terminal.svg").size(14).text_color(t.muted), "Terminal", a === null ? "1" : shortcut("tab.new") || "2", () => this.start(null), t));
  }
}
