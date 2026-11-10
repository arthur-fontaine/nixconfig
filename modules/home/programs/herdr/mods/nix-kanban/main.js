// The kanban: cards that become tasks for the Pi project orchestrators, through the
// herdr-kanban daemon (modules/home/programs/herdr/kanban, its local API on 127.0.0.1:7742).
// One mod, five faces, by props:
//   (none)            the Kanban sidebar (the sidebar's stack shows it or Repos): cards in
//                     sections in workflow order, folded and dragged between sections
//   { full: true }    the board, as its own tab: five columns, drag or arrows to move
//   { edit, column }  the card dialog (edit: a card id, or null for a new card)
//   { settings: true } MCP on/off, pairing code, paired agents, scheduler limits
//   { move, column }  a card's right-click menu: the column it goes to
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, settings, run, props, shared, setShared, spaces, openOverlay, closeOverlay, notify, pickFolder, layout, nextCommand } from "herdr";
import { API, COLUMNS, PRIORITIES, columnColor, kTokens, ago, byColumn, neighbor, projectName, factorChips, livePending, spacedCode, parseNumber, unrecordedSpaces, SIDE_ORDER, isFolded, waitLabel, waitLabels, firstLine } from "./model.js";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;
// The sidebar's stack (layouts/nix.json) and this sidebar in it.
const SWITCH = { stack: "sidebar-body", child: "sidebar-kanban" };
// A board column's narrowest: a card title on two lines, the header's name whole.
const COLUMN_MIN = 272;
const SIDE_EMPTY = { in_progress: "Nothing running.", review: "Nothing to review.", todo: "Cards here start by themselves.", backlog: "Ideas wait here.", done: "Nothing done yet." };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out?.error ?? `HTTP ${r.status}`);
  return out;
}

