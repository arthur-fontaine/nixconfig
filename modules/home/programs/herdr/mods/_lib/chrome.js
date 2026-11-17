// The side panels' chrome (Changes, Files, Info), from nix-changes and nix-files: a 36 px header
// (12 px in, title 13 medium, meta 11 dim, a 20 px back chevron), a list inset 6 × 4, 26 px rows
// rounded 6 with a hover fill, 28 px section headers. `ui` is the gpui builders the mod imports
// ({ div, h_flex, svg }): nix joins this file into each mod's main.js without its imports.

export const CHROME = { header: 36, headerX: 12, back: 20, insetX: 6, insetY: 4, row: 26, rowX: 6, radius: 6, section: 28, text: 13, rowText: 12.5, meta: 11 };
const CHROME_ICON = (name) => `mods/nix-head/icons/${name}.svg`;

// The header: [back] title meta … actions. `back`: a click handler, or null.
export function chromeHeader(ui, t, { id, title, meta = null, back = null, actions = [] }) {
  const { div, h_flex, svg } = ui;
  return h_flex().id(id).h(CHROME.header).flex_none().px(CHROME.headerX).gap(4).items_center().border_b(1).border_color(t.border)
    .when(Boolean(back), (e) => e.child(div().id(`${id}-back`).size(CHROME.back).flex_none().flex().items_center().justify_center().rounded(CHROME.radius).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).tooltip("Back (Esc)")
      .on_click((_e, cx) => back(cx)).child(svg(CHROME_ICON("chevron-left")).size(12))))
    .child(div().flex_none().font_medium().child(title))
    .when(Boolean(meta), (e) => e.child(div().ml(6).flex_1().min_w(0).truncate().text_size(CHROME.meta).text_color(t.dim).child(meta)))
    .when(!meta, (e) => e.child(div().flex_1()))
    .children(actions);
}

// A header's text action ("View diff", "Show all 211"), as Changes draws its own.
export function chromeTextButton(ui, t, id, label, onClick, tip = null) {
  return ui.div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(CHROME.radius).text_size(12).font_medium()
    .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
    .when(Boolean(tip), (e) => e.tooltip(tip)).on_click(onClick).child(label);
}

// A list row's frame: 26 px, rounded, the selected fill when `on`, else a hover fill when it does
// something (`onClick`). Children are the caller's.
// `clickable`: the look without the handler, for a virtual list's rows (its on_item_click acts).
export function chromeRow(ui, t, id, { on = false, onClick = null, clickable = Boolean(onClick) } = {}) {
  return ui.h_flex().id(id).h(CHROME.row).flex_none().px(CHROME.rowX).gap(8).items_center().rounded(CHROME.radius).text_size(CHROME.rowText)
    .when(on, (e) => e.bg(t.selected))
    .when(!on && clickable, (e) => e.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
    .when(clickable, (e) => e.cursor_pointer())
    .when(Boolean(onClick), (e) => e.on_click(onClick));
}

// A section header: label 12 medium muted, meta 12 muted on the right; as a button (`onClick`)
// it is a row: hover fill and a trailing chevron, so it never reads as a mere label.
export function chromeSection(ui, t, id, label, meta = null, onClick = null) {
  const { div, h_flex, svg } = ui;
  return h_flex().id(id).h(CHROME.section).flex_none().px(CHROME.rowX).gap(8).items_center().rounded(CHROME.radius)
    .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click(onClick))
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.muted).child(label))
    .when(Boolean(meta), (e) => e.child(div().flex_none().text_size(12).text_color(t.muted).child(meta)))
    .when(Boolean(onClick), (e) => e.child(svg(CHROME_ICON("chevron-right")).size(12).flex_none().text_color(t.chevron ?? t.dim)));
}
