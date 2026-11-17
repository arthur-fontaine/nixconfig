// Info: the selected Pi session (the focused pane's, else the active tab's), read from its
// JSONL as it grows: context, cache, tool calls, lines changed; and the account's
// usage. The session file comes from the terminal's `pi.session` label (Pi's herdr-session
// extension), else from its title. The figures live in model.js; this view only draws them.
// Four key figures, each opening its detail in place, then the tool calls (spec-3b, "A");
// a selected call opens below the list with its arguments, result and timing.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, terminals, exec, home, layout, theme, run, props, shared, setShared, notify, nextCommand, settings } from "herdr";
import { readFile } from "fs/promises";
import { openInEditor } from "../_lib/editor.js";
import { infoAge, infoCache, infoClock, infoContext, infoDuration, infoEditDiff, infoFeed, infoFiles, infoJsonLines, infoKeep, infoKeyTitles, infoLastCall, infoRows, infoLines, infoNeedsTitles, infoNewSession, infoParseTitle, infoResultLines, infoSessionDir, infoSpan, infoSpark, infoTokens, infoTokensLeft, infoTools, infoUsage, infoUtf8Length, infoViewCommand, infoCallState, infoCounts, INFO_VIEW, infoStatusLine, infoMeterTone, infoPaceText, infoEdited, infoStepsLabel, infoKindCounts, infoGitFiles, infoNavIds, infoListRows, infoMergedRow, infoNum, infoListMeta, infoShowAll, infoRowDuration, infoFolder, infoTones } from "./model.js";
import { tokenize } from "../nix-diff/syntax.js";
import { tipText } from "../_lib/tip.js";
import { CHROME, chromeHeader, chromeRow, chromeSection, chromeTextButton } from "../_lib/chrome.js";

// The editor (../_lib/editor.js) gets the herdr functions it uses.
const HERDR = { spaces, panes, run, shared, setShared, notify };