export default class Kanban extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.settings ? "settings" : "move" in p ? "move" : "edit" in p ? "edit" : p.full ? "board" : "side";
    this.state = null;
    this.offline = false;
    this.version = 0;
    this.hovered = null;
    this.head = null;
    this.drag = null;
    this.over = null;
    this.error = null;
    if (this.mode === "edit") this.initEditor(p);
    if (this.mode === "settings") this.fields = null;
    cx.spawn(async (cx) => this.poll(cx));
    // Only the sidebar copy takes commands (the pairing toast's click, keys: settings, board,
    // new), so one dialog opens.
    if (this.mode === "side") cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "settings") this.openSettings();
        if (c === "board") this.openBoard();
        if (c === "new") this.openCard(null, "todo");
        cx.notify();
      }
    });
  }

  // The daemon's long poll: an answer as soon as anything changes, else every 25 s.
  async poll(cx) {
    for (;;) {
      try {
        const s = await api("GET", `/state?since=${this.version}`);
        this.state = s;
        this.version = s.version;
        this.offline = false;
        this.react(s, cx);
      } catch {
        this.offline = true;
        this.version = 0;
        cx.notify();
        await new Promise((r) => cx.timer.after(3000, r));
        continue;
      }
      cx.notify();
    }
  }

  react(s, cx) {
    if (this.mode === "edit" && !this.loaded) this.fillEditor(s);
    if (this.mode === "settings" && !this.fields) this.fillSettings(s);
    // For the sidebar switcher's needs-you dot.
    const review = s.cards.filter((c) => c.column === "review").length;
    if (this.mode === "side" && (shared("nix-kanban.review") ?? 0) !== review) setShared("nix-kanban.review", review);
    const pending = livePending(s.pairing.pending);
    // A code shown in a toast once, by whichever copy sees it first.
    if (pending[0] && shared("nix-kanban.toasted") !== pending[0].code) {
      setShared("nix-kanban.toasted", pending[0].code);
      notify({
        title: "Pairing request", level: "info", timeout: 120_000,
        body: `${pending[0].client} wants to use the kanban. Code: ${spacedCode(pending[0].code)}`,
        // To the Kanban sidebar, where the code shows large (and the Repos one may be shown).
        action: { name: "layout.select", args: SWITCH },
      });
    }
    // Redraw when the code expires.
    if (pending[0]) cx.timer.after(Math.max(500, pending[0].expiresAt - Date.now() + 200), (cx) => cx.notify());
    // Orchestrator spaces the daemon started: the sidebar shows them as their project's.
    const recorded = shared("nix.orchestrators") ?? {};
    const add = unrecordedSpaces(s.cards, recorded, new Set(spaces().map((x) => x.id)));
    if (Object.keys(add).length) setShared("nix.orchestrators", { ...recorded, ...add });
  }

  act(cx, method, path, body, then) {
    cx.spawn(async (cx) => {
      try {
        const out = await api(method, path, body);
        this.error = null;
        then?.(out, cx);
      } catch (e) {
        this.error = e.message;
        notify({ title: "Kanban", body: e.message, level: "error" });
      }
      cx.notify();
    });
  }

  openBoard() { run("tab.new", { name: "Kanban", mod: "nix-kanban", props: { full: true } }); }
  openCard(id, column = "backlog") { openOverlay({ mod: "nix-kanban", kind: "dialog", width: 600, height: 640, props: { edit: id, column } }); }
  openSettings() { openOverlay({ mod: "nix-kanban", kind: "dialog", width: 540, height: 660, props: { settings: true } }); }

  // ---- Small parts, in the nix-* mods' vocabulary ----

  iconButton(id, icon, tip, action, t, { size = 24, iconSize = 13, color } = {}) {
    return div().id(id).size(size).flex_none().rounded(6).flex().items_center().justify_center().text_color(color ?? t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(ICON(icon)).size(iconSize));
  }

  button(id, label, action, t, { primary = false, danger = false, disabled = false } = {}) {
    return div().id(id).h(28).px(12).flex_none().rounded(6).flex().items_center().justify_center().text_size(12.5).font_medium()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (e) => e.border_1().border_color(t.input).text_color(danger ? t.blocked : t.foreground))
      .when(disabled, (e) => e.opacity(0.45))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover))).active((s) => s.opacity(0.8))
        .on_click((_e, cx) => action(cx)))
      .child(label);
  }

  // Priority as a signal: one to four rising bars, the urgent one in the attention color.
  priorityBars(p, t) {
    return h_flex().flex_none().gap(1.5).items_end().h(10).tooltip(`${PRIORITIES[p]} priority`)
      .children([0, 1, 2, 3].map((i) => div().w(2.5).h(3 + i * 2.3).rounded(1)
        .bg(i <= p ? (p === 3 ? t.blocked : t.muted) : t.border)));
  }

  columnIcon(column, t, size = 14) {
    return svg(ICON(COLUMNS.find((c) => c.id === column).icon)).size(size).flex_none().text_color(columnColor(t, column));
  }

  segmented(id, options, value, onPick, t) {
    return h_flex().p(2).gap(2).rounded(7).bg(t.raised).children(options.map(([v, label]) =>
      div().id(`${id}-${v}`).h(24).px(10).rounded(5).flex().items_center().text_size(12).cursor_pointer()
        .when(v === value, (e) => e.bg(t.background).text_color(t.foreground).font_medium().border_1().border_color(t.border))
        .when(v !== value, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => { onPick(v); cx.notify(); })
        .child(label)));
  }

  offlineNote(t) {
    return v_flex().gap(4).px(10).py(8)
      .child(div().text_size(12).text_color(t.muted).child("The kanban daemon isn't answering."))
      .child(div().text_size(11).text_color(t.dim).child("It runs as the herdr-kanban launchd agent; its log is ~/Library/Logs/herdr-kanban.log."));
  }

  // The one large type in the kanban: a code read aloud to a remote agent.
  pairingBanner(p, t, compact) {
    const left = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 60000));
    return v_flex().id("pairing").gap(2).px(compact ? 10 : 14).py(compact ? 8 : 12).rounded(8).bg(t.raised).border_1().border_color(t.accent)
      .cursor_pointer().on_click(() => this.openSettings())
      .child(div().text_size(11).text_color(t.muted).child(`${p.client} asks to pair`))
      .child(div().text_size(compact ? 22 : 30).font_semibold().text_color(t.foreground).font_family("JetBrains Mono").child(spacedCode(p.code)))
      .child(div().text_size(11).text_color(t.dim).child(`Give it this code. Expires in ${left <= 1 ? "under a minute" : `${left} min`}.`));
  }

  // ---- The Kanban sidebar (one child of the sidebar's stack; Repos is the other) ----

  folds() { return shared("nix-kanban.folds") ?? {}; }
  toggleFold(column, cx) {
    const f = this.folds();
    setShared("nix-kanban.folds", { ...f, [column]: !isFolded(f, column) });
    cx.notify();
  }

  // What the scheduler has room for, in the header's spare width.
  capacity(s, col) {
    const max = s.settings.maxInProgress;
    if (max === 0) return "Paused: nothing starts";
    return `${col.in_progress.length} of ${max} running`;
  }

  renderSide(t) {
    if (narrow()) return this.renderRail(t);
    const s = this.state;
    const col = s ? byColumn(s.cards) : null;
    const pending = s ? livePending(s.pairing.pending) : [];
    // Its own header, on the Repos filter row's lines (px 6, 28 high, pb 8): what the
    // scheduler has room for, then the Kanban's actions.
    const head = h_flex().flex_none().h(36).px(6).pb(8).gap(2).items_center()
      .child(div().id("capacity").flex_1().min_w(0).pl(6).truncate().text_size(11.5).text_color(t.dim)
        .when(Boolean(s), (e) => e.tooltip(`${kTokens(this.budgetUsed(s))} of ${kTokens(s.settings.tokenBudget)} tokens used in ${s.settings.budgetWindowHours} h`)
          .child(this.capacity(s, col))))
      .child(this.iconButton("new", "plus", "New card", () => this.openCard(null, "todo"), t, { size: 28, iconSize: 14 }))
      .child(this.iconButton("open-board", "arrow-up-right", "Open the board as a tab", () => this.openBoard(), t, { size: 28, iconSize: 14 }));
    const root = v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(head);
    if (this.offline) return root.child(this.offlineNote(t));
    if (!s) return root;
    return root.child(v_flex().id("kanban-list").flex_1().min_h(0).px(6).pb(8).gap(2).overflow_y_scrollbar()
      // Released outside the list: the drag is dropped where it started.
      .on_hover((h, cx) => { if (!h && this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .when(pending.length > 0, (e) => e.child(div().pb(8).child(this.pairingBanner(pending[0], t, true))))
      .children(SIDE_ORDER.map((id) => this.section(id, col[id], s, t))));
  }

  // A section: its header folds it; cards dragged over it can land in it (not in Review,
  // which only an orchestrator's report reaches).
  section(id, cards, s, t) {
    const name = COLUMNS.find((c) => c.id === id).name;
    const folded = isFolded(this.folds(), id);
    const lit = Boolean(this.drag) && this.drag.from !== id && id !== "review" && this.over === id;
    return v_flex().id(`sec-${id}`).flex_none().rounded(8).pb(folded ? 0 : 6)
      .when(lit, (e) => e.bg(t.hover))
      .on_hover((h, cx) => { if (h && this.over !== id) { this.over = id; if (this.drag) cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => this.drop(id, cx))
      .child(h_flex().id(`fold-${id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((x) => x.bg(t.hover)).active((x) => x.bg(t.selected)).tooltip(folded ? "Unfold" : "Fold")
        .on_hover((h, cx) => { const was = this.head; this.head = h ? id : this.head === id ? null : this.head; if (was !== this.head) cx.notify(); })
        .on_click((_e, cx) => this.toggleFold(id, cx))
        // The column's icon, the fold chevron under the pointer (as Repos' folder rows).
        .child(div().size(14).flex_none().flex().items_center().justify_center()
          .child(this.head === id ? svg(ICON(folded ? "chevron-right" : "chevron-down")).size(12).text_color(t.muted) : this.columnIcon(id, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(cards.length ? t.foreground : t.muted).child(name))
        // Review waits on the person: its count in the needs-you color.
        .child(div().flex_none().text_size(11).text_color(id === "review" && cards.length ? t.blocked : t.dim).child(String(cards.length))))
      .when(!folded, (e) => e.child(v_flex().px(2).gap(6)
        .children(cards.map((c) => this.sideCard(c, s, t)))
        .when(!cards.length, (e) => e.child(div().px(8).text_size(11.5).text_color(t.dim).child(SIDE_EMPTY[id])))));
  }

  sideCard(c, s, t) {
    const project = projectName(s.projects, c.project);
    const status = c.project ? s.orchestrators?.[c.project] : null;
    const prio = [t.dim, t.muted, t.foreground, t.blocked][c.priority] ?? t.dim;
    const line = (el) => el.text_size(11.5).truncate();
    return v_flex().id(`sc-${c.id}`).px(10).py(8).gap(4).rounded(8).bg(t.surface).border_1().border_color(t.border).cursor_pointer()
      .hover((x) => x.border_color(t.input)).active((x) => x.bg(t.hover))
      .when(this.drag?.id === c.id && this.over !== c.column, (e) => e.opacity(0.5))
      .tooltip(c.column === "todo" && c.waiting.length ? c.waiting.join("\n") : c.title)
      .on_mouse_down("left", () => { this.drag = { id: c.id, from: c.column }; })
      .on_mouse_down("right", (_e, cx) => this.openMove(c, cx))
      .on_click((_e, cx) => { if (this.dragged) { this.dragged = false; return; } this.drag = null; this.openCard(c.id); cx.notify(); })
      // Two lines at most: a fixed line height, and what doesn't fit is cut.
      .child(div().text_size(12.5).line_height("17px").max_h(34).overflow_hidden().text_color(c.column === "done" ? t.muted : t.foreground).child(c.title))
      .child(h_flex().h(16).gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(project), (e) => e.child(div().min_w(0).truncate().child(project)))
        .child(h_flex().flex_none().gap(4).items_center()
          .child(div().size(6).rounded(3).bg(prio))
          .child(div().text_color(c.priority === 3 ? t.blocked : t.dim).child(PRIORITIES[c.priority])))
        .child(div().flex_1())
        .when(c.estimate != null, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).opacity(0.8).tooltip("Estimated tokens").child(`~${kTokens(c.estimate)}`)))
        .when(c.estimating, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).frames(["·", "··", "···"], 400))))
      .when(c.column === "todo", (e) => e.child(c.error
        ? line(div().text_color(t.blocked)).child(c.error)
        : h_flex().gap(5).items_center().text_color(c.waiting.length ? t.muted : t.foreground)
          .child(svg(ICON(c.waiting.length ? "clock" : "chevron-right")).size(11).flex_none().text_color(t.dim))
          .child(line(div().flex_1().min_w(0)).child(waitLabel(c)))))
      .when(c.column === "in_progress", (e) => e.child(h_flex().id(`orch-${c.id}`).gap(6).items_center().text_color(t.muted)
        .when(Boolean(c.orchestrator), (e) => e.hover((x) => x.text_color(t.foreground)).tooltip("Show the orchestrator")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: c.orchestrator.terminal }); }))
        .child(svg(ICON("loader")).size(11).flex_none().text_color(t.working).spin(900))
        .child(line(div().flex_1().min_w(0)).child(c.orchestrator?.name ?? "starting…"))
        .when(status === "missing", (e) => e.child(div().flex_none().text_size(11).text_color(t.blocked).child("not running")))))
      .when(c.column === "review" && Boolean(c.review), (e) => e.child(line(div().pl(7).border_l(2).border_color(columnColor(t, "review")).text_color(t.foreground)).child(firstLine(c.review))));
  }

  // The rail: the board's button, then each section's count under its icon.
  renderRail(t) {
    const col = this.state ? byColumn(this.state.cards) : null;
    return v_flex().size_full().bg(t.chrome).pt(4).gap(2).items_center()
      .child(this.iconButton("board", "arrow-up-right", "Open the board", () => this.openBoard(), t, { size: 30, iconSize: 15 }))
      .when(Boolean(col), (e) => e.children(SIDE_ORDER.map((id) => v_flex().id(`rail-${id}`).w(30).py(5).gap(3).items_center().rounded(6)
        .tooltip(`${COLUMNS.find((c) => c.id === id).name}: ${col[id].length}`)
        .hover((x) => x.bg(t.hover)).cursor_pointer().on_click(() => this.openBoard())
        .child(this.columnIcon(id, t, 14))
        .child(div().text_size(11).text_color(id === "review" && col[id].length ? t.blocked : col[id].length ? t.muted : t.dim).child(String(col[id].length))))))
      .when(this.offline, (e) => e.child(div().size(6).mt(4).rounded(3).bg(t.blocked).tooltip("The kanban daemon isn't answering")));
  }

  // Right-click: where the card goes, as a menu (nix-kanban's own face, { move }).
  openMove(c, cx) {
    const height = 4 * 2 + 28 * (COLUMNS.length) + 9;
    let at = "pointer";
    try {
      const m = cx.mouse_position(), v = cx.viewport_size();
      at = { x: Math.min(m.x, v.width - 200 - 8), y: Math.max(8, Math.min(m.y, v.height - height - 8)) };
    } catch {}
    openOverlay({ mod: "nix-kanban", kind: "popup", width: 200, height, at, props: { move: c.id, column: c.column } });
  }

  // ---- The board ----

  renderBoard(t) {
    const s = this.state;
    const root = v_flex().id("board").size_full().min_h(0).bg(t.canvas ?? t.background).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } });
    if (this.offline) return root.child(this.offlineNote(t));
    if (!s) return root;
    const col = byColumn(s.cards);
    const used = this.budgetUsed(s);
    const pending = livePending(s.pairing.pending);
    const width = this.columnWidth();
    const header = h_flex().h(48).flex_none().px(16).gap(14).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(svg(ICON("square-kanban")).size(15).text_color(t.muted))
      .child(div().text_size(15).font_semibold().child("Kanban"))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).tooltip(`Cards started in the last ${s.settings.budgetWindowHours} h, against the token budget`)
        .child(`${kTokens(used)} of ${kTokens(s.settings.tokenBudget)} tokens in ${s.settings.budgetWindowHours} h`))
      .when(s.freeRamGB != null, (e) => e.child(div().text_size(11.5).text_color(s.freeRamGB < s.settings.minFreeRamGB ? t.blocked : t.dim)
        .child(`${Math.round(s.freeRamGB)} GB free`)))
      .child(div().text_size(11.5).text_color(t.dim).child(this.capacity(s, col)))
      .child(this.iconButton("mcp", "radio", s.mcp?.listening ? `Remote agents: on, port ${s.mcp.port}` : "Remote agents: off", () => this.openSettings(), t,
        { size: 28, iconSize: 14, color: s.mcp?.listening ? t.accent : t.dim }))
      .child(this.iconButton("settings", "settings", "Kanban settings", () => this.openSettings(), t, { size: 28, iconSize: 14 }))
      .child(this.button("new-card", "New card", () => this.openCard(null, "todo"), t, { primary: true }));
    return root.child(header)
      .when(pending.length > 0, (e) => e.child(div().px(16).pt(12).child(this.pairingBanner(pending[0], t, false))))
      // Columns share the width down to COLUMN_MIN, then the row scrolls sideways. Its scroll
      // offset is kept under its id, so a poll's repaint leaves it where it was.
      .child(h_flex().id("board-columns").flex_1().min_h(0).p(12).gap(10).items_start().overflow_x_scrollbar()
        // Reported in window pixels, while w() is in pixels before the person's zoom.
        .on_size_change((size, cx) => {
          const width = size.width / (Number(settings().zoom) || 1);
          if (width !== this.boardWidth) { this.boardWidth = width; cx.notify(); }
        })
        .children(COLUMNS.map((c) => this.column(c, col[c.id], s, t, width)))
        // Scrolled to the end, the row's right padding is lost: this keeps Done off the edge.
        .when(width === COLUMN_MIN, (e) => e.child(div().w(2).h(1).flex_none())));
  }

  budgetUsed(s) {
    const since = Date.now() - s.settings.budgetWindowHours * 3600_000;
    return s.cards.filter((c) => c.startedAt != null && c.startedAt >= since).reduce((n, c) => n + (c.estimate ?? s.settings.defaultEstimate), 0);
  }

  // An explicit width: inside a scrolling row, flex_1 columns take their content's width.
  columnWidth() {
    const n = COLUMNS.length;
    return Math.max(COLUMN_MIN, Math.floor(((this.boardWidth ?? 0) - 24 - 10 * (n - 1)) / n));
  }

  column(c, cards, s, t, width) {
    const target = this.drag && this.drag.from !== c.id && c.id !== "review";
    const lit = target && this.over === c.id;
    return v_flex().id(`col-${c.id}`).w(width).flex_none().h_full().rounded(8).bg(t.chrome).border_1()
      .border_color(lit ? columnColor(t, c.id) : t.border)
      .on_hover((h, cx) => {
        if (h && this.over !== c.id) { this.over = c.id; if (this.drag) cx.notify(); }
        const was = this.head; this.head = h ? c.id : this.head === c.id ? null : this.head; if (was !== this.head) cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.drop(c.id, cx))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center()
        .child(this.columnIcon(c.id, t))
        // Narrow columns cut the name, never the icon, the count or the +.
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_shrink_1().min_w(0).truncate().text_size(13).font_medium().child(c.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${cards.length}`)))
        // Under the pointer only, as the Repos sidebar's +: narrow columns keep their name.
        .when((c.id === "backlog" || c.id === "todo") && this.head === c.id, (e) => e.child(this.iconButton(`add-${c.id}`, "plus", `New card in ${c.name}`, () => this.openCard(null, c.id), t))))
      .child(v_flex().id(`cards-${c.id}`).flex_1().min_h(0).px(8).pb(8).gap(6).overflow_y_scrollbar()
        .children(cards.map((card) => this.card(card, s, t)))
        .when(!cards.length, (e) => e.child(div().px(4).py(6).text_size(11.5).text_color(t.dim).child(
          { backlog: "Ideas wait here.", todo: "Cards here start by themselves.", in_progress: "Nothing running.", review: "The orchestrators report here.", done: "" }[c.id]))));
  }

  drop(column, cx) {
    const d = this.drag;
    this.drag = null;
    this.over = null;
    if (!d || d.from === column) { cx.notify(); return; }
    this.dragged = true;
    if (column === "review") { notify({ title: "Kanban", body: "Cards reach Review when their orchestrator reports the work done.", level: "info" }); cx.notify(); return; }
    this.act(cx, "POST", `/cards/${d.id}/move`, { column });
  }

  card(c, s, t) {
    const hovered = this.hovered === c.id;
    const chips = factorChips(c);
    const project = projectName(s.projects, c.project);
    const status = c.project ? s.orchestrators?.[c.project] : null;
    const back = neighbor(c.column, -1), next = neighbor(c.column, 1);
    return v_flex().id(`card-${c.id}`).p(10).gap(6).rounded(6).bg(t.background).border_1()
      .border_color(hovered ? t.input : t.border).cursor_pointer()
      .when(this.drag?.id === c.id, (e) => e.opacity(0.5))
      .on_hover((h, cx) => { const was = this.hovered; this.hovered = h ? c.id : this.hovered === c.id ? null : this.hovered; if (was !== this.hovered) cx.notify(); })
      .on_mouse_down("left", () => { this.drag = { id: c.id, from: c.column }; })
      .on_click((_e, cx) => { if (this.dragged) { this.dragged = false; return; } this.drag = null; this.openCard(c.id); cx.notify(); })
      .child(h_flex().h(18).gap(7).items_center()
        .child(this.priorityBars(c.priority, t))
        .child(div().text_size(11).text_color(t.dim).child(c.id))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(project ?? "no project"))
        .when(hovered, (e) => e
          .when(Boolean(back), (e) => e.child(this.iconButton(`back-${c.id}`, "chevron-left", `To ${COLUMNS.find((x) => x.id === back).name}`, (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: back }), t, { size: 18, iconSize: 11 })))
          .when(Boolean(next), (e) => e.child(this.iconButton(`next-${c.id}`, "chevron-right", `To ${COLUMNS.find((x) => x.id === next).name}`, (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: next }), t, { size: 18, iconSize: 11 })))))
      .child(div().text_size(13).text_color(c.column === "done" ? t.muted : t.foreground).child(c.title))
      .when(chips.length > 0 || c.estimating, (e) => e.child(h_flex().flex_wrap().gap(4)
        .children(chips.map((x, i) => div().id(`chip-${c.id}-${i}`).h(18).px(6).rounded(4).bg(t.raised).flex().items_center().text_size(10.5).text_color(t.muted)
          .when(i === 0 && Boolean(c.factors?.notes), (e) => e.tooltip(c.factors.notes)).child(x)))
        .when(c.estimating, (e) => e.child(div().h(18).px(6).flex().items_center().text_size(10.5).text_color(t.dim).frames(["sizing up", "sizing up.", "sizing up..", "sizing up..."], 400)))))
      .when(c.column === "todo" && c.waiting.length > 0, (e) => e.child(v_flex().gap(2)
        .tooltip(c.waiting.join("\n"))
        .children(waitLabels(c).map((w) => h_flex().gap(5).items_start().text_size(11.5).text_color(t.muted)
          .child(svg(ICON("clock")).size(11).mt(2).flex_none().text_color(t.dim)).child(div().flex_1().min_w(0).child(w))))))
      .when(Boolean(c.error) && c.column === "todo", (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(c.error)))
      .when(c.column === "in_progress" && Boolean(c.orchestrator), (e) => e.child(h_flex().id(`orch-${c.id}`).gap(6).items_center().text_size(11.5).text_color(t.muted)
        .hover((x) => x.text_color(t.foreground)).tooltip("Show the orchestrator")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: c.orchestrator.terminal }); })
        .child(svg(ICON("terminal")).size(11).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(`${c.orchestrator.terminal} · ${c.orchestrator.name}`))
        .when(Boolean(status), (e) => e.child(div().flex_none().text_color(t[status] ?? t.dim).child(status === "missing" ? "not running" : status)))))
      .when(c.column === "review" && Boolean(c.review), (e) => e.child(v_flex().gap(8)
        .child(div().pl(8).border_l(2).border_color(columnColor(t, "review")).text_size(12).text_color(t.foreground).child(c.review))
        .child(h_flex().flex_wrap().gap(6)
          .child(this.button(`done-${c.id}`, "Mark done", (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: "done" }), t))
          .child(this.button(`redo-${c.id}`, "Send back", (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: "todo" }), t)))))
      .when(c.column !== "todo" && c.column !== "backlog", (e) => e.child(div().text_size(10.5).text_color(t.dim).child(`${COLUMNS.find((x) => x.id === c.column).name} ${ago(c.movedAt)}`)));
  }

  // ---- The card dialog ----

  initEditor(p) {
    this.cardId = p.edit ?? null;
    this.title = InputState.new({ placeholder: "What should be done" });
    // Sized by rows only: the textarea scrolls as if it shows `rows` lines, so a fixed h() under
    // that clips the last lines out of reach.
    this.prompt = TextareaState.new({ placeholder: "Details for the orchestrator: context, where to look, what done means", rows: 7 });
    this.prompt.set_soft_wrap(true);
    this.project = null;
    this.priority = 1;
    this.column = p.column === "backlog" ? "backlog" : "todo";
    this.loaded = this.cardId === null;
  }

  fillEditor(s) {
    this.loaded = true;
    const c = s.cards.find((x) => x.id === this.cardId);
    if (!c) return;
    this.title.set_value(c.title);
    this.prompt.set_value(c.prompt);
    this.project = c.project;
    this.priority = c.priority;
    this.column = c.column;
  }

  // Not `close`: that name is the View's teardown hook.
  closeDialog() { closeOverlay(props().overlay); }

  save(cx) {
    const body = { title: this.title.value().trim(), prompt: this.prompt.value(), project: this.project, priority: this.priority };
    if (!body.title) { this.error = "A card needs a title."; cx.notify(); return; }
    if (this.cardId) this.act(cx, "PATCH", `/cards/${this.cardId}`, body, () => this.closeDialog());
    else this.act(cx, "POST", "/cards", { ...body, column: this.column }, () => this.closeDialog());
  }

  renderEditor(t) {
    const s = this.state;
    const c = s?.cards.find((x) => x.id === this.cardId) ?? null;
    const field = (label, child, hint) => v_flex().gap(6)
      .child(h_flex().gap(8).child(div().text_size(12).font_medium().text_color(t.muted).child(label)).when(Boolean(hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(child);
    const frame = (el) => el.px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground);
    const projects = s?.projects ?? [];
    const chips = c ? factorChips(c) : [];
    return v_flex().id("editor").size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(c ? `${c.id} · ${COLUMNS.find((x) => x.id === c.column).name}` : "New card"))
        .when(Boolean(c), (e) => e.child(div().text_size(11).text_color(t.dim).child(`created ${ago(c.createdAt)} ago`))))
      .child(field("Title", frame(Input.new(this.title).h(32).items_center().text_size(13))))
      .child(field("Prompt", frame(Textarea.new(this.prompt).py(8).text_size(12.5))))
      .child(field("Project", v_flex().id("projects").h(118).rounded(6).border_1().border_color(t.border).bg(t.background).p(4).overflow_y_scrollbar()
        .children(projects.map((p) => h_flex().id(`p-${p.key}`).h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(this.project === p.key, (e) => e.bg(t.selected))
          .when(this.project !== p.key, (e) => e.hover((x) => x.bg(t.hover)))
          .on_click((_e, cx) => { this.project = p.key; cx.notify(); })
          .child(svg(ICON("folder")).size(12).flex_none().text_color(t.muted))
          .child(div().flex_none().text_size(12.5).child(p.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(p.root))
          .when(this.project === p.key, (e) => e.child(svg(ICON("check")).size(12).flex_none().text_color(t.accent)))))
        .child(h_flex().id("add-repo").h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer().text_color(t.muted)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(async (cx) => {
            const folder = await pickFolder({ prompt: "Add repo" });
            if (folder) this.act(cx, "POST", "/projects", { folder }, (p) => { this.project = p.key; });
          }))
          .child(svg(ICON("folder-plus")).size(12).flex_none()).child(div().text_size(12.5).child("Add a repo…"))), "its project orchestrator gets the card"))
      .child(h_flex().gap(18).items_end()
        .child(field("Priority", this.segmented("prio", PRIORITIES.map((n, i) => [i, n]), this.priority, (v) => { this.priority = v; }, t)))
        .when(!c, (e) => e.child(field("Start", this.segmented("col", [["todo", "As soon as possible"], ["backlog", "Keep as an idea"]], this.column, (v) => { this.column = v; }, t)))))
      .when(Boolean(c), (e) => e.child(h_flex().gap(6).items_center().flex_wrap()
        .children(chips.map((x) => div().h(20).px(7).rounded(4).bg(t.raised).flex().items_center().text_size(11).text_color(t.muted).child(x)))
        .when(c.estimating, (e) => e.child(div().text_size(11).text_color(t.dim).child("Sonnet is sizing it up…")))
        .when(!c.estimating && c.estimate == null, (e) => e.child(div().text_size(11).text_color(t.dim).child("Not estimated yet.")))
        .when(Boolean(c.factors?.notes), (e) => e.child(div().text_size(11).text_color(t.dim).child(c.factors.notes)))
        .child(div().id("reestimate").text_size(11).text_color(t.accent).cursor_pointer().hover((x) => x.opacity(0.8))
          .on_click((_e, cx) => this.act(cx, "POST", `/cards/${c.id}/estimate`, {})).child("Estimate again"))))
      .when(Boolean(c?.review), (e) => e.child(div().pl(8).border_l(2).border_color(columnColor(t, "review")).text_size(12).child(c.review)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).items_center()
        .when(Boolean(c), (e) => e.child(this.button("delete", "Delete", (cx) => this.act(cx, "DELETE", `/cards/${c.id}`, undefined, () => this.closeDialog()), t, { danger: true })))
        .child(div().flex_1())
        .child(this.button("cancel", "Cancel", () => this.closeDialog(), t))
        .child(this.button("save", c ? "Save" : "Create card", (cx) => this.save(cx), t, { primary: true, disabled: !s })));
  }

  // ---- Settings ----

  fillSettings(s) {
    const st = s.settings;
    this.fields = {
      maxInProgress: InputState.new({ value: String(st.maxInProgress) }),
      minFreeRamGB: InputState.new({ value: String(st.minFreeRamGB) }),
      tokenBudget: InputState.new({ value: kTokens(st.tokenBudget) }),
      budgetWindowHours: InputState.new({ value: String(st.budgetWindowHours) }),
      defaultEstimate: InputState.new({ value: kTokens(st.defaultEstimate) }),
    };
  }

  saveLimits(cx) {
    const f = this.fields;
    const v = {
      maxInProgress: parseNumber(f.maxInProgress.value(), { min: 1, integer: true }),
      minFreeRamGB: parseNumber(f.minFreeRamGB.value()),
      tokenBudget: parseNumber(f.tokenBudget.value(), { min: 1, integer: true }),
      budgetWindowHours: parseNumber(f.budgetWindowHours.value(), { min: 0.25 }),
      defaultEstimate: parseNumber(f.defaultEstimate.value(), { integer: true }),
    };
    const bad = Object.entries(v).find(([, x]) => x === null);
    if (bad) { this.error = "Each limit is a number (200k and 1.5M work too)."; cx.notify(); return; }
    this.act(cx, "PATCH", "/settings", v, () => { this.saved = Date.now(); });
  }

  renderSettings(t) {
    const s = this.state;
    const root = v_flex().id("settings").size_full().p(18).gap(16).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("Kanban settings"));
    if (this.offline) return root.child(this.offlineNote(t));
    if (!s || !this.fields) return root;
    const on = s.settings.mcpEnabled;
    const pending = livePending(s.pairing.pending);
    const section = (title, ...children) => v_flex().gap(8).child(div().text_size(12).font_medium().text_color(t.muted).child(title)).children(children);
    const toggle = div().id("mcp-toggle").w(34).h(20).flex_none().rounded(10).p(2).cursor_pointer().bg(on ? t.accent : t.input)
      .flex().items_center().when(on, (e) => e.justify_end())
      .on_click((_e, cx) => this.act(cx, "PATCH", "/settings", { mcpEnabled: !on }))
      .child(div().size(16).rounded(8).bg(t.background));
    const mcpLine = s.mcp?.error ? `Couldn't open port ${s.mcp.port}: ${s.mcp.error}`
      : s.mcp?.listening ? `Listening on port ${s.mcp.port} at /mcp, announced on the network as “Herdr Kanban”.`
      : "Off: no port is open and nothing is announced.";
    const limit = (key, label, hint) => v_flex().gap(4).flex_1().min_w(0)
      .child(div().text_size(12).text_color(t.foreground).child(label))
      .child(Input.new(this.fields[key]).h(30).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5))
      .child(div().text_size(11).text_color(t.dim).child(hint));
    return root
      .child(section("Remote agents",
        h_flex().gap(12).items_center()
          .child(v_flex().flex_1().gap(2)
            .child(div().child("Let agents on the network use the kanban"))
            .child(div().text_size(11.5).text_color(s.mcp?.error ? t.blocked : t.dim).child(mcpLine)))
          .child(toggle),
        ...(pending.length ? [this.pairingBanner(pending[0], t, false)] : []),
        v_flex().gap(2).rounded(6).border_1().border_color(t.border).p(4)
          .children(s.pairing.clients.map((c) => h_flex().h(34).px(8).gap(10).items_center()
            .child(svg(ICON("user")).size(13).text_color(t.muted).flex_none())
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_size(12.5).child(c.name))
              .child(div().text_size(11).text_color(t.dim).child(`paired ${ago(c.createdAt)} ago${c.lastUsedAt ? `, last seen ${ago(c.lastUsedAt)} ago` : ", not used yet"}`)))
            .child(this.button(`revoke-${c.id}`, "Revoke", (cx) => this.act(cx, "DELETE", `/clients/${c.id}`), t, { danger: true }))))
          .when(!s.pairing.clients.length, (e) => e.child(div().px(8).py(8).text_size(12).text_color(t.dim)
            .child("No agent is paired. An agent asks with pair_start; its code shows here and in a notification.")))))
      .child(section("When To-do cards start",
        h_flex().gap(12)
          .child(limit("maxInProgress", "Cards in progress at once", "across all projects"))
          .child(limit("minFreeRamGB", "Free RAM to keep (GB)", "plus what a card needs")),
        h_flex().gap(12)
          .child(limit("tokenBudget", "Token budget", "estimated tokens per window"))
          .child(limit("budgetWindowHours", "Budget window (hours)", "cards started within it count"))
          .child(limit("defaultEstimate", "Card not sized yet", "counts as this many tokens"))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).items_center()
        .when(Boolean(this.saved) && Date.now() - this.saved < 4000, (e) => e.child(div().text_size(11.5).text_color(t.dim).child("Limits saved.")))
        .child(div().flex_1())
        .child(this.button("close", "Close", () => this.closeDialog(), t))
        .child(this.button("save-limits", "Save limits", (cx) => this.saveLimits(cx), t, { primary: true })));
  }

  // ---- The move menu, in nix-menu's look ----

  renderMove(t) {
    const p = props();
    const go = (column) => {
      closeOverlay(p.overlay);
      if (column === p.column) return;
      api("POST", `/cards/${p.move}/move`, { column }).catch((e) => notify({ title: "Kanban", body: e.message, level: "error" }));
    };
    const item = (id, icon, label, onClick, { on = false, off = false } = {}) => h_flex().id(id).h(28).px(8).gap(8).rounded(6).items_center()
      .text_color(off ? t.dim : t.foreground)
      .when(!off, (e) => e.hover((x) => x.bg(t.hover)).active((x) => x.bg(t.selected)).on_click(onClick))
      .child(icon).child(div().flex_1().child(label))
      .when(on, (e) => e.child(svg(ICON("check")).size(12).flex_none().text_color(t.accent)));
    return v_flex().id("move").w_full().p(4).bg(t.popover).text_size(12.5)
      .child(item("open", svg(ICON("square-pen")).size(14).flex_none().text_color(t.muted), "Open card", () => { closeOverlay(p.overlay); this.openCard(p.move); }))
      .child(div().mx(8).my(4).h(1).bg(t.border))
      .children(COLUMNS.filter((c) => c.id !== "review" || p.column === "review").map((c) =>
        item(`to-${c.id}`, this.columnIcon(c.id, t),
          c.id === "in_progress" && p.column !== "in_progress" ? "In progress (start now)" : c.name, () => go(c.id), { on: c.id === p.column })));
  }

  render() {
    const t = theme();
    if (this.mode === "move") return this.renderMove(t);
    if (this.mode === "board") return this.renderBoard(t);
    if (this.mode === "edit") return this.renderEditor(t);
    if (this.mode === "settings") return this.renderSettings(t);
    return this.renderSide(t);
  }
}
