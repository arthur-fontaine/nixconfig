// Info: the selected Pi session (the focused pane's, else the active tab's), read from its
// JSONL as it grows: context, cache, tool calls, lines changed; and the account's
// usage. The session file comes from the terminal's `pi.session` label (Pi's herdr-session
// extension), else from its title. The figures live in model.js; this view only draws them.
// Four key figures, each opening its detail in place, then the tool calls (spec-3b, "A").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, terminals, exec, home, layout, theme, run, props } from "herdr";
import { readFile } from "fs/promises";
import { infoAge, infoCache, infoContext, infoDuration, infoFeed, infoFiles, infoLastCall, infoLines, infoNewSession, infoParseTitle, infoRunning, infoSessionDir, infoSpan, infoSpark, infoTokens, infoTools, infoUsage, infoUtf8Length } from "./model.js";

const TICK = 1000;
const USAGE_EVERY = 5000;
const CHUNK_BYTES = 4 * 1024 * 1024;
// From byte $2 on: whole lines, up to CHUNK_BYTES; nothing while the file ends mid-line.
const CHUNK = `[ "$(tail -c 1 "$1" | od -An -tx1 | tr -d ' ')" = "0a" ] || exit 0
tail -c +"$2" "$1" | LC_ALL=C awk -v max=${CHUNK_BYTES} '{ print; n += length($0) + 1; if (n >= max) exit }'`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The panel only works while it shows.
function visible() {
  const tree = layout();
  return !find(tree, "panel")?.hidden && find(tree, "panel-body")?.active === "info";
}

// The Pi pane the panel follows: the focused one, else the active tab's.
function selectedPane() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((t) => t.active);
  const ps = panes();
  const pi = (p) => Boolean(p?.terminal) && p.app === "pi";
  const f = focused();
  const own = f?.pane ? ps.find((p) => p.pane === f.pane) : null;
  if (pi(own)) return own;
  return ps.find((p) => p.tab === tab?.id && pi(p)) ?? null;
}

const pct = (r) => (r === null || r === undefined ? "—" : `${Math.round(r * 100)}%`);
const ICON = (name) => `mods/nix-head/icons/${name}.svg`;
const MONO = "JetBrains Mono";
const SHOWN = 200;
const TOOL_ICON = { bash: "terminal", read: "file", edit: "pen", write: "pen", ask: "help-circle", fetch: "globe", agent: "user" };
const LABELS = { usage: "Usage", context: "Context window", activity: "Agent activity", lines: "Lines changed" };
const KINDS = [
  { key: "all", label: "All" },
  { key: "bash", label: "bash", keep: (c) => c.kind === "bash" },
  { key: "read", label: "read", keep: (c) => c.kind === "read" },
  { key: "edit", label: "edit/write", keep: (c) => c.kind === "edit" || c.kind === "write" },
  { key: "ask", label: "ask", keep: (c) => c.kind === "ask" },
  { key: "errors", label: "errors", keep: (c) => c.error === true },
];
// "in 2h 10m" reads as is; days read as words in the sub-lines ("in 4 days").
const days = (msec) => { const d = Math.round(msec / 86400000); return d >= 1 && msec >= 86400000 ? `${d} day${d > 1 ? "s" : ""}` : infoSpan(msec); };
const usageColor = (t, r) => (r >= 0.85 ? t.blocked : r >= 0.6 ? t.ansi3 : t.done);
const contextColor = (t, r) => (r > 0.95 ? t.blocked : r > 0.85 ? t.ansi3 : t.accent);

export default class Info extends View {
  init(_props, cx) {
    this.cx = cx;
    this.session = null; // model state of the file shown
    this.pane = null;
    this.usage = null;
    this.windows = {}; // model id → context window
    this.resolved = new Map(); // terminal + title → session file
    this.loop = false;
    // "usage" | "context" | "activity" | "lines"; a layout may open on one (props.detail).
    this.detail = null;
    this.asked = undefined;
    this.all = false; // every tool call rendered, not just the latest 200
    this.kind = "all"; // the activity detail's filter
    this.handle = cx.focus_handle();
  }

  open(key, cx) {
    this.detail = key;
    this.handle.focus();
    cx.notify();
  }

  back(cx) {
    this.detail = null; this.all = false; this.kind = "all";
    cx.notify();
  }

