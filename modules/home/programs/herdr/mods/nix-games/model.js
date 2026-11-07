// The games' rules, pure: each takes a state and returns the next one, so main.js only draws
// and feeds keys and time. Nothing here ends a game: a loss is a quiet restart, and there is no
// timer, no lives and no prompt, so a game can be left mid-move and nothing waits to be resumed.
// Names carry a `games` prefix: Nix joins this file into main.js's scope.

// mulberry32: a seeded generator kept in the state, so a step stays a pure function.
export function gamesRand(seed) {
  const next = (seed + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = (v, n) => ((v % n) + n) % n;

// Arrow keys and hjkl, as [dx, dy] (y down).
export const GAMES_DIRS = {
  left: [-1, 0], h: [-1, 0], a: [-1, 0],
  right: [1, 0], l: [1, 0], d: [1, 0],
  up: [0, -1], k: [0, -1], w: [0, -1],
  down: [0, 1], j: [0, 1], s: [0, 1],
};
const ACTION = new Set(["space", "enter"]);

// ---- a) Pop-it: a sheet of bubbles; popping the last one flips the sheet over -------------
// A fidget, not a contest: no timer, no score. The flip is the only reward.

// ms the flip takes; the sheet is edge-on (and swapped for a fresh one) halfway.
export const POP = { flip: 520 };

export function gamesPopNew(cols = 6, rows = 6, round = 0, at = { x: 0, y: 0 }) {
  return { cols, rows, cells: Array(cols * rows).fill(false), x: at.x, y: at.y, round, flip: null };
}

// The cursor wraps at the edges, so a held arrow keeps flowing round the sheet.
export function gamesPopMove(s, dx, dy) {
  return { ...s, x: wrap(s.x + dx, s.cols), y: wrap(s.y + dy, s.rows) };
}

// Presses wait while the sheet turns over.
export function gamesPopPress(s) {
  if (s.flip !== null && s.flip !== undefined) return s;
  const i = s.y * s.cols + s.x;
  if (s.cells[i]) return s;
  const cells = s.cells.slice();
  cells[i] = true;
  return { ...s, cells, flip: cells.every(Boolean) ? 0 : null };
}

// The flip's clock: the fresh sheet replaces the popped one when it is edge-on.
export function gamesPopStep(s, dtMs) {
  if (s.flip === null || s.flip === undefined) return s;
  const flip = s.flip + dtMs;
  const turned = s.flip < POP.flip / 2 && flip >= POP.flip / 2;
  const next = turned ? gamesPopNew(s.cols, s.rows, s.round + 1, { x: s.x, y: s.y }) : s;
  return { ...next, flip: flip >= POP.flip ? null : flip };
}

// How wide the sheet is drawn (1 flat, 0 edge-on) during the flip, eased.
export function gamesPopScale(s) {
  if (s.flip === null || s.flip === undefined) return 1;
  return Math.abs(Math.cos(Math.PI * Math.min(1, s.flip / POP.flip)));
}

export function gamesPopLeft(s) {
  return s.cells.filter((c) => !c).length;
}

// ---- b) Runner: one key jumps; touching an obstacle starts the run over -----------------
// Units: the field is RUN.width wide, y up from the ground.

export const RUN = {
  width: 100, height: 40,
  playerX: 12, playerW: 4, playerH: 5,
  gravity: 300, jump: 100, speed: 40,
  // A press this long before landing still jumps on landing.
  buffer: 0.12,
  gapMin: 34, gapMax: 70,
};

export function gamesRunNew(seed = 1, best = 0) {
  return { y: 0, vy: 0, obstacles: [], next: RUN.width + 20, dist: 0, best, buffered: 0, seed, runs: 0 };
}

export function gamesRunJump(s) {
  if (s.y === 0) return { ...s, vy: RUN.jump, buffered: 0 };
  return { ...s, buffered: RUN.buffer };
}

function runHit(s) {
  const px0 = RUN.playerX, px1 = RUN.playerX + RUN.playerW;
  // A little forgiveness on every side: a graze is not a loss.
  return s.obstacles.some((o) => o.x + 0.6 < px1 && o.x + o.w - 0.6 > px0 && s.y + 0.6 < o.h);
}

function runSub(s, dt) {
  let { y, vy, buffered, dist, next, seed } = s;
  vy -= RUN.gravity * dt;
  y += vy * dt;
  buffered = Math.max(0, buffered - dt);
  if (y <= 0) {
    y = 0; vy = 0;
    if (buffered > 0) { vy = RUN.jump; buffered = 0; }
  }
  const dx = RUN.speed * dt;
  dist += dx;
  next -= dx;
  const obstacles = [];
  for (const o of s.obstacles) if (o.x + o.w - dx > -2) obstacles.push({ ...o, x: o.x - dx });
  if (next <= 0) {
    const a = gamesRand(seed), b = gamesRand(a.seed), c = gamesRand(b.seed);
    seed = c.seed;
    obstacles.push({ x: RUN.width + next, w: 2 + Math.round(a.value * 3), h: 3 + Math.round(b.value * 5) });
    next += RUN.gapMin + c.value * (RUN.gapMax - RUN.gapMin);
  }
  const out = { ...s, y, vy, buffered, dist, next, seed, obstacles };
  if (runHit(out)) return { ...gamesRunNew(seed, Math.max(s.best, dist)), runs: s.runs + 1 };
  return out;
}

export function gamesRunStep(s, dt) {
  let out = s;
  for (let left = dt; left > 1e-9; left -= 1 / 120) out = runSub(out, Math.min(left, 1 / 120));
  return out;
}

// ---- c) Rhythm: notes fall to a line on a steady beat; one key catches them --------------
// A missed note just passes; a stray press costs nothing.

export const BEAT = {
  ms: 60000 / 92,
  lead: 2200, // ms a note takes from the top to the line
  window: 150, // ms either side of the line that still counts
  gone: 400, // ms a note stays past the line
};

export function gamesBeatNew(seed = 1) {
  return { t: 0, notes: [], next: BEAT.lead, seed, hits: 0, streak: 0, id: 0 };
}

export function gamesBeatStep(s, dtMs) {
  const t = s.t + dtMs;
  let { next, seed, id, streak } = s;
  const notes = [];
  for (const n of s.notes) {
    if (n.hit ? t - n.hitAt < 300 : t - n.at < BEAT.gone) notes.push(n);
    else if (!n.hit) streak = 0;
  }
  while (next < t + BEAT.lead) {
    const r = gamesRand(seed);
    seed = r.seed;
    // On the beat mostly, sometimes two eighths, sometimes a rest.
    if (r.value < 0.58) notes.push({ id: id++, at: next, hit: false });
    else if (r.value < 0.78) notes.push({ id: id++, at: next, hit: false }, { id: id++, at: next + BEAT.ms / 2, hit: false });
    next += BEAT.ms;
  }
  return { ...s, t, notes, next, seed, id, streak };
}

export function gamesBeatPress(s) {
  let best = null;
  for (const n of s.notes) {
    if (n.hit) continue;
    const d = Math.abs(n.at - s.t);
    if (d <= BEAT.window && (!best || d < Math.abs(best.at - s.t))) best = n;
  }
  if (!best) return s;
  return {
    ...s, hits: s.hits + 1, streak: s.streak + 1,
    notes: s.notes.map((n) => (n === best ? { ...n, hit: true, hitAt: s.t } : n)),
  };
}

// 0 at the top of the lane, 1 on the line, past 1 below it.
export function gamesBeatPos(n, t) {
  return 1 - (n.at - t) / BEAT.lead;
}

// ---- d) Breakout: arrows move the paddle; a lost ball is served again --------------------
// Units: the field is BRICK.width × BRICK.height, y down.

export const BRICK = {
  width: 100, height: 130,
  cols: 8, rows: 5, top: 12, brickH: 4, gap: 1, side: 4,
  paddleY: 122, paddleW: 20, paddleH: 2.5, paddleSpeed: 95,
  r: 1.5, speed: 62, serve: 0.8,
};

function brickWall() {
  const w = (BRICK.width - 2 * BRICK.side - (BRICK.cols - 1) * BRICK.gap) / BRICK.cols;
  const bricks = [];
  for (let row = 0; row < BRICK.rows; row++) for (let col = 0; col < BRICK.cols; col++) {
    bricks.push({ x: BRICK.side + col * (w + BRICK.gap), y: BRICK.top + row * (BRICK.brickH + BRICK.gap), w, h: BRICK.brickH, row });
  }
  return bricks;
}

export function gamesBrickNew(seed = 1) {
  const px = (BRICK.width - BRICK.paddleW) / 2;
  return { px, bx: px + BRICK.paddleW / 2, by: BRICK.paddleY - BRICK.r, vx: 0, vy: 0, serve: BRICK.serve, bricks: brickWall(), seed, walls: 0, cleared: 0 };
}

// The ball waits on the paddle, then leaves at a slight random angle.
function brickServe(s) {
  const r = gamesRand(s.seed);
  const a = (r.value - 0.5) * 0.8;
  return { ...s, seed: r.seed, vx: BRICK.speed * Math.sin(a), vy: -BRICK.speed * Math.cos(a), serve: 0 };
}

function brickSub(s, dt, dir) {
  const px = clamp(s.px + dir * BRICK.paddleSpeed * dt, 0, BRICK.width - BRICK.paddleW);
  if (s.serve > 0) {
    const serve = s.serve - dt;
    const out = { ...s, px, bx: px + BRICK.paddleW / 2, by: BRICK.paddleY - BRICK.r, serve };
    return serve <= 0 ? brickServe(out) : out;
  }
  let { bx, by, vx, vy } = s;
  bx += vx * dt; by += vy * dt;
  const r = BRICK.r;
  if (bx < r) { bx = r; vx = Math.abs(vx); }
  if (bx > BRICK.width - r) { bx = BRICK.width - r; vx = -Math.abs(vx); }
  if (by < r) { by = r; vy = Math.abs(vy); }
  // The paddle sends the ball off at an angle set by where it lands, so it can be aimed.
  if (vy > 0 && by + r >= BRICK.paddleY && by + r <= BRICK.paddleY + BRICK.paddleH + 2 && bx >= px - r && bx <= px + BRICK.paddleW + r) {
    const off = clamp((bx - (px + BRICK.paddleW / 2)) / (BRICK.paddleW / 2), -1, 1);
    const a = off * 1.05;
    vx = BRICK.speed * Math.sin(a); vy = -BRICK.speed * Math.cos(a);
    by = BRICK.paddleY - r;
  }
  if (by - r > BRICK.height) return { ...s, px, bx: px + BRICK.paddleW / 2, by: BRICK.paddleY - r, vx: 0, vy: 0, serve: BRICK.serve };
  let bricks = s.bricks, cleared = s.cleared;
  const i = bricks.findIndex((b) => bx + r > b.x && bx - r < b.x + b.w && by + r > b.y && by - r < b.y + b.h);
  if (i >= 0) {
    const b = bricks[i];
    const ox = Math.min(bx + r - b.x, b.x + b.w - (bx - r));
    const oy = Math.min(by + r - b.y, b.y + b.h - (by - r));
    if (ox < oy) vx = bx < b.x + b.w / 2 ? -Math.abs(vx) : Math.abs(vx);
    else vy = by < b.y + b.h / 2 ? -Math.abs(vy) : Math.abs(vy);
    bricks = bricks.filter((_, j) => j !== i);
    cleared++;
  }
  const out = { ...s, px, bx, by, vx, vy, bricks, cleared };
  if (!bricks.length) return { ...out, bricks: brickWall(), walls: s.walls + 1, serve: BRICK.serve, vx: 0, vy: 0, bx: px + BRICK.paddleW / 2, by: BRICK.paddleY - r };
  return out;
}

// dir: -1, 0 or 1, from the arrows held.
export function gamesBrickStep(s, dt, dir = 0) {
  let out = s;
  for (let left = dt; left > 1e-9; left -= 1 / 240) out = brickSub(out, Math.min(left, 1 / 240), dir);
  return out;
}

// ---- e) Snake: the field wraps; running into itself starts it over -----------------------
// It waits for an arrow before moving, at first and after each restart.

export const SNAKE = { cols: 16, rows: 16, ms: 150 };

function snakeFood(body, seed) {
  const free = [];
  for (let y = 0; y < SNAKE.rows; y++) for (let x = 0; x < SNAKE.cols; x++) {
    if (!body.some((p) => p.x === x && p.y === y)) free.push({ x, y });
  }
  const r = gamesRand(seed);
  return { food: free[Math.floor(r.value * free.length)] ?? null, seed: r.seed };
}

export function gamesSnakeNew(seed = 1, best = 0) {
  const cx = SNAKE.cols >> 1, cy = SNAKE.rows >> 1;
  const body = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
  const f = snakeFood(body, seed);
  return { body, dir: [1, 0], queue: [], food: f.food, seed: f.seed, acc: 0, moving: false, length: 3, best };
}

// Turns are queued (two at most), so a quick ↑→ between two steps does both.
export function gamesSnakeTurn(s, dir) {
  const last = s.queue.at(-1) ?? s.dir;
  if (s.queue.length >= 2 || (dir[0] === -last[0] && dir[1] === -last[1]) || (dir[0] === last[0] && dir[1] === last[1])) {
    return s.moving ? s : { ...s, moving: true };
  }
  return { ...s, queue: [...s.queue, dir], moving: true };
}

function snakeMove(s) {
  const [dir, ...queue] = s.queue.length ? s.queue : [s.dir];
  const head = { x: wrap(s.body[0].x + dir[0], SNAKE.cols), y: wrap(s.body[0].y + dir[1], SNAKE.rows) };
  const eats = s.food && head.x === s.food.x && head.y === s.food.y;
  const kept = eats ? s.body : s.body.slice(0, -1);
  if (kept.some((p) => p.x === head.x && p.y === head.y)) return gamesSnakeNew(s.seed, Math.max(s.best, s.length));
  const body = [head, ...kept];
  if (!eats) return { ...s, body, dir, queue };
  const f = snakeFood(body, s.seed);
  return { ...s, body, dir, queue, food: f.food, seed: f.seed, length: body.length, best: Math.max(s.best, body.length) };
}

export function gamesSnakeStep(s, dtMs) {
  if (!s.moving) return s;
  let out = { ...s, acc: s.acc + dtMs };
  while (out.acc >= SNAKE.ms && out.moving) {
    const acc = out.acc - SNAKE.ms;
    out = { ...snakeMove(out), acc: 0 };
    out.acc = out.moving ? acc : 0;
  }
  return out;
}

// ---- the picker -------------------------------------------------------------------------

export const GAMES = [
  { id: "pop", label: "Pop", hint: "←↑↓→ / hjkl move · space pops · click pops" },
  { id: "run", label: "Run", hint: "space jumps" },
  { id: "beat", label: "Beat", hint: "space on the line" },
  { id: "bricks", label: "Bricks", hint: "← → / h l move" },
  { id: "snake", label: "Snake", hint: "←↑↓→ / hjkl turn" },
];

export function gamesNew(id, seed = 1) {
  switch (id) {
    case "pop": return gamesPopNew();
    case "run": return gamesRunNew(seed);
    case "beat": return gamesBeatNew(seed);
    case "bricks": return gamesBrickNew(seed);
    case "snake": return gamesSnakeNew(seed);
  }
  return null;
}

// Whether a game moves on its own (and needs the clock); pop only while its sheet flips.
export function gamesAnimated(id, s = null) {
  return id === "pop" ? s?.flip !== null && s?.flip !== undefined : true;
}

// Whether leaving the panel pauses the game (pop has nothing to pause).
export function gamesPausable(id) {
  return id !== "pop";
}

// 1–5 picks, tab and shift-tab cycle: the game to show, or null when the key isn't the picker's.
export function gamesPick(current, keystroke) {
  const i = GAMES.findIndex((g) => g.id === current);
  if (/^[1-9]$/.test(keystroke)) return GAMES[Number(keystroke) - 1]?.id ?? null;
  if (keystroke === "tab") return GAMES[wrap(i + 1, GAMES.length)].id;
  if (keystroke === "shift-tab") return GAMES[wrap(i - 1, GAMES.length)].id;
  return null;
}

// A key for the game shown: its next state, or null when the game doesn't use the key (so it
// can travel on). Breakout reads held arrows in gamesTick instead, but claims them here.
export function gamesKey(id, s, key) {
  const dir = GAMES_DIRS[key];
  switch (id) {
    case "pop":
      if (dir) return gamesPopMove(s, dir[0], dir[1]);
      if (ACTION.has(key)) return gamesPopPress(s);
      return null;
    case "run":
      if (ACTION.has(key) || key === "up" || key === "k" || key === "w") return gamesRunJump(s);
      return null;
    case "beat":
      if (ACTION.has(key) || key === "j" || key === "f") return gamesBeatPress(s);
      return null;
    case "bricks":
      if (dir && dir[1] === 0) return s;
      return null;
    case "snake":
      if (dir) return gamesSnakeTurn(s, dir);
      return null;
  }
  return null;
}

// Advances the game shown by `dtMs`; `held` is the set of keys down (for the paddle).
export function gamesTick(id, s, dtMs, held = new Set()) {
  // A long gap (a stall, a sleep) is not played through.
  const dt = Math.min(dtMs, 100);
  switch (id) {
    case "pop": return gamesPopStep(s, dt);
    case "run": return gamesRunStep(s, dt / 1000);
    case "beat": return gamesBeatStep(s, dt);
    case "bricks": {
      const left = held.has("left") || held.has("h") || held.has("a");
      const right = held.has("right") || held.has("l") || held.has("d");
      return gamesBrickStep(s, dt / 1000, (right ? 1 : 0) - (left ? 1 : 0));
    }
    case "snake": return gamesSnakeStep(s, dt);
  }
  return s;
}
