// The kanban: cards that become tasks for the Pi project orchestrators, through the
// herdr-kanban daemon (modules/home/programs/herdr/kanban, its local API on 127.0.0.1:7742).
// One mod, four faces, by props:
//   (none)            the sidebar block: what needs review, what runs, what's next
//   { full: true }    the board, as its own tab: five columns, drag or arrows to move
//   { edit, column }  the card dialog (edit: a card id, or null for a new card)
//   { settings: true } MCP on/off, pairing code, paired agents, scheduler limits
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, run, props, shared, setShared, spaces, openOverlay, closeOverlay, notify, pickFolder, layout, nextCommand } from "herdr";
import { API, COLUMNS, PRIORITIES, columnColor, kTokens, ago, byColumn, glance, neighbor, projectName, factorChips, livePending, spacedCode, parseNumber, unrecordedSpaces } from "./model.js";

const ICON = (n) => `mods/nix-head/icons/${n}.svg`;
const BLOCK = "sidebar-kanban"; // its block in the nix layout
const FOLDED_PX = 36;
const OPEN_PX = 220;

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
    this.mode = p.settings ? "settings" : "edit" in p ? "edit" : p.full ? "board" : "side";
    this.state = null;
    this.offline = false;
    this.version = 0;
    this.hovered = null;
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
    const pending = livePending(s.pairing.pending);
    // A code shown in a toast once, by whichever copy sees it first.
    if (pending[0] && shared("nix-kanban.toasted") !== pending[0].code) {
      setShared("nix-kanban.toasted", pending[0].code);
      notify({
        title: "Pairing request", level: "info", timeout: 120_000,
        body: `${pending[0].client} wants to use the kanban. Code: ${spacedCode(pending[0].code)}`,
        action: { name: "nix-kanban.settings" },
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

  // In progress turns like the sidebar's working ring; the rest are dots.
  dot(column, t, size = 7) {
    if (column === "in_progress") return svg(ICON("loader")).size(size + 4).flex_none().text_color(columnColor(t, column)).spin(900);
    return div().size(size).flex_none().rounded(size / 2).bg(columnColor(t, column));
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

  // ---- The sidebar block ----

  folded() { return Boolean(shared("nix-kanban.folded")); }
  fold(cx) {
    const now = !this.folded();
    setShared("nix-kanban.folded", now);
    run("layout.resize", { id: BLOCK, px: now ? FOLDED_PX : (shared("nix-kanban.height") ?? OPEN_PX) });
    cx.notify();
  }

  renderSide(t) {
    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().pt(4)
        .child(this.iconButton("board", "square-kanban", "Kanban", () => this.openBoard(), t, { size: 30, iconSize: 15 }));
    }
    const s = this.state;
    const folded = this.folded();
    const col = s ? byColumn(s.cards) : null;
    const pending = s ? livePending(s.pairing.pending) : [];
    const head = h_flex().id("kanban-head").h(FOLDED_PX).flex_none().px(10).gap(8).items_center().cursor_pointer()
      .on_click((_e, cx) => this.fold(cx))
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(10).text_color(t.dim).flex_none())
      .child(div().text_size(13).font_medium().text_color(t.foreground).child("Kanban"))
      .when(Boolean(col), (e) => e.child(h_flex().gap(7).items_center()
        .when(col.review.length > 0, (e) => e.child(h_flex().gap(4).items_center().tooltip("Waiting for your review").child(this.dot("review", t, 6)).child(div().text_size(11).text_color(t.muted).child(`${col.review.length}`))))
        .when(col.in_progress.length > 0, (e) => e.child(h_flex().gap(4).items_center().tooltip("In progress").child(this.dot("in_progress", t, 6)).child(div().text_size(11).text_color(t.muted).child(`${col.in_progress.length}`))))
        .when(col.todo.length > 0, (e) => e.child(h_flex().gap(4).items_center().tooltip("To-do").child(this.dot("todo", t, 6)).child(div().text_size(11).text_color(t.muted).child(`${col.todo.length}`))))))
      .when(pending.length > 0 && folded, (e) => e.child(div().size(6).rounded(3).bg(t.accent).tooltip("A pairing code is waiting")))
      .child(div().flex_1())
      .child(this.iconButton("new", "plus", "New card", () => this.openCard(null, "todo"), t))
      .child(this.iconButton("open-board", "maximize-2", "Open the board", () => this.openBoard(), t));
    const root = v_flex().id("root").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .on_size_change((size) => { if (!this.folded() && size.height > FOLDED_PX + 20) setShared("nix-kanban.height", Math.round(size.height)); })
      .child(head);
    if (folded) return root;
    if (this.offline) return root.child(this.offlineNote(t));
    if (!s) return root;
    const rows = glance(s.cards, 8);
    return root.child(v_flex().id("kanban-list").flex_1().min_h(0).px(6).pb(6).gap(1).overflow_y_scrollbar()
      .when(pending.length > 0, (e) => e.child(div().px(4).pb(6).child(this.pairingBanner(pending[0], t, true))))
      .children(rows.map((c) => this.sideRow(c, s, t)))
      .when(!rows.length, (e) => e.child(div().px(10).py(4).text_size(12).text_color(t.dim)
        .child(s.cards.length ? "Nothing in review, running or queued." : "No cards yet. + adds one."))));
  }

  sideRow(c, s, t) {
    const meta = c.column === "review" ? "review" : c.column === "in_progress" ? (projectName(s.projects, c.project) ?? "") : c.waiting[0] ? "waiting" : "next";
    return h_flex().id(`row-${c.id}`).h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover)).active((x) => x.bg(t.selected))
      .tooltip(c.column === "todo" && c.waiting.length ? c.waiting.join("\n") : c.column === "review" ? (c.review ?? "") : c.title)
      .on_click(() => this.openCard(c.id))
      .child(this.dot(c.column, t))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(c.column === "todo" ? t.muted : t.foreground).child(c.title))
      .child(div().flex_none().max_w(90).truncate().text_size(11).text_color(c.column === "review" ? t.blocked : t.dim).child(meta));
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
    const header = h_flex().h(48).flex_none().px(16).gap(14).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(svg(ICON("square-kanban")).size(15).text_color(t.muted))
      .child(div().text_size(15).font_semibold().child("Kanban"))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).tooltip(`Cards started in the last ${s.settings.budgetWindowHours} h, against the token budget`)
        .child(`${kTokens(used)} of ${kTokens(s.settings.tokenBudget)} tokens in ${s.settings.budgetWindowHours} h`))
      .when(s.freeRamGB != null, (e) => e.child(div().text_size(11.5).text_color(s.freeRamGB < s.settings.minFreeRamGB ? t.blocked : t.dim)
        .child(`${Math.round(s.freeRamGB)} GB free`)))
      .child(div().text_size(11.5).text_color(t.dim).child(`${col.in_progress.length} of ${s.settings.maxInProgress} running`))
      .child(this.iconButton("mcp", "radio", s.mcp?.listening ? `Remote agents: on, port ${s.mcp.port}` : "Remote agents: off", () => this.openSettings(), t,
        { size: 28, iconSize: 14, color: s.mcp?.listening ? t.accent : t.dim }))
      .child(this.iconButton("settings", "settings", "Kanban settings", () => this.openSettings(), t, { size: 28, iconSize: 14 }))
      .child(this.button("new-card", "New card", () => this.openCard(null, "todo"), t, { primary: true }));
    return root.child(header)
      .when(pending.length > 0, (e) => e.child(div().px(16).pt(12).child(this.pairingBanner(pending[0], t, false))))
      .child(h_flex().flex_1().min_h(0).p(12).gap(10).items_start()
        .children(COLUMNS.map((c) => this.column(c, col[c.id], s, t))));
  }

  budgetUsed(s) {
    const since = Date.now() - s.settings.budgetWindowHours * 3600_000;
    return s.cards.filter((c) => c.startedAt != null && c.startedAt >= since).reduce((n, c) => n + (c.estimate ?? s.settings.defaultEstimate), 0);
  }

  column(c, cards, s, t) {
    const target = this.drag && this.drag.from !== c.id && c.id !== "review";
    const lit = target && this.over === c.id;
    return v_flex().id(`col-${c.id}`).flex_1().min_w(0).h_full().rounded(8).bg(t.chrome).border_1()
      .border_color(lit ? columnColor(t, c.id) : t.border)
      .on_hover((h, cx) => { if (h && this.over !== c.id) { this.over = c.id; if (this.drag) cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => this.drop(c.id, cx))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center()
        .child(this.dot(c.id, t))
        .child(div().text_size(13).font_medium().child(c.name))
        .child(div().text_size(11).text_color(t.dim).child(`${cards.length}`))
        .child(div().flex_1())
        .when(c.id === "backlog" || c.id === "todo", (e) => e.child(this.iconButton(`add-${c.id}`, "plus", `New card in ${c.name}`, () => this.openCard(null, c.id), t))))
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
        .children(c.waiting.map((w) => h_flex().gap(5).items_start().text_size(11.5).text_color(t.muted)
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
        .child(div().pl(8).border_l(2).border_color(t.blocked).text_size(12).text_color(t.foreground).child(c.review))
        .child(h_flex().flex_wrap().gap(6)
          .child(this.button(`done-${c.id}`, "Mark done", (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: "done" }), t))
          .child(this.button(`redo-${c.id}`, "Send back", (cx) => this.act(cx, "POST", `/cards/${c.id}/move`, { column: "todo" }), t)))))
      .when(c.column !== "todo" && c.column !== "backlog", (e) => e.child(div().text_size(10.5).text_color(t.dim).child(`${COLUMNS.find((x) => x.id === c.column).name} ${ago(c.movedAt)}`)));
  }

  // ---- The card dialog ----

  initEditor(p) {
    this.cardId = p.edit ?? null;
    this.title = InputState.new({ placeholder: "What should be done" });
    this.prompt = TextareaState.new({ placeholder: "Details for the orchestrator: context, where to look, what done means", rows: 9 });
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
      .child(field("Prompt", frame(Textarea.new(this.prompt).h(170).py(8).text_size(12.5))))
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
      .when(Boolean(c?.review), (e) => e.child(div().pl(8).border_l(2).border_color(t.blocked).text_size(12).child(c.review)))
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

  render() {
    const t = theme();
    if (this.mode === "board") return this.renderBoard(t);
    if (this.mode === "edit") return this.renderEditor(t);
    if (this.mode === "settings") return this.renderSettings(t);
    return this.renderSide(t);
  }
}