const TICK = 1000;
const POLL = 100;
const BOUND = 8000;
// The disclosure cell (R2-5): 16 pt wide over a 10 pt column, 3 pt out on each side.
const DISCLOSE = { w: 16, out: 3 };
// The Calls list's › ends at least this far before the overlay scrollbar's thumb (R2-5).
const GUTTER = 4;
// Sessions kept read, for switching between panes.
const KEPT = 6;
const USAGE_EVERY = 5000;
const KEYS_AT_ONCE = 8;
// Herdr interrupts a mod that runs too long between two awaits: a 4 MB chunk (counting its
// bytes, then parsing it) did, on a 40 MB session, and the panel's loop died with it.
const CHUNK_BYTES = 1024 * 1024;
// From byte $2 on: whole lines, up to CHUNK_BYTES, their byte count on stderr; nothing while
// the file ends mid-line.
const CHUNK = `[ "$(tail -c 1 "$1" | od -An -tx1 | tr -d ' ')" = "0a" ] || exit 0
tail -c +"$2" "$1" | LC_ALL=C awk -v max=${CHUNK_BYTES} '{ print; n += length($0) + 1; if (n >= max) exit } END { printf "%d", n > "/dev/stderr" }'`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The panel island's inner radius (its radius less its padding): the content rounds by it, so
// nothing square sits inside a rounded island (0 in a layout without islands).
function panelRadius() {
  const node = find(layout(), "panel");
  return Math.max(0, (Number(node?.radius) || 0) - (Number(node?.padding) || 0));
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
// Commands and code in the terminal's font, as Changes and Files set theirs. Read once per render
// (render() sets it): settings() for each of 200 rows got the render interrupted.
let infoMono = "JetBrains Mono";
const MONO = () => infoMono;
const UI = { div, h_flex, svg };
// Herdr's theme() names colours only: a light theme is one whose background is light.
const infoLight = (t) => { const h = String(t.background ?? "#000").replace("#", ""); return parseInt(h.slice(0, 2), 16) + parseInt(h.slice(2, 4), 16) + parseInt(h.slice(4, 6), 16) > 384; };
const SHOWN = 200;
const TOOL_ICON = { bash: "terminal", read: "file", edit: "pen", write: "pen", ask: "help-circle", fetch: "globe", agent: "user", code: "code" };
const LABELS = { context: "Context window", activity: "Agent activity", lines: "Lines changed", calls: "Calls", files: "Edited files" };
// The activity detail's filters (infoKeep's kinds): a script counts for the calls it made.
// "in 2h 10m" reads as is; days read as words in the sub-lines ("in 4 days").
const days = (msec) => { const d = Math.round(msec / 86400000); return d >= 1 && msec >= 86400000 ? `${d} day${d > 1 ? "s" : ""}` : infoSpan(msec); };

export default class Info extends View {
  init(_props, cx) {
    this.session = null; // model state of the file shown
    this.kept = new Map(); // file → model state, the last few shown: going back shows at once
    this.wake = null; // ends the loop's wait early
    this.pane = null;
    this.usage = null;
    this.windows = {}; // model id → context window
    this.titles = null; // bash-titles.json: codemode scripts' titles by key
    this.titlesStamp = null; // its mtime and size when last read
    this.resolved = new Map(); // terminal + title → session file
    // "context" | "activity" | "lines"; a layout may open on one (props.detail).
    this.detail = null;
    this.asked = undefined;
    this.all = false; // every tool call rendered, not just the latest 200
    this.rev = 0; // bumped when the loop sees a change; keys derived()
    this.kind = "all"; // the activity detail's filter
    Object.assign(this, { from: null, collapsed: [], context: false, outside: false, fill: null });
    this.roots = new Map(); // cwd → its git top (or the cwd), for repo-relative paths
    this.scroll = VirtualListScrollHandle.new(); // the Calls list, put back where it was on Back
    this.git = null; // { key, at, files: path → { status, added, removed }, exact } for the Edited files view
    this.sel = null; // the tool call shown in the inspector
    this.ids = []; // the listed calls' ids, in order, for ↑/↓
    this.area = 0; // height of the list + inspector area
    this.handle = cx.focus_handle();
    // nix-info.detail:<key>, .kind:<key>, .select:<id>, .all, .back: any state by key or script.
    cx.spawn(async (cx) => {
      for (;;) {
        const view = Object.fromEntries(Object.keys(INFO_VIEW).map((k) => [k, this[k]]));
        const next = infoViewCommand(view, await nextCommand(), this.ids);
        if (next) { this.apply(next); cx.notify(); }
      }
    });
    this.start(cx);
  }

  view() { return Object.fromEntries(Object.keys(INFO_VIEW).map((k) => [k, this[k]])); }

  command(c, cx) {
    // The view belongs to the tab shown when it was set (the loop resets it on another tab).
    this.viewTab = selectedPane()?.tab ?? this.viewTab;
    const next = infoViewCommand(this.view(), c, this.ids);
    if (!next) return;
    this.apply(next);
    this.handle.focus();
    cx.notify();
  }

  // State changes here and in the loop; render() only reads (prepare() derives what it shows).
  apply(next) {
    const back = this.detail === "call" && next.detail === "calls";
    // Onto the list from elsewhere, or another filter: its top, not where it was left.
    const top = next.detail === "calls" && !back && (this.detail !== "calls" || next.kind !== this.kind);
    Object.assign(this, next);
    this.prepare();
    // Edited files: git is read now, not at the next tick.
    if (next.detail === "files") this.wake?.();
    // Back onto the list: scrolled to the call it came from, once the list is drawn again (a
    // scroll asked for while it isn't is lost); the loop does it on its next poll.
    if (back) { const i = this.ids.indexOf(this.sel); this.scrollTo = i >= 0 ? i : null; }
    else if (top) this.scrollTo = 0;
  }

  back(cx) { this.command("back", cx); }

  // A call opens over the list it is in (D7).
  select(id, cx) { this.command(`select:${id}`, cx); }

  // ↑/↓ through the listed calls (in a call: the previous or next one); Esc goes back.
  key(e, cx) {
    if (e.key === "escape" && this.detail) { cx.stop_propagation(); this.back(cx); return; }
    if ((e.key === "up" || e.key === "down") && this.ids.length && (this.detail === "call" || this.detail === "calls")) {
      cx.stop_propagation();
      if (!this.sel || !this.ids.includes(this.sel)) { this.sel = this.ids[0]; cx.notify(); return; }
      this.command(e.key === "down" ? "next" : "prev", cx);
      if (this.detail === "calls") this.scroll.scroll_to_item(this.ids.indexOf(this.sel), "center");
    }
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
    const r = await this.bounded(exec("sh", ["-c", script, "sh", dir, name]));
    const file = r?.stdout?.trim() || null;
    if (file) this.resolved.set(key, file);
    return file;
  }

  // Reads what the file gained since the last read, in chunks of whole lines (Herdr's
  // readFile gives nothing for a 20 MB session): at most 4 MB each, and only up to a
  // newline, so each chunk is valid UTF-8 and the byte offset stays exact.
  async read(file) {
    if (this.session?.file !== file) {
      this.session = this.kept.get(file) ?? infoNewSession(file);
      this.kept.delete(file);
      this.kept.set(file, this.session);
      if (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value);
    }
    const s = this.session;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      const r = await this.bounded(exec("sh", ["-c", CHUNK, "sh", file, String(s.offset + 1)]));
      if (this.session !== s) return false;
      const text = r?.code === 0 ? r.stdout : "";
      if (!text) break;
      const bytes = Number(r.stderr);
      if (infoFeed(s, text, bytes > 0 ? bytes : infoUtf8Length(text))) changed = true;
      if (text.length < CHUNK_BYTES / 4) break;
    }
    return changed;
  }

  // bash-titles.json (some 300 KB): read again only when its mtime or size changed. Herdr's fs
  // has no stat, hence the process.
  async readTitles() {
    const file = `${home()}/.pi/agent/bash-titles.json`;
    const r = await this.bounded(exec("stat", ["-f", "%m %z", file]));
    const stamp = r?.code === 0 ? r.stdout.trim() : null;
    if (stamp === this.titlesStamp) return;
    this.titlesStamp = stamp;
    const text = stamp ? await this.bounded(readFile(file, "utf8")) : null;
    try { this.titles = text ? JSON.parse(text) : null; } catch { this.titles = null; }
  }

  async readUsage() {
    const text = await this.bounded(readFile(`${home()}/.pi/agent/claude-usage.json`, "utf8"));
    try { this.usageRecord = text ? JSON.parse(text) : null; } catch { this.usageRecord = null; }
    if (this.session && infoNeedsTitles(this.session)) await this.readTitles();
    if (!Object.keys(this.windows).length) {
      const store = await this.bounded(readFile(`${home()}/.pi/agent/models-store.json`, "utf8"));
      try {
        for (const provider of Object.values(JSON.parse(store ?? "{}"))) for (const m of provider?.models ?? []) if (m.contextWindow) this.windows[m.id] = m.contextWindow;
      } catch {}
    }
  }

  // One loop for the view's life, spawned in init() with init's cx: every await runs under
  // cx.spawn, so it ends with the view (a promise outliving it crashes Herdr's runtime). Spawned
  // from render() through a kept cx, it stopped at its first await on a fresh view until some
  // command came: the panel stayed on "Loading session…".
  start(cx) {
    cx.spawn(async (cx) => {
      // An exec or readFile Herdr never settles (seen when the mod reloads as tabs are relabelled)
      // would stop this loop for good: each gives up after BOUND, as if it had failed, and the
      // next tick tries again. A late result is dropped.
      this.bounded = (promise) => Promise.race([Promise.resolve(promise).catch(() => null), new Promise((r) => cx.timer.after(BOUND, () => r(null)))]);
      let usageAt = 0, readAt = 0;
      for (;;) {
        // The selection is checked every POLL (memory only), the file read every TICK or
        // as soon as another pane is selected.
        if (this.scrollTo != null && this.detail === "calls") { this.scroll.scroll_to_item(this.scrollTo, this.scrollTo ? "center" : "top"); this.scrollTo = null; cx.notify(); }
        const p = visible() ? selectedPane() : undefined;
        const moved = p !== undefined && (p?.pane !== this.pane?.pane || p?.status !== this.pane?.status);
        if (p !== undefined && (moved || Date.now() - readAt >= TICK)) {
          readAt = Date.now();
          let changed = moved;
          // Filter, selection and Show all stay with the tab, until another one is shown (D10).
          if (p && p.tab !== this.viewTab) { if (this.viewTab !== undefined) Object.assign(this, { ...INFO_VIEW, fill: this.fill, context: this.context }); this.viewTab = p.tab; }
          this.pane = p;
          const file = p ? await this.fileOf(p) : null;
          if (p?.cwd && !this.roots.has(p.cwd)) {
            const r = await this.bounded(exec("git", ["rev-parse", "--show-toplevel"], { cwd: p.cwd }));
            this.roots.set(p.cwd, r?.code === 0 ? r.stdout.trim() : p.cwd);
          }
          if (!file && this.session) { this.session = null; changed = true; }
          if (file && (await this.read(file))) changed = true;
          // The session's figures are shown as soon as they are read, before usage and titles.
          let shown = false;
          if (changed) { this.rev++; this.prepare(); cx.notify(); changed = false; shown = true; }
          if (Date.now() - usageAt > USAGE_EVERY) { usageAt = Date.now(); await this.readUsage(); changed = true; }
          // A few keys per continuation; the view is redrawn once all are keyed. Another pane
          // selected stops it (the rest is keyed when this one shows again).
          for (const s = this.session; this.titles && s && this.session === s && selectedPane()?.pane === p?.pane && infoKeyTitles(s, KEYS_AT_ONCE);) {
            changed = true;
            await new Promise((r) => cx.timer.after(1, r));
          }
          // The Edited files view's git figures, every few seconds while it shows.
          if (this.detail === "files" && this.session && (!this.git || this.git.key !== this.session.file || Date.now() - this.git.at > 5000)) { await this.loadGit(); changed = true; }
          // What render() shows from the session is derived here, not in render() (see derive()).
          if (changed) this.rev++;
          this.prepare();
          // Running calls' elapsed time ticks.
          if (changed || shown || (this.session && this.pane?.status === "working")) cx.notify();
        }
        await new Promise((r) => { this.wake = r; cx.timer.after(POLL, r); });
        this.wake = null;
      }
    });
  }

  // ---- pieces --------------------------------------------------------------------------

  spinner(t, size = 12) {
    return svg(ICON("loader")).size(size).flex_none().text_color(t.working).spin(900);
  }

  // Pi's program mark as Herdr draws it (the shipped mark when the pane's program isn't at hand).
  piMark(t) {
    const p = this.pane?.program?.icon ? this.pane.program : { icon: "icons/pi.svg", tint: true };
    return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).w(14).h(14).flex_none();
  }

  section(t, label, meta, _top = true, onClick = null) {
    return chromeSection(UI, t, `section-${label}`, label, meta, onClick);
  }

  // ---- redesign pieces (decisions.md) ---------------------------------------------------

  // The tab's working clock: Herdr's, since when an agent in it works.
  workingSince() {
    for (const sp of spaces()) for (const tab of sp.tabs ?? []) if (tab.id === this.pane?.tab) return tab.working_since ?? null;
    return null;
  }

  root() {
    const cwd = this.session?.cwd ?? this.pane?.cwd;
    return (cwd && this.roots.get(cwd)) ?? cwd ?? null;
  }

  // D1: π, the session's name, a spinner while working; the status line under it.
  statusBlock(t, f, now) {
    const s = this.session;
    const status = this.pane?.status ?? null;
    const line = s && f.tools ? infoStatusLine({ status, since: this.workingSince(), state: s, tools: f.tools ?? [], now }) : { tone: "idle", text: "Loading session…" };
    const tip = s && f.tools ? `${s.prompts} prompt${s.prompts === 1 ? "" : "s"}, ${s.replies} repl${s.replies === 1 ? "y" : "ies"}${s.started ? ` · started ${infoAge(now - s.started)} ago` : ""}` : null;
    const color = line.tone === "waiting" ? t.blocked : line.tone === "working" ? t.foreground : t.muted;
    return v_flex().id("status").px(CHROME.headerX).pt(12).gap(2).when(Boolean(tip), (e) => e.tooltip(tip))
      .child(h_flex().gap(8).items_center().child(this.piMark(t))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(s?.name ?? infoParseTitle(this.pane?.title)?.name ?? "Pi"))
        .when(line.tone === "working", (e) => e.child(this.spinner(t, 13))))
      .child(div().pl(22).min_w(0).truncate().text_size(12).text_color(color).child(line.text));
  }

  // D2: label + % and a right text on one line, a full-width 4 px bar under; neutral, warning
  // from 80 %, error from 95 %; the pace notch. `expand`: the Context meter's chevron and click.
  meter(t, id, { label, ratio, right, pace = null, tip = null, expand = null }) {
    const tone = infoMeterTone(ratio ?? 0);
    const fill = tone === "error" ? t.blocked : tone === "warning" ? t.ansi3 : t.tones.fill;
    const r = Math.max(0, Math.min(1, ratio ?? 0));
    // R2-7: an expandable meter's chevron follows its value ("Context 6% ›"), so every label
    // starts at the same edge.
    const head = h_flex().gap(6).items_center().text_size(12)
      .child(div().flex_none().text_color(t.muted).child(label))
      .child(div().flex_none().font_medium().text_color(tone === "normal" ? t.foreground : fill).child(pct(ratio)))
      .when(Boolean(expand), (e) => e.child(svg(ICON(expand?.open ? "chevron-down" : "chevron-right")).size(12).flex_none().ml(2).text_color(t.chevron)))
      .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.muted).child(right ?? ""));
    // R2-4: the pace notch is 8 pt tall on the 4 pt bar, so 2 pt of it shows on the island above
    // and below whatever the fill.
    // Beside the bar, not in it: the rounded bar clips what it holds.
    const bar = div().relative().h(8).w_full()
      .child(div().absolute().top(2).left(0).right(0).h(4).rounded(2).bg(t.tones.track).child(div().h(4).rounded(2).bg(fill).w(`${(r * 100).toFixed(1)}%`)))
      .when(pace !== null && pace !== undefined, (e) => e.child(div().absolute().top(0).h(8).w(1).bg(t.tones.notch).left(`${(Math.max(0, Math.min(1, pace)) * 100).toFixed(1)}%`)));
    return v_flex().id(id).px(CHROME.rowX).py(4).gap(5).rounded(CHROME.radius)
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(expand), (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).on_click(expand.onClick))
      .child(head).child(bar);
  }

  limits(t, f, now) {
    const s = this.session, u = f.usage, out = [];
    if (s && f.started) {
      const c = f.context, cache = f.cache;
      const known = Boolean(this.windows[s.model]);
      out.push(this.meter(t, "meter-context", { label: "Context", ratio: c.ratio, right: `${infoTokens(c.used)} / ${known ? infoTokens(c.window) : `${infoTokens(c.window)} assumed`}`,
        tip: known ? `${infoTokens(c.window)} window for ${s.model}` : `Window size unknown for ${s.model}: 1M assumed`,
        expand: { open: this.context, onClick: (_e, cx) => { this.context = !this.context; cx.notify(); } } }));
      if (this.context) {
        const comp = c.compactions ? `Compacted ${c.compactions === 1 ? "once" : `${c.compactions} times`}${s.lastCompaction ? `, ${infoAge(now - s.lastCompaction)} ago` : ""}` : "Not compacted yet";
        out.push(v_flex().id("context-more").pl(CHROME.rowX).pb(4).gap(2).text_size(12).text_color(t.muted)
          .child(div().child(`Cache hits ${pct(cache.session)} (last request ${pct(cache.last)})`))
          .child(div().child(`Cache: ${infoTokens(cache.read)} read, ${infoTokens(cache.written)} written`))
          .child(div().child(comp)));
      }
    }
    const win = (key, label, w, length) => {
      if (!w) return null;
      const left = infoTokensLeft(w.left, key === "week" ? "weekly" : "5-hour");
      const resets = w.resetsAt ? `resets in ${key === "week" ? days(w.resetsAt - now) : infoSpan(w.resetsAt - now)}` : "";
      const right = [infoPaceText(w.ahead), resets, u.stale ? `as of ${infoAge(now - (u.at ?? now))} ago` : null].filter(Boolean).join(" · ");
      return this.meter(t, `meter-${key}`, { label, ratio: w.ratio, right, pace: w.pace, tip: left?.tip ?? null });
    };
    if (u) out.push(...[win("five", "5-hour limit", u.fiveHour), win("week", "Week", u.sevenDay)].filter(Boolean));
    else out.push(div().px(CHROME.rowX).py(4).text_size(12).text_color(t.dim).child("Limits not reported yet"));
    // R2-7, ink to ink: 24 pt from the status line, 14 pt from one meter's bar to the next label.
    return v_flex().id("limits").px(CHROME.insetX).pt(10.5).children(out);
  }

  // O3: "Edited N files ›" (in the repo; "at least" when an edit kept no path).
  editedRow(t) {
    const e = this.session ? this.edited() : null;
    if (!e) return null;
    const n = e.files.length;
    const text = !n && !e.atLeast ? "No files edited yet" : `Edited ${e.atLeast ? "at least " : ""}${n} file${n === 1 ? "" : "s"}`;
    const go = n || e.outside.length || e.atLeast ? (_e, cx) => this.command("detail:files", cx) : null;
    // 24 pt under the last bar: a new group.
    return div().px(CHROME.insetX).pt(11).child(chromeRow(UI, t, "edited", { onClick: go })
      .child(svg(ICON("file-text")).size(14).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(go ? t.foreground : t.muted).child(text))
      .when(e.outside.length > 0, (x) => x.child(div().flex_none().text_size(12).text_color(t.dim).child(`+${e.outside.length} outside`)))
      .when(Boolean(go), (x) => x.child(svg(ICON("chevron-right")).size(12).flex_none().text_color(t.chevron))));
  }

  // D5: a call as a row: [disclosure] icon, the one thing that tells it apart (a path sans as
  // name + folder, a command or code mono, a title or question sans), the failure dot (filled:
  // it failed; hollow: a script went on after a failed step), the duration, a chevron.
  // R2-6: a file as its name and a short muted folder (infoFolder): the name never truncates
  // before the folder, which is capped at 40 % and cut at its end. The whole path in the tooltip.
  fileText(t, path, fg = t.foreground) {
    const f = infoFolder(path, this.root(), home());
    return h_flex().id(`path-${path}`).flex_1().min_w(0).gap(6).items_baseline().tooltip(f.tip)
      .child(div().flex_none().max_w("100%").truncate().text_color(fg).child(f.name))
      .child(div().flex_1().min_w(0).max_w("40%").truncate().text_size(12).text_color(t.muted).child(f.folder));
  }

  callRow(t, c, { on = false, onClick = null, disclose = null, more = null, inList = false } = {}) {
    const state = infoCallState(c, this.pane?.status === "working");
    const root = this.root();
    // R2-3, the type rule: what the text names decides its face. A script's own text names what
    // its one call names (argKind): a file, a command, a line of its code, or a list of calls.
    const fileKind = (k) => k === "read" || k === "edit" || k === "write";
    const file = c.titled || c.placeholder ? null
      : fileKind(c.kind) && c.path ? c.path
      : c.kind === "code" && fileKind(c.argKind) && c.arg ? (c.arg.startsWith("/") || !root ? c.arg : `${root}/${c.arg}`) : null;
    const untitled = c.untitled && c.nested?.length ? infoStepsLabel(c.steps ?? c.nested) : null;
    const command = !c.titled && (c.kind === "bash" || c.kind === "fetch" || (c.kind === "code" && (c.argKind === "bash" || c.argKind === "code")));
    const unknown = !TOOL_ICON[c.kind];
    // A parent kept only for its matching steps reads as context (R2-2).
    const fg = c.context ? t.muted : t.foreground;
    const sans = (color, s) => div().flex_1().min_w(0).truncate().text_color(color).child(s);
    const text = more ? div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(more)
      : c.placeholder ? sans(t.muted, c.arg)
      : file ? this.fileText(t, file, fg)
      : untitled ? sans(t.muted, untitled)
      : c.kind === "code" && c.argKind === "calls" && !c.titled ? sans(t.muted, c.arg)
      : unknown && !c.titled ? h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().flex_none().text_color(fg).child(c.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.arg ?? ""))
      : command ? div().flex_1().min_w(0).truncate().font_family(MONO()).text_size(12.5).text_color(fg).child(c.arg || c.name)
      : sans(fg, c.arg || c.name);
    const KIND = { code: "Script", bash: "Bash", read: "Read", edit: "Edit", write: "Write", ask: "Question", fetch: "Fetch", agent: "Agent" };
    return chromeRow(UI, t, `call-${c.id}`, { on, onClick: inList ? null : onClick, clickable: inList || Boolean(onClick) })
      // In the Calls list the › clears the overlay scrollbar's thumb by GUTTER (R2-5).
      .when(inList, (e) => e.pr(CHROME.rowX + GUTTER + 1))
      .when(Boolean(c.full || c.arg) && !more, (e) => e.tooltip(tipText(c.merged ? `${c.tip}\n${c.full || c.arg}` : `${KIND[c.kind] ?? c.name}: ${c.full || c.arg}`)))
      .when(c.level === 1, (e) => e.child(div().w(10).h_full().flex_none().child(div().ml(4).w(1).h_full().bg(t.tones.guide))))
      // R2-5: the disclosure is its own 16 × 26 cell with its own hover fill, over the 10 pt column
      // (3 pt each side), so the text column stays put; listClick's x test uses the same bounds.
      .child(div().w(DISCLOSE.w).h(CHROME.row).ml(-DISCLOSE.out).mr(-DISCLOSE.out).flex_none().flex().items_center().justify_center().rounded(CHROME.radius)
        // R2-1: a script merged with its one step: the script's marker, muted, no action of its own.
        .when(Boolean(c.merged), (e) => e.child(svg(ICON(TOOL_ICON.code)).size(10).text_color(t.dim)))
        .when(Boolean(disclose), (e) => e.id(`toggle-${c.id}`).cursor_pointer().hover((x) => x.bg(t.selected)).when(!inList, (x) => x.on_click(disclose.onClick))
          .child(svg(ICON(disclose.open ? "chevron-down" : "chevron-right")).size(10).text_color(t.chevron))))
      .when(!more, (e) => e.child(svg(ICON(TOOL_ICON[c.kind] ?? "box")).size(14).flex_none().text_color(t.dim)))
      .child(text)
      .when(Boolean(c.failed), (e) => e.child(div().size(6).flex_none().rounded(3).bg(t.blocked)))
      .when(!c.failed && Boolean(c.stepFailed), (e) => e.child(div().id(`hollow-${c.id}`).size(6).flex_none().rounded(3).border_1().border_color(t.blocked).tooltip("Went on after a failed step")))
      .when(!more, (e) => e.child(div().flex_none().min_w(28).text_right().text_size(12).text_color(t.muted)
        .when(state === "done" && (c.duration === null || c.duration === undefined), (x) => x.id(`time-${c.id}`).tooltip("No timing recorded"))
        .child(state === "running" ? this.spinner(t) : state === "no-result" ? "No result" : infoRowDuration(c.duration))))
      .when(Boolean(onClick) || inList, (e) => e.child(svg(ICON("chevron-right")).size(10).flex_none().text_color(t.chevron)));
  }

  // O1: the last 8 calls, a script's steps under it (the first 3, then "+N steps").
  recentCalls(t, f) {
    const rows = [];
    for (const c of [...(f.running ?? []), ...(f.history ?? [])].slice(0, 8)) {
      const merged = infoMergedRow(c);
      if (merged) { rows.push(this.callRow(t, merged, { on: this.sel === c.id, onClick: (_e, cx) => this.select(c.id, cx) })); continue; }
      const open = !this.collapsed.includes(c.id);
      rows.push(this.callRow(t, { ...c, level: 0 }, { on: this.sel === c.id, onClick: (_e, cx) => this.select(c.id, cx),
        disclose: c.nested?.length ? { open, onClick: (_e, cx) => { cx.stop_propagation(); this.collapsed = open ? [...this.collapsed, c.id] : this.collapsed.filter((x) => x !== c.id); this.prepare(); cx.notify(); } } : null }));
      if (!open || !c.nested?.length) continue;
      const steps = infoRows([c]).slice(1);
      for (const n of steps.slice(0, 3)) rows.push(this.callRow(t, n, { on: this.sel === n.id, onClick: (_e, cx) => this.select(n.id, cx) }));
      if (steps.length > 3) rows.push(this.callRow(t, { id: `${c.id}-more`, level: 1 }, { more: `+${steps.length - 3} steps`, onClick: (_e, cx) => this.select(c.id, cx) }));
    }
    return rows;
  }

  // ---- Edited files (O3) ---------------------------------------------------------------

  // git's view of the session's files. Lines from git only, never summed from the session: the
  // diff from the commit before the session's first entry to the working tree, so what the
  // session committed counts too, plus its new untracked files. Without such a base, or with a
  // merge since (others' work would count), only git's status letters.
  async loadGit() {
    const s = this.session, root = this.root();
    const key = s.file;
    const git = (...a) => this.bounded(exec("git", a, { cwd: root }));
    const out = (r) => (r?.code === 0 ? r.stdout : "");
    let files = {}, exact = false;
    const base = s.started ? out(await git("rev-list", "-1", `--before=${new Date(s.started).toISOString()}`, "HEAD")).trim() : "";
    const merges = base ? out(await git("rev-list", "--merges", `${base}..HEAD`)).trim() : "x";
    const untracked = out(await git("ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
    if (base && !merges) {
      const edited = new Set(infoEdited(s, root).files.map((f) => f.rel));
      const lines = {};
      for (const p of untracked.filter((p) => edited.has(p)).slice(0, 50)) {
        const r = await this.bounded(exec("wc", ["-l", p], { cwd: root }));
        if (r?.code === 0) lines[p] = Number(r.stdout.trim().split(/\s+/)[0]) || 0;
      }
      files = infoGitFiles(out(await git("diff", "--numstat", base)), out(await git("diff", "--name-status", base)), untracked, lines);
      exact = true;
    } else {
      for (const l of out(await git("status", "--porcelain")).split("\n")) if (l.length > 3) files[l.slice(3)] = { status: l.slice(0, 2).trim()[0] === "?" ? "A" : l.slice(0, 2).trim()[0], added: null, removed: null };
    }
    this.git = { key, at: Date.now(), files, exact };
  }

  filesView(t) {
    const s = this.session;
    if (!s) return [];
    // git's figures of another session (the one shown before) aren't this one's: not loaded yet.
    const git = this.git?.key === s.file ? this.git : null;
    const e = infoEdited(s, this.root()), g = git?.files ?? {};
    const color = { A: t.ansi2, D: t.ansi1, U: t.ansi5, R: t.ansi4 };
    // R2-8: Changes' columns: its checkbox's 14 pt (empty here), the letter, name and folder, +
    // and − right-aligned in fixed columns, then the ›. Outside rows leave letter and +/− empty.
    const row = (f, outside = false) => {
      const st = outside ? null : g[f.rel];
      const known = st && st.added !== null && st.added !== undefined;
      return chromeRow(UI, t, `file-${f.path}`, { onClick: (ev) => openInEditor(HERDR, f.path, { side: ev.modifiers.alt }) })
        .child(div().w(14).flex_none())
        .child(div().w(10).flex_none().font_family(MONO()).text_size(11).font_medium().text_center().text_color(color[st?.status] ?? t.ansi3).child(st?.status ?? ""))
        .child(this.fileText(t, f.path))
        .child(h_flex().flex_none().text_size(11)
          .child(div().w(34).text_right().text_color(known ? t.ansi2 : t.dim).child(known ? (st.added ? `+${st.added}` : "") : !outside && git && !st ? "unchanged" : ""))
          .child(div().w(20).text_right().text_color(t.ansi1).child(known && st.removed ? `−${st.removed}` : "")))
        .child(svg(ICON("chevron-right")).size(10).flex_none().text_color(t.chevron));
    };
    const n = `${e.files.length} file${e.files.length === 1 ? "" : "s"}`;
    const out = [this.section(t, "In this repo", git?.exact ? `${n} · since session start` : n), ...e.files.map(row)];
    if (e.atLeast) out.push(div().px(CHROME.rowX).py(6).text_size(12).text_color(t.muted).child("Some edits kept no file name: there may be more."));
    if (git && !git.exact) out.push(div().px(CHROME.rowX).py(6).text_size(12).text_color(t.muted).child("Line counts need the commit the session started from: git status only."));
    if (e.outside.length) {
      const open = this.outside;
      out.push(div().pt(8).child(chromeRow(UI, t, "outside", { onClick: (_e, cx) => this.command(open ? "close:outside" : "open:outside", cx) })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none().text_color(t.chevron))
        .child(div().flex_1().text_size(12).font_medium().text_color(t.muted).child(`Outside this repo (${e.outside.length})`))));
      // The same anatomy as the repo's rows, the letter and +/− columns empty (R2-6).
      if (open) for (const f of e.outside) out.push(row(f, true));
    }
    return out;
  }

  // ---- Calls (D6, D10, O1, O2) ------------------------------------------------------------

  // The listed rows: the running calls first, a script's steps under it unless collapsed.
  listRows(f) {
    const key = `${this.kind}|${this.collapsed.join(",")}`;
    return f.list?.key === key ? f.list.rows : this.makeList(f, key);
  }

  makeList(f, key) {
    const keep = (l) => l.map((c) => infoKeep(c, this.kind)).filter(Boolean);
    return infoListRows([...keep(f.running ?? []), ...keep(f.history ?? [])], this.collapsed);
  }

  // A row of the virtual list: no handlers (its rows are rebuilt each frame); the list's
  // on_item_click acts, a click on the disclosure column (by where the pointer went down)
  // collapsing the script, elsewhere opening the call.
  listRow(t, r) {
    const open = !this.collapsed.includes(r.id);
    return this.callRow(t, r, { on: this.sel === r.id, inList: true, disclose: r.level === 0 && r.nested?.length ? { open } : null });
  }

  listClick(id, cx) {
    const r = this.listed?.find((x) => x.id === id);
    if (!r) return;
    if (r.level === 0 && r.nested?.length && (this.pointerX ?? 99) < CHROME.rowX - DISCLOSE.out + DISCLOSE.w) this.command(`toggle:${id}`, cx);
    else this.select(id, cx);
  }

  callsView(t, f) {
    const n = f.kinds ?? infoKindCounts([]);
    const CHIPS = [["all", "All"], ["bash", "bash"], ["read", "read"], ["edit", "edit/write"], ["ask", "ask"], ["failed", "failed"]];
    const chip = ([key, label]) => {
      const on = this.kind === key;
      return div().id(`kind-${key}`).h(24).px(8).gap(5).flex_none().flex().items_center().rounded(CHROME.radius).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).when(!on, (e) => e.hover((x) => x.bg(t.hover)).active((x) => x.bg(t.selected)))
        .on_click((_e, cx) => this.command(`kind:${key}`, cx))
        .child(div().child(label)).child(div().text_color(key === "failed" ? t.blocked : t.dim).child(String(n[key])));
    };
    const rows = this.listRows(f), shown = this.all ? rows : rows.slice(0, SHOWN);
    const label = CHIPS.find(([k]) => k === this.kind)?.[1] ?? "All";
    const list = shown.length
      ? div().id("calls-box").flex_1().min_h(0).relative()
        .child(div().id("calls-frame").size_full()
          // Where a click lands (the list's click knows only the row): x for the disclosure column.
          .on_mouse_down("left", (e) => { this.pointerX = e.local_position?.x ?? 99; })
          .child(v_virtual_list("info-calls", shown.length, CHROME.row, (i) => shown[i].id, (range) => shown.slice(range.start, range.end).map((r) => this.listRow(t, r)))
            .track_scroll(this.scroll).on_item_click((key, cx) => this.listClick(key, cx)).size_full()))
        .child(Scrollbar.vertical("info-calls").absolute().inset_0())
      : v_flex().px(CHROME.rowX).py(8).gap(8).items_start().text_size(12).text_color(t.dim)
        .child(div().child(this.kind === "failed" ? "No call failed in this session." : `No ${label} calls in this session.`))
        .child(chromeTextButton(UI, t, "show-all-calls", "Show all calls", (_e, cx) => this.command("kind:all", cx)));
    return v_flex().flex_1().min_h(0).px(CHROME.insetX).py(CHROME.insetY)
      .child(h_flex().flex_none().flex_wrap().gap(2).pb(4).children(CHIPS.filter(([k]) => k === "all" || k === this.kind || n[k] > 0).map(chip)))
      .child(this.section(t, this.kind === "all" ? "All calls" : label, infoListMeta(shown.length, rows.length, rows.filter((r) => r.context).length)))
      .child(list);
  }

  showAllAction(t, f) {
    const rows = this.listRows(f);
    return rows.length > SHOWN && !this.all ? [chromeTextButton(UI, t, "show-all", infoShowAll(rows.length), (_e, cx) => this.command("all", cx), "The list shows the latest 200 rows")] : [];
  }

  // ---- a call, pushed over its list (D7) ---------------------------------------------------

  rel(path) {
    const root = this.root();
    return path && root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  }

  tinted(t, text, lang) {
    const syn = { keyword: t.ansi5, string: t.ansi2, number: t.ansi3, constant: t.ansi3, function: t.ansi4, type: t.ansi6, property: t.ansi1, comment: t.dim, operator: t.ansi6, punctuation: t.muted };
    return this.code(t, String(text).replace(/\n$/, "").split("\n").slice(0, 400).map((l) => this.line(t, { bare: true,
      text: h_flex().flex_1().min_w(0).flex_wrap().children(tokenize(l, lang).map((p) => div().text_color(p.kind ? syn[p.kind] ?? t.foreground : t.foreground).child(p.text))),
    })));
  }

  callView(t, f, now) {
    const c = this.selected(f);
    if (!c) return [div().px(CHROME.headerX).py(12).text_size(12).text_color(t.dim).child("This call isn't in the session any more.")];
    const state = infoCallState(c, this.pane?.status === "working");
    const took = infoRowDuration(c.duration);
    const meta = state === "running" ? "Running" : state === "no-result" ? "No result"
      : [took ? `Took ${took}` : "No timing recorded", c.startedExact ? `started ${infoClock(c.startedExact, false)}` : null, c.level === 0 && c.finished ? `finished ${infoClock(c.finished, false)}` : null].filter(Boolean).join(" · ");
    const untitled = c.untitled && c.nested?.length ? infoStepsLabel(c.steps ?? c.nested) : null;
    const title = c.path ? this.rel(c.path) : untitled ?? c.arg ?? c.name;
    const args = c.args ?? {};
    const out = [
      div().px(CHROME.headerX).pt(12).font_medium().text_color(untitled ? t.muted : t.foreground).when(Boolean(c.path), (e) => e.tooltip(c.path)).child(title),
      h_flex().px(CHROME.headerX).pt(2).gap(8).text_size(12).text_color(t.muted).child(meta)
        .when(Boolean(c.failed), (e) => e.child(div().text_color(t.blocked).child("Failed")))
        .when(!c.failed && Boolean(c.stepFailed), (e) => e.child(div().text_color(t.blocked).child("Went on after a failed step"))),
    ];
    if (c.kind === "code" && typeof args.code === "string") out.push(this.label(t, "Code"), this.tinted(t, args.code, "js"));
    if (c.kind === "bash" && typeof args.command === "string") out.push(this.label(t, "Command"), this.tinted(t, args.command, "sh"));
    if (c.kind === "edit") {
      const numbered = Boolean(c.diff?.lines.length);
      const diff = numbered ? c.diff.lines : infoEditDiff(args);
      const sign = { "-": ["−", t.ansi1], "+": ["+", t.ansi2] };
      if (diff.length) out.push(this.label(t, "Change"), this.code(t, diff.map((l) => this.line(t, { marker: sign[l.sign]?.[0] ?? "", markerColor: sign[l.sign]?.[1] ?? t.dim,
        ...(numbered && { num: l.num }), text: l.text, color: l.text === "⋯" ? t.dim : t.foreground, tint: sign[l.sign] ? sign[l.sign][1] + "14" : undefined }))));
    }
    if (c.nested?.length) {
      out.push(this.label(t, "Steps", String(c.nested.length)));
      out.push(v_flex().px(CHROME.insetX).children(infoRows([c]).slice(1).map((n) => this.callRow(t, { ...n, level: 0 }, { onClick: (_e, cx) => this.select(n.id, cx) }))));
    }
    // The rest as key/value rows, paths relative to the repo; long text as a block.
    const skip = new Set(c.kind === "code" ? ["code"] : c.kind === "bash" ? ["command"] : c.kind === "edit" ? ["edits", "oldText", "newText", "path"] : c.path ? ["path"] : []);
    const rest = Object.entries(args).filter(([k]) => !skip.has(k));
    if (rest.length) {
      out.push(this.label(t, "Arguments"));
      for (const [k, v] of rest) {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        if (typeof v === "string" && v.includes("\n")) { out.push(div().px(CHROME.headerX).pt(4).text_size(12).text_color(t.muted).child(k), this.tinted(t, v, null)); continue; }
        out.push(h_flex().px(CHROME.headerX).py(3).gap(10).items_start().text_size(12)
          .child(div().w(70).flex_none().text_color(t.muted).child(k))
          .child(div().flex_1().min_w(0).font_family(MONO()).text_color(t.foreground).when(k === "path", (e) => e.tooltip(text)).child(k === "path" ? this.rel(text) : text)));
      }
    }
    if (state === "done") {
      const r = infoResultLines(c.result ?? "");
      const extra = r.more ? `+${r.more} more lines` : c.resultCut ? "cut at 64 KB" : r.lines.length > 1 ? `${r.lines.length} lines` : "";
      out.push(this.label(t, c.failed ? "Error" : "Result", extra),
        (c.result ?? "") === "" ? div().px(CHROME.headerX).py(4).text_size(12).text_color(t.dim).child("Nothing")
          : this.code(t, r.lines.map((l) => this.line(t, { bare: true, text: l, color: c.failed ? t.blocked : t.foreground }))));
    }
    return out;
  }

  callActions(t, f) {
    const c = this.selected(f), at = this.ids.indexOf(this.sel);
    const icon = (id, glyph, tip, cmd, on) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(CHROME.radius).text_size(13)
      .when(on, (e) => e.cursor_pointer().text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).active((x) => x.bg(t.selected)).on_click((_e, cx) => this.command(cmd, cx)))
      .when(!on, (e) => e.text_color(t.dim)).tooltip(tip).child(glyph);
    const opens = c && (c.kind === "edit" || c.kind === "write" || c.kind === "read") && c.path;
    return [
      icon("call-prev", "↑", "Previous call (↑)", "prev", at > 0),
      icon("call-next", "↓", "Next call (↓)", "next", at >= 0 && at < this.ids.length - 1),
      ...(opens ? [chromeTextButton(UI, t, "call-open", "Open", (e) => openInEditor(HERDR, c.path, { line: c.diff?.from ?? null, side: e.modifiers.alt }), c.path)] : []),
    ];
  }

  // ---- inspector: the selected call in full ----------------------------------------------

  code(t, children) {
    return v_flex().mx(CHROME.headerX).px(10).py(8).rounded(CHROME.radius).bg(t.tones.code).when(infoLight(t), (e) => e.border_1().border_color(t.border))
      .font_family(MONO()).text_size(12).line_height("18px").children(children);
  }

  label(t, text, extra) {
    return h_flex().h(CHROME.section).flex_none().px(CHROME.headerX).pt(8).gap(8).items_center()
      .child(div().flex_1().text_size(12).font_medium().text_color(t.muted).child(text))
      .when(Boolean(extra), (e) => e.child(div().text_size(12).text_color(t.muted).child(extra)));
  }

  // One payload line: a 16px marker column, an optional number column, and the text, which
  // wraps inside its own column so continuations hang under the text, not the marker.
  // Diff lines tint the whole row, wrapped parts included.
  line(t, { marker = "", markerColor = t.dim, num, text, color = t.foreground, tint, bare = false }) {
    return h_flex().w_full().items_start().when(Boolean(tint), (e) => e.bg(tint))
      // R2-7: Code and Result text starts at the block's 10 pt padding, as Change's marker does.
      .when(!bare, (e) => e.child(div().w(16).flex_none().text_color(markerColor).child(marker || " ")))
      .when(num !== undefined, (e) => e.child(div().w(30).pr(8).flex_none().text_right().text_color(t.dim).child(num === null ? "" : String(num))))
      .child(typeof text === "string" ? div().flex_1().min_w(0).text_color(color).child(text || " ") : text);
  }

  selected(f) {
    if (!this.sel || !this.session) return null;
    const byId = f.byId ?? new Map(infoRows([...(f.running ?? []), ...(f.history ?? [])]).map((c) => [c.id, c]));
    return byId.get(this.sel) ?? null;
    // (sub-rows carry their kind's path; level tells a step from a call)
  }

  // ---- figures -------------------------------------------------------------------------

  figures(now) {
    const usage = infoUsage(this.usageRecord, now);
    const f = this.derived();
    return f ? { ...f, usage } : { usage };
  }

  // What the session gives, worked out in the loop and in apply() once per change, and only read
  // by render(): a long session's derivation (1 400 rows, some 25 ms under Herdr) in a render
  // got the view interrupted, and an interrupted render leaves an idle tab's frame stale.
  memoKey() {
    return this.session ? `${this.rev}|${this.session.file}|${this.pane?.status}|${this.root()}` : null;
  }

  // The same session's figures from the last tick stand in until the next one (under a second);
  // none yet reads as loading. Never derived here: a cut render leaves an idle tab's frame stale.
  derived() {
    return this.memo && this.memo.f.file === this.session?.file ? this.memo.f : null;
  }

  prepare() {
    const key = this.memoKey();
    if (!key) { this.memo = null; this.ids = []; this.listed = []; return; }
    if (this.memo?.key !== key) this.memo = { key, f: this.derive() };
    const f = this.memo.f, list = `${this.kind}|${this.collapsed.join(",")}`;
    if (f.list?.key !== list) f.list = { key: list, rows: this.makeList(f, list) };
    // What the list shows, and what ↑/↓ walk: that list, or the overview's recent calls.
    this.listed = this.all ? f.list.rows : f.list.rows.slice(0, SHOWN);
    this.ids = infoNavIds(this.view(), this.listed, [...f.running, ...f.history].slice(0, 8));
  }

  derive() {
    const s = this.session, p = this.pane;
    const window = this.windows[s.model] ?? 1_000_000;
    const working = p?.status === "working";
    const tools = infoTools(s, this.titles);
    // A call without a result runs only while the agent works (a session that died mid-call keeps one).
    const running = working ? tools.filter((c) => c.running) : [];
    const history = tools.filter((c) => !running.some((r) => r.id === c.id));
    const n = infoCounts(tools);
    const f = {
      file: s.file, window, working, running, history, tools, kinds: infoKindCounts(tools),
      context: infoContext(s, window), cache: infoCache(s), errors: n.failed, total: n.calls,
      started: s.started !== null && s.requests.length + s.messages > 0,
      list: null, byId: new Map(infoRows([...running, ...history]).map((c) => [c.id, c])), edited: infoEdited(s, this.root()),
    };
    return f;
  }

  edited() {
    return this.derived()?.edited ?? null;
  }

  // ---- views ---------------------------------------------------------------------------

  // D1–D4, O1–O3: status, limits, edited files, recent calls; spacing instead of dividers but one
  // above the calls.
  overview(t, f, now) {
    // D11: what the panel needs, said plainly; the limits are the account's, so they stay.
    if (!this.pane) {
      return [v_flex().px(CHROME.headerX).pt(14).gap(4)
        .child(div().font_medium().text_color(t.foreground).child("This tab isn't running Pi"))
        .child(h_flex().flex_wrap().text_size(12).text_color(t.muted)
          .child(div().child("Start "))
          .child(div().px(4).rounded(4).bg(t.raised).font_family(MONO()).text_color(t.foreground).child("pi"))
          .child(div().child(" in the terminal to see its activity here."))),
        this.limits(t, f, now)];
    }
    const top = [this.statusBlock(t, f, now), this.limits(t, f, now)];
    const edited = this.editedRow(t);
    if (edited) top.push(edited);
    return top;
  }

  render() {
    infoMono = settings().font_family ?? "JetBrains Mono";
    // Herdr renders the view when focus or tabs change: a new pane is read now, not at the
    // next tick (up to a second later).
    if (this.wake && visible() && selectedPane()?.pane !== this.pane?.pane) this.wake();
    // The view outlives layout edits, so a changed props.detail is taken here.
    const asked = props()?.detail ?? null;
    if (asked !== this.asked) { this.asked = asked; this.detail = asked; }
    // R2-4: the quiet colours (meters, chevrons, guides, code) from the theme, to contrast targets.
    const base = theme(), tones = infoTones(base), t = { ...base, tones, chevron: tones.chevron }, now = Date.now();
    const f = this.figures(now);
    // The header names the model, not the session again (D8).
    const s = this.session;
    const meta = s?.model ? [s.model.replace(/^claude-/, ""), s.thinking ? `thinking ${s.thinking}` : null].filter(Boolean).join(" · ") : null;
    const KIND = { code: "Script", bash: "Bash", read: "Read", edit: "Edit", write: "Write", ask: "Question", fetch: "Fetch", agent: "Agent" };
    const call = this.detail === "call" ? this.selected(f) : null;
    const title = this.detail === "call" ? KIND[call?.kind] ?? call?.name ?? "Call" : LABELS[this.detail] ?? "Info";
    const actions = this.detail === "calls" ? this.showAllAction(t, f) : this.detail === "call" ? this.callActions(t, f)
      : this.detail === "files" ? [chromeTextButton(UI, t, "show-changes", "Show in Changes", () => run("layout.select", { stack: "panel-body", child: "changes" }), "Line counts, staging and commits")] : [];
    const header = chromeHeader(UI, t, { id: "info-head", title, meta: this.detail ? null : meta, back: this.detail ? (cx) => this.back(cx) : null, actions });
    // fill: the corner check's (nix-info.fill:<color>), so the content's own corners show.
    const root = v_flex().id("info").track_focus(this.handle).size_full().min_h(0).rounded(panelRadius()).overflow_hidden().bg(this.fill ?? t.chrome).text_color(t.foreground).text_size(CHROME.text)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(header);
    if (this.detail === "calls") return root.child(this.callsView(t, f));
    if (this.detail === "call") return root.child(v_flex().id("info-call").flex_1().min_h(0).overflow_y_scrollbar().pb(12).children(this.callView(t, f, now)));
    if (this.detail === "files") return root.child(v_flex().id("info-files").flex_1().min_h(0).overflow_y_scrollbar().px(CHROME.insetX).py(CHROME.insetY).children(this.filesView(t)));
    const top = this.overview(t, f, now);
    if (!this.session || !f.started) return root.child(v_flex().flex_none().children(top));
    const calls = f.total ? `${infoNum(f.total)} call${f.total === 1 ? "" : "s"}${f.errors ? ` · ${infoNum(f.errors)} failed` : ""}` : null;
    return root.child(v_flex().flex_none().children(top))
      .child(v_flex().id("info-recent").flex_1().min_h(0).mt(5.5).border_t(1).border_color(t.border).overflow_y_scrollbar().px(CHROME.insetX).py(CHROME.insetY)
        .child(this.section(t, "Recent calls", calls, true, f.total ? (_e, cx) => this.command("detail:calls", cx) : null))
        .children(f.total ? this.recentCalls(t, f) : [div().px(CHROME.rowX).py(8).text_size(12).text_color(t.dim).child("Calls appear here as the agent works.")]));
  }
}