  // The session file of a Pi pane: its label, else the newest file in its cwd's session
  // folder whose last name is the title's (or the newest when the title has no name).
  async fileOf(p) {
    const label = terminals().find((t) => t.address === p.terminal)?.labels?.["pi.session"];
    if (label) return label;
    const key = `${p.terminal}\0${p.title}`;
    if (this.resolved.has(key)) return this.resolved.get(key);
    const dir = `${home()}/.pi/agent/sessions/${infoSessionDir(p.cwd ?? "")}`;
    const name = infoParseTitle(p.title)?.name ?? "";
    const script = 'ls -t "$1"/*.jsonl 2>/dev/null | head -40 | while read -r f; do'
      + ' [ -z "$2" ] && { echo "$f"; break; };'
      + ` n=$(grep -o '"type":"session_info"[^}]*"name":"[^"]*"' "$f" | tail -1 | sed 's/.*"name":"//; s/"$//');`
      + ' [ "$n" = "$2" ] && { echo "$f"; break; }; done';
    const r = await exec("sh", ["-c", script, "sh", dir, name]).catch(() => null);
    const file = r?.stdout?.trim() || null;
    if (file) this.resolved.set(key, file);
    return file;
  }

  // Reads what the file gained since the last read, in chunks of whole lines (Herdr's
  // readFile gives nothing for a 20 MB session): at most 4 MB each, and only up to a
  // newline, so each chunk is valid UTF-8 and the byte offset stays exact.
  async read(file) {
    if (this.session?.file !== file) this.session = infoNewSession(file);
    const s = this.session;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      const r = await exec("sh", ["-c", CHUNK, "sh", file, String(s.offset + 1)]).catch(() => null);
      if (this.session !== s) return false;
      const text = r?.code === 0 ? r.stdout : "";
      if (!text) break;
      if (infoFeed(s, text, infoUtf8Length(text))) changed = true;
      if (text.length < CHUNK_BYTES / 4) break;
    }
    return changed;
  }

  async readUsage() {
    const text = await readFile(`${home()}/.pi/agent/claude-usage.json`, "utf8").catch(() => null);
    try { this.usageRecord = text ? JSON.parse(text) : null; } catch { this.usageRecord = null; }
    if (!Object.keys(this.windows).length) {
      const store = await readFile(`${home()}/.pi/agent/models-store.json`, "utf8").catch(() => null);
      try {
        for (const provider of Object.values(JSON.parse(store ?? "{}"))) for (const m of provider?.models ?? []) if (m.contextWindow) this.windows[m.id] = m.contextWindow;
      } catch {}
    }
  }

  // One loop for the view's life, started on the first render: every await runs under
  // cx.spawn, so it ends with the view (a promise outliving it crashes Herdr's runtime).
  start() {
    if (this.loop) return;
    this.loop = true;
    this.cx.spawn(async (cx) => {
      let usageAt = 0;
      for (;;) {
        if (visible()) {
          let changed = false;
          const p = selectedPane();
          if (p?.pane !== this.pane?.pane || p?.status !== this.pane?.status) changed = true;
          this.pane = p;
          const file = p ? await this.fileOf(p) : null;
          if (!file && this.session) { this.session = null; changed = true; }
          if (file && (await this.read(file))) changed = true;
          if (Date.now() - usageAt > USAGE_EVERY) { usageAt = Date.now(); await this.readUsage(); changed = true; }
          // Running calls' elapsed time ticks.
          if (changed || (this.session && this.pane?.status === "working")) cx.notify();
        }
        await new Promise((r) => cx.timer.after(TICK, r));
      }
    });
  }

  // ---- pieces --------------------------------------------------------------------------

  spinner(t, size = 12) {
    return svg(ICON("loader")).size(size).flex_none().text_color(t.working).spin(900);
  }

  piTile(t) {
    return div().size(14).flex_none().rounded(3).bg(t.raised).flex().items_center().justify_center()
      .font_family(MONO).font_bold().text_size(10).text_color(t.foreground).child("π");
  }

  bar(t, ratio, color) {
    const r = Math.max(0, Math.min(1, ratio ?? 0));
    return div().h(4).w_full().rounded(2).bg(t.raised).child(div().h(4).rounded(2).bg(color).w(`${(r * 100).toFixed(1)}%`));
  }

  // Values in `muted` among `dim` words: parts are strings (dim) or [text] (muted).
  mixed(t, parts) {
    return h_flex().min_w(0).gap(0).text_size(12).text_color(t.dim).overflow_hidden()
      .children(parts.map((p, i) => div().when(i < parts.length - 1, (e) => e.flex_none()).when(i === parts.length - 1, (e) => e.min_w(0).truncate())
        .text_color(Array.isArray(p) ? t.muted : t.dim).child(Array.isArray(p) ? p[0] : p)));
  }

  // A key figure tile: label, figure + qualifier, optional bar, sub-line; a click opens its detail.
  tile(t, key, label, figure, qualifier, barEl, sub) {
    return h_flex().id(`tile-${key}`).px(16).py(10).gap(10).items_center().border_b(1).border_color(t.border)
      .cursor_pointer().hover((e) => e.bg(t.hover))
      .on_click((_e, cx) => this.open(key, cx))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).font_medium().text_color(t.muted).line_height("16px").child(label))
        .child(h_flex().gap(8).items_baseline().child(figure).child(div().min_w(0).truncate().text_size(13).text_color(t.muted).child(qualifier)))
        .when(Boolean(barEl), (e) => e.child(barEl))
        .when(Boolean(sub), (e) => e.child(sub)))
      .child(svg(ICON("chevron-right")).size(12).flex_none().text_color(t.dim));
  }

  figure(t, text, color = t.foreground) {
    return div().flex_none().text_size(20).font_medium().line_height("22px").text_color(color).child(text);
  }

  section(t, label, meta, top = true) {
    return h_flex().h(28).flex_none().px(16).items_center().when(top, (e) => e.border_t(1).border_color(t.border))
      .child(div().flex_1().text_size(12).text_color(t.muted).child(label))
      .when(Boolean(meta), (e) => e.child(div().text_size(11).text_color(t.dim).child(meta)));
  }

  // A tool call row; `big` is the detail view's taller row.
  toolRow(t, c, now, big = false) {
    const icon = TOOL_ICON[c.kind] ?? "box";
    const prose = c.kind === "ask" || c.kind === "agent";
    const path = c.kind === "read" || c.kind === "edit" || c.kind === "write";
    const opens = (c.kind === "edit" || c.kind === "write") && c.path;
    const arg = div().flex_1().min_w(0).text_color(t.foreground)
      .when(prose, (e) => e.text_size(12.5)).when(!prose, (e) => e.font_family(MONO).text_size(12))
      .when(path, (e) => e.text_ellipsis_start()).when(!path, (e) => e.truncate()).child(c.arg || c.name);
    return h_flex().id(`call-${c.id}`).h(big ? 32 : 28).flex_none().px(big ? 6 : 16).when(big, (e) => e.mx(10).rounded(6)).gap(big ? 10 : 8).items_center()
      .when(c.running, (e) => e.bg(t.hover)).when(!c.running, (e) => e.hover((x) => x.bg(t.hover)))
      .when(Boolean(c.full || c.arg), (e) => e.tooltip(c.full || c.arg))
      .when(Boolean(opens), (e) => e.cursor_pointer().on_click(() => run("tab.new", { mod: "nix-editor", name: c.path.split("/").pop(), props: { file: c.path } })))
      .child(svg(ICON(icon)).size(big ? 13 : 14).flex_none().text_color(t.dim))
      .child(div().w(40).flex_none().text_size(12.5).text_color(c.error ? t.blocked : t.muted).child(c.kind))
      .child(arg)
      .when(c.running, (e) => e.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.working)
        .child(this.spinner(t)).child(infoDuration(now - (c.started ?? now)))))
      .when(!c.running, (e) => e.child(div().w(56).flex_none().text_right().text_size(11).text_color(t.dim).child(infoDuration(c.duration))))
      .when(Boolean(c.error), (e) => e.child(div().size(6).flex_none().rounded(3).bg(t.blocked)));
  }

  toolList(t, running, history, now, big) {
    const shown = this.all ? history : history.slice(0, SHOWN);
    return [
      ...running.map((c) => this.toolRow(t, c, now, big)),
      ...shown.map((c) => this.toolRow(t, c, now, big)),
      ...(history.length > shown.length ? [div().id("show-all").h(24).mx(16).my(4).flex_none().flex().items_center().cursor_pointer()
        .text_size(12).text_color(t.muted).hover((e) => e.text_color(t.foreground))
        .on_click((_e, cx) => { this.all = true; cx.notify(); }).child(`Show all ${history.length}`)] : []),
    ];
  }

  // ---- figures -------------------------------------------------------------------------

  figures(now) {
    const s = this.session, p = this.pane;
    const usage = infoUsage(this.usageRecord, now);
    if (!s) return { usage };
    const window = this.windows[s.model] ?? 1_000_000;
    const working = p?.status === "working";
    const tools = infoTools(s);
    // A call without a result runs only while the agent works (a session that died mid-call keeps one).
    const running = working ? infoRunning(s) : [];
    const history = tools.filter((c) => !running.some((r) => r.id === c.id));
    return {
      usage, window, working, running, history,
      context: infoContext(s, window), cache: infoCache(s), lines: infoLines(s),
      errors: tools.filter((c) => c.error).length, total: tools.length,
      started: s.started !== null && s.requests.length + s.messages > 0,
    };
  }

  // ---- views ---------------------------------------------------------------------------

  usageTile(t, f, now) {
    const u = f.usage, w = u?.fiveHour;
    if (!u || !w) return this.tile(t, "usage", "Usage · 5 h", this.figure(t, "—", t.muted), "no usage reported yet", null, null);
    const qualifier = u.stale ? `${infoAge(now - u.at)} ago` : w.resetsAt ? `resets in ${infoSpan(w.resetsAt - now)}` : "";
    const week = u.sevenDay;
    const sub = u.overage
      ? div().text_size(12).text_color(t.blocked).truncate().child(`Overage on · ${u.overageStatus ?? ""}`)
      : this.mixed(t, week ? ["This week ", [pct(week.ratio)], ...(week.resetsAt ? [` · resets in ${days(week.resetsAt - now)}`] : [])] : [" "]);
    return this.tile(t, "usage", "Usage · 5 h", this.figure(t, pct(w.ratio), u.stale ? t.muted : t.foreground), qualifier,
      this.bar(t, w.ratio, usageColor(t, w.ratio)), sub);
  }

  overview(t, f, now) {
    const s = this.session;
    const rows = [];
    if (!this.pane) {
      rows.push(div().px(16).py(14).border_b(1).border_color(t.border).text_size(13).text_color(t.dim).child("No Pi session in this tab"));
      rows.push(this.usageTile(t, f, now));
      return rows;
    }
    const meta = s && f.started ? [[s.model ?? "model"], " · thinking ", [s.thinking ?? "—"], " · ", [`${s.messages} msgs`], " · ", [infoAge(now - s.started)]] : ["…"];
    rows.push(v_flex().px(16).py(10).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().child(this.piTile(t))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(t.foreground).child(s?.name ?? infoParseTitle(this.pane.title)?.name ?? "Pi"))
        .when(Boolean(f.working), (e) => e.child(this.spinner(t, 14))))
      .child(this.mixed(t, meta)));
    rows.push(this.usageTile(t, f, now));
    if (!s || !f.started) {
      for (const key of ["context", "activity", "lines"]) rows.push(this.tile(t, key, LABELS[key], this.figure(t, "—", t.muted), "", null, this.mixed(t, ["…"])));
      return rows;
    }
    const c = f.context, cache = f.cache;
    rows.push(this.tile(t, "context", "Context window", this.figure(t, c.used === null ? "—" : pct(c.ratio)),
      `${c.used === null ? "—" : infoTokens(c.used)} of ${infoTokens(c.window)} tokens`,
      this.bar(t, c.ratio, contextColor(t, c.ratio)),
      this.mixed(t, [c.compactions ? [`${c.compactions} compaction${c.compactions > 1 ? "s" : ""}`] : "no compaction yet", " · cache hits ", [pct(cache.session)]])));
    const last = infoLastCall(s);
    const since = f.running.reduce((m, r) => Math.min(m, r.started ?? now), now);
    rows.push(this.tile(t, "activity", "Agent activity",
      this.figure(t, f.running.length ? `${f.running.length} running` : "Idle"),
      f.running.length ? `since ${infoDuration(now - since)}` : last ? `last call ${infoAge(now - last)} ago` : "no tool calls yet", null, null));
    const l = f.lines, added = l.rows.reduce((n, r) => n + r.added, 0), removed = l.rows.reduce((n, r) => n + r.removed, 0);
    rows.push(this.tile(t, "lines", "Lines changed",
      l.files ? h_flex().gap(8).child(this.figure(t, `+${added}`, t.ansi2)).child(this.figure(t, `−${removed}`, t.ansi1)) : this.figure(t, "—", t.muted),
      l.files ? `${l.files} file${l.files > 1 ? "s" : ""}` : "", null,
      this.mixed(t, l.rows.length ? l.rows.flatMap((r, i) => [i ? " · " : "", `${r.category} `, [`+${r.added}`]]).filter(Boolean) : ["No edits yet"])));
    rows.push(this.section(t, "Tool calls", f.total ? `${f.total}${f.errors ? ` · ${f.errors} errors` : ""}` : "", false));
    return rows;
  }

  kv(t, key, value, extra) {
    return h_flex().h(30).flex_none().px(16).gap(10).items_center()
      .child(div().w(110).flex_none().text_size(12).text_color(t.muted).child(key))
      .child(value)
      .when(Boolean(extra), (e) => e.child(extra));
  }

  detailView(t, f, now) {
    const s = this.session;
    if (this.detail !== "usage" && (!this.pane || !s || !f.started)) {
      return [div().px(16).py(14).text_size(12).text_color(t.dim).child(this.pane ? "…" : "No Pi session in this tab")];
    }
    switch (this.detail) {
      case "usage": {
        const u = f.usage;
        if (!u) return [div().px(16).py(14).text_size(12).text_color(t.dim).child("No usage reported yet")];
        const row = (label, w) => this.kv(t, label,
          h_flex().flex_1().gap(10).items_center().child(div().flex_1().child(this.bar(t, w.ratio, usageColor(t, w.ratio))))
            .child(div().w(40).text_right().text_size(13).font_medium().text_color(u.stale ? t.muted : t.foreground).child(pct(w.ratio))),
          div().w(70).text_right().text_size(12).text_color(t.dim).child(w.resetsAt ? `in ${infoSpan(w.resetsAt - now)}` : ""));
        return [
          div().h(8),
          ...(u.fiveHour ? [row("This 5 hours", u.fiveHour)] : []),
          ...(u.sevenDay ? [row("This week", u.sevenDay)] : []),
          ...(u.overage ? [this.kv(t, "Overage", div().text_size(12).text_color(t.blocked).child(u.overageStatus ?? "on"))] : []),
          div().px(16).pt(8).text_size(12).text_color(t.dim).child(`Updated ${infoAge(now - (u.at ?? now))} ago`),
        ];
      }
      case "context": {
        if (!s) return [];
        const c = f.context, cache = f.cache;
        const spark = infoSpark(s, f.window, 64);
        return [
          div().h(8),
          h_flex().h(30).px(16).gap(10).items_center().child(div().flex_1().child(this.bar(t, c.ratio, contextColor(t, c.ratio))))
            .child(div().text_size(13).font_medium().child(pct(c.ratio)))
            .child(div().text_size(12).text_color(t.dim).child(`${infoTokens(c.used)} / ${infoTokens(c.window)}`)),
          h_flex().h(20).px(16).gap(1).items_end().children(spark.map((b, i) =>
            div().w(4).flex_none().rounded(1).h(Math.max(1, Math.round(b.ratio * 20)))
              .bg(i === spark.length - 1 ? t.accent : b.afterCompaction ? t.dim : t.input))),
          div().h(8),
          this.kv(t, "Cache hits", h_flex().gap(8).items_baseline().child(div().text_size(13).font_medium().child(pct(cache.session)))
            .child(div().text_size(12).text_color(t.dim).child(`${pct(cache.last)} on the last request`))),
          this.kv(t, "Cache tokens", div().text_size(12).text_color(t.muted).child(`${infoTokens(cache.read)} read · ${infoTokens(cache.written)} written`)),
          this.kv(t, "Compactions", div().text_size(12).text_color(t.muted).child(c.compactions
            ? `${c.compactions}${s.lastCompaction ? ` · last ${infoAge(now - s.lastCompaction)} ago` : ""}` : "none yet")),
        ];
      }
      case "activity": {
        if (!s) return [];
        const keep = KINDS.find((k) => k.key === this.kind)?.keep ?? (() => true);
        const running = f.running.filter(keep), history = f.history.filter(keep);
        const chip = (k) => {
          const on = this.kind === k.key;
          return div().id(`kind-${k.key}`).h(22).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(12)
            .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).when(!on, (e) => e.hover((x) => x.bg(t.hover)))
            .on_click((_e, cx) => { this.kind = k.key; this.all = false; cx.notify(); }).child(k.label);
        };
        return [
          h_flex().h(36).flex_none().px(14).gap(2).items_center().children(KINDS.map(chip)),
          ...(running.length ? [this.section(t, "Running", String(running.length)), ...running.map((c) => this.toolRow(t, c, now, true))] : []),
          this.section(t, "History", `${history.length} calls${f.errors && this.kind === "all" ? ` · ${f.errors} errors` : ""}`),
          ...(history.length ? this.toolList(t, [], history, now, true) : [div().px(16).py(12).text_size(12).text_color(t.dim).child("None")]),
        ];
      }
      case "lines": {
        if (!s) return [];
        const l = f.lines, files = infoFiles(s);
        if (!l.rows.length) return [div().px(16).py(12).text_size(12).text_color(t.dim).child("No edits yet")];
        const num = (text, color, w) => div().w(w).flex_none().text_right().text_size(12).text_color(color).child(text);
        return [
          div().h(6),
          ...l.rows.map((r) => h_flex().h(28).px(16).items_center().text_size(13)
            .child(div().flex_1().text_color(t.foreground).child(r.category))
            .child(num(`${r.files} file${r.files > 1 ? "s" : ""}`, t.dim, 56))
            .child(num(`+${r.added}`, t.ansi2, 52)).child(num(r.removed ? `−${r.removed}` : "", t.ansi1, 52))),
          this.section(t, "Files", String(files.length)),
          ...files.map((x) => h_flex().id(`file-${x.path}`).h(28).flex_none().px(16).gap(8).items_center().cursor_pointer().hover((e) => e.bg(t.hover))
            .on_click(() => run("tab.new", { mod: "nix-editor", name: x.path.split("/").pop(), props: { file: x.path } }))
            .child(div().flex_1().min_w(0).text_ellipsis_start().font_family(MONO).text_size(12).text_color(t.foreground).child(x.rel))
            .child(num(`+${x.added}`, t.ansi2, 44)).child(num(x.removed ? `−${x.removed}` : "", t.ansi1, 44))),
        ];
      }
    }
    return [];
  }

  render() {
    this.start();
    // The view outlives layout edits, so a changed props.detail is taken here.
    const asked = props()?.detail ?? null;
    if (asked !== this.asked) { this.asked = asked; this.detail = asked; }
    const t = theme(), now = Date.now();
    const f = this.figures(now);
    const name = this.session?.name ?? (this.pane ? infoParseTitle(this.pane.title)?.name : null);
    const meta = this.detail === "lines" && this.session ? `from edits · ${f.lines.files} files` : name;
    const header = h_flex().h(36).flex_none().px(16).gap(6).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.detail), (e) => e.child(div().id("info-back").ml(-8).size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip("Back")
        .on_click((_e, cx) => this.back(cx)).child(svg(ICON("chevron-left")).size(13))))
      .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(this.detail ? LABELS[this.detail] : "Info"))
      .when(Boolean(meta), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)));
    const root = v_flex().id("info").track_focus(this.handle).size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.detail) { cx.stop_propagation(); this.back(cx); } })
      .child(header);
    if (this.detail) return root.child(v_flex().id("info-detail").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(this.detailView(t, f, now)));
    const top = this.overview(t, f, now);
    if (!this.session || !f.started) return root.child(v_flex().flex_none().children(top));
    return root.child(v_flex().flex_none().children(top))
      .child(v_flex().id("info-tools").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .children(f.total ? this.toolList(t, f.running, f.history, now, false) : [div().px(16).py(12).text_size(12).text_color(t.dim).child("No tool calls yet")]));
  }
}
