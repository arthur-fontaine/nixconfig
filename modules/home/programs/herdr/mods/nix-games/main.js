// Games: micro-breaks while an agent works. Low effort, nothing to remember and nothing to
// resume: no timer, no game over (a loss restarts quietly), no sound, no flashing. A game
// moves only while the panel has the keyboard, so clicking back into a terminal pauses it.
// The rules live in model.js; this view only draws them and feeds keys and time.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { layout, theme, window } from "herdr";
import { BRICK, GAMES, RUN, SNAKE, gamesAnimated, gamesBeatPos, gamesPausable, gamesPopScale, gamesKey, gamesNew, gamesPick, gamesPopLeft, gamesPopPress, gamesTick } from "./model.js";

const FRAME = 33;
const MONO = "JetBrains Mono";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function visible() {
  const tree = layout();
  return !find(tree, "panel")?.hidden && find(tree, "panel-body")?.active === "games";
}

// Theme colours are #rrggbb; a two-digit alpha softens them.
const alpha = (c, a) => (typeof c === "string" && c.length === 7 ? c + a : c);
const box = (x, y, w, h) => div().absolute().left(x).top(y).w(w).h(h);

export default class Games extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const stored = localStorage.getItem("game");
    this.game = GAMES.some((g) => g.id === stored) ? stored : "pop";
    this.states = {};
    this.seed = (Date.now() % 100000) + 1;
    this.held = new Set();
    this.area = { width: 0, height: 0 };
    this.last = null;
    this.wasPlaying = false;
    cx.timer.every(FRAME, (cx) => this.frame(cx));
  }

  state() {
    return (this.states[this.game] ??= gamesNew(this.game, this.seed++));
  }

  playing() {
    return this.handle.is_focused() && window()?.active !== false && visible();
  }

  // The clock: a paused game keeps no time, so nothing jumps when it comes back.
  frame(cx) {
    const playing = this.playing();
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      if (!playing) this.held.clear();
      cx.notify();
    }
    if (!playing || !gamesAnimated(this.game, this.state())) { this.last = null; return; }
    const now = Date.now();
    const dt = this.last === null ? FRAME : now - this.last;
    this.last = now;
    this.states[this.game] = gamesTick(this.game, this.state(), dt, this.held);
    cx.notify();
  }

  pick(id, cx) {
    if (!id || id === this.game) return;
    this.game = id;
    this.last = null;
    localStorage.setItem("game", id);
    cx.notify();
  }

  // Chords with cmd or ctrl are Herdr's and the terminal's; everything else stays here.
  keyDown(e, cx) {
    if (e.modifiers.platform || e.modifiers.control) return;
    const picked = gamesPick(this.game, e.keystroke);
    if (picked) { cx.stop_propagation(); this.pick(picked, cx); return; }
    if (e.key === "escape") return;
    const next = gamesKey(this.game, this.state(), e.key);
    if (next === null) return;
    cx.stop_propagation();
    this.held.add(e.key);
    this.states[this.game] = next;
    cx.notify();
  }

  keyUp(e) {
    this.held.delete(e.key);
  }

  // ---- the games ------------------------------------------------------------------------

  // Unpopped: a full, domed bubble with a highlight. Popped: a flat, hollow dent. The cursor
  // is a ring around its cell. Clearing the sheet turns it over (its width eases to nothing
  // and back) and the next one comes in another colour.
  pop(t, w, h) {
    const s = this.state();
    const hint = 22;
    const pad = 10;
    const size = Math.max(14, Math.floor(Math.min((w - 2 * pad) / s.cols, (h - hint - 2 * pad) / s.rows)));
    const d = Math.round(size * 0.72);
    const sw = size * s.cols + 2 * pad, sh = size * s.rows + 2 * pad;
    const sx = (w - sw) / 2, sy = hint + Math.max(0, (h - hint - sh) / 2);
    const k = gamesPopScale(s);
    const mid = w / 2;
    // x squeezed toward the middle while the sheet flips; y untouched.
    const fx = (x) => mid + (x - mid) * k;
    const hues = [t.accent, t.ansi4, t.ansi6, t.ansi2, t.ansi5, t.ansi3];
    const hue = hues[s.round % hues.length];
    const flipping = s.flip !== null && s.flip !== undefined;
    const kids = [
      div().absolute().left(0).top(0).w(w).h(hint).flex().items_center().justify_center().gap(6).text_size(12)
        .child(div().text_color(t.muted).child("Pop them all · the sheet flips over"))
        .child(div().text_color(t.dim).child(flipping ? "" : `· ${gamesPopLeft(s)} left`)),
      box(fx(sx), sy, Math.max(1, sw * k), sh).rounded(12).bg(alpha(hue, "14")).border_1().border_color(alpha(hue, "40")),
    ];
    if (k > 0.08) for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const i = y * s.cols + x, popped = s.cells[i], cursor = !flipping && x === s.x && y === s.y;
      const cx0 = sx + pad + x * size, cy0 = sy + pad + y * size;
      const bx = fx(cx0 + (size - d) / 2), bw = Math.max(1, d * k);
      if (cursor) kids.push(box(fx(cx0 + 2), cy0 + 2, (size - 4) * k, size - 4).rounded((size - 4) / 2).border_2().border_color(t.foreground));
      kids.push(box(bx, cy0 + (size - d) / 2, bw, d).id(`pop-${i}`).rounded(d / 2).cursor_pointer()
        .when(!popped, (e) => e.bg(alpha(hue, "a6")).border_1().border_color(hue).shadow_sm()
          .hover((x) => x.bg(alpha(hue, "cc")))
          .child(div().absolute().left(bw * 0.24).top(d * 0.18).w(bw * 0.26).h(d * 0.2).rounded(d).bg(alpha(t.foreground, "40"))))
        .when(popped, (e) => e.bg(alpha(t.background, "80")).border_1().border_color(alpha(hue, "33")))
        .on_click((_e, cx) => {
          this.handle.focus();
          this.states.pop = gamesPopPress({ ...this.state(), x, y });
          cx.notify();
        }));
    }
    return { children: kids, status: "" };
  }

  run(t, w, h) {
    const s = this.state();
    const k = w / RUN.width;
    const fh = RUN.height * k;
    const top = Math.max(0, (h - fh) / 2);
    const ground = top + fh;
    const kids = [box(0, ground, w, 1).bg(t.border)];
    for (const o of s.obstacles) kids.push(box(o.x * k, ground - o.h * k, o.w * k, o.h * k).rounded(2).bg(t.input));
    kids.push(box(RUN.playerX * k, ground - (s.y + RUN.playerH) * k, RUN.playerW * k, RUN.playerH * k).rounded(3).bg(t.accent));
    return { children: kids, status: `${Math.floor(s.dist)}${s.best ? ` · best ${Math.floor(s.best)}` : ""}` };
  }

  beat(t, w, h) {
    const s = this.state();
    const lane = Math.min(120, w * 0.5);
    const x0 = (w - lane) / 2;
    const lineY = h * 0.78;
    const d = Math.min(26, lane * 0.45);
    const kids = [
      box(x0, 0, lane, h).rounded(8).bg(alpha(t.background, "99")),
      box(x0 - 12, lineY - 1, lane + 24, 2).rounded(1).bg(t.input),
    ];
    for (const n of s.notes) {
      const y = gamesBeatPos(n, s.t) * lineY;
      if (y < -d) continue;
      const fade = n.hit ? Math.max(0, 1 - (s.t - n.hitAt) / 300) : y > lineY + d ? 0.35 : 1;
      kids.push(box(x0 + (lane - d) / 2, y - d / 2, d, d).rounded(d / 2)
        .bg(n.hit ? t.done : alpha(t.accent, "b3")).opacity(fade));
    }
    return { children: kids, status: `${s.hits} caught${s.streak > 1 ? ` · ${s.streak} in a row` : ""}` };
  }

  bricks(t, w, h) {
    const s = this.state();
    const k = Math.min(w / BRICK.width, h / BRICK.height);
    const ox = (w - BRICK.width * k) / 2, oy = (h - BRICK.height * k) / 2;
    const rows = [t.ansi5, t.ansi4, t.ansi6, t.ansi2, t.ansi3];
    const kids = [box(ox, oy, BRICK.width * k, BRICK.height * k).rounded(6).border_1().border_color(t.border)];
    for (const b of s.bricks) kids.push(box(ox + b.x * k, oy + b.y * k, b.w * k, b.h * k).rounded(2).bg(alpha(rows[b.row % rows.length], "73")));
    kids.push(box(ox + s.px * k, oy + BRICK.paddleY * k, BRICK.paddleW * k, BRICK.paddleH * k).rounded(3).bg(t.muted));
    const r = BRICK.r * k;
    kids.push(box(ox + s.bx * k - r, oy + s.by * k - r, 2 * r, 2 * r).rounded(r).bg(t.accent));
    return { children: kids, status: `${s.cleared} bricks${s.walls ? ` · ${s.walls} walls` : ""}` };
  }

  snake(t, w, h) {
    const s = this.state();
    const c = Math.floor(Math.min(w / SNAKE.cols, h / SNAKE.rows));
    const ox = (w - c * SNAKE.cols) / 2, oy = (h - c * SNAKE.rows) / 2;
    const kids = [box(ox, oy, c * SNAKE.cols, c * SNAKE.rows).rounded(6).bg(alpha(t.background, "99")).border_1().border_color(t.border)];
    if (s.food) kids.push(box(ox + s.food.x * c + c * 0.2, oy + s.food.y * c + c * 0.2, c * 0.6, c * 0.6).rounded(c * 0.3).bg(alpha(t.ansi2, "cc")));
    s.body.forEach((p, i) => kids.push(box(ox + p.x * c + 1, oy + p.y * c + 1, c - 2, c - 2).rounded(3)
      .bg(i === 0 ? t.accent : alpha(t.accent, "8c"))));
    return { children: kids, status: s.moving ? `${s.length}${s.best > 3 ? ` · best ${s.best}` : ""}` : "an arrow to start" };
  }

  // ---- the view -------------------------------------------------------------------------

  render() {
    const t = theme();
    const playing = this.playing();
    const info = GAMES.find((g) => g.id === this.game);
    const chip = (g, i) => {
      const on = g.id === this.game;
      return div().id(`game-${g.id}`).h(22).px(7).flex_none().flex().items_center().gap(5).rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .when(!on, (e) => e.hover((x) => x.bg(t.hover)).active((x) => x.bg(t.selected)))
        .on_click((_e, cx) => { this.handle.focus(); this.pick(g.id, cx); })
        .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(String(i + 1)))
        .child(g.label);
    };
    const { width: w, height: h } = this.area;
    const drawn = w > 0 && h > 0 ? this[this.game](t, w, h) : { children: [], status: "" };
    // A paused game stays in view, dimmed; a click (or any key once focused) takes it back up.
    const paused = !playing && gamesPausable(this.game);
    return v_flex().id("games").track_focus(this.handle).size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .on_key_down((e, cx) => this.keyDown(e, cx))
      .on_key_up((e) => this.keyUp(e))
      .on_mouse_down("left", (_e, cx) => { if (!this.handle.is_focused()) { this.handle.focus(); cx.notify(); } })
      .child(h_flex().h(36).flex_none().px(16).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(13).font_medium().child("Games"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(drawn.status)))
      .child(h_flex().h(36).flex_none().px(12).gap(2).items_center().children(GAMES.map(chip)))
      .child(div().id("games-field").relative().flex_1().min_h(0).mx(16).my(8).overflow_hidden()
        .on_size_change((size, cx) => {
          if (size.width !== this.area.width || size.height !== this.area.height) { this.area = size; cx.notify(); }
        })
        .child(div().absolute().left(0).top(0).size_full().opacity(paused ? 0.45 : 1).children(drawn.children))
        .when(paused, (e) => e.child(div().absolute().left(0).top(0).size_full().flex().items_center().justify_center()
          .child(div().px(10).py(4).rounded(6).bg(t.chrome).border_1().border_color(t.border).text_size(12).text_color(t.muted)
            .child(this.handle.is_focused() ? "Paused" : "Click to play")))))
      .child(h_flex().h(28).flex_none().px(16).items_center().border_t(1).border_color(t.border)
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${info?.hint ?? ""} · 1–5 / tab: game`)));
  }
}
