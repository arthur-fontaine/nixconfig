import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEAT, BRICK, GAMES, RUN, SNAKE,
  gamesAnimated, gamesBeatNew, gamesBeatPress, gamesBeatStep, gamesBrickNew, gamesBrickStep, gamesKey, gamesNew, gamesPick,
  POP, gamesPausable, gamesPopLeft, gamesPopMove, gamesPopNew, gamesPopPress, gamesPopScale, gamesPopStep, gamesRand, gamesRunJump, gamesRunNew, gamesRunStep,
  gamesSnakeNew, gamesSnakeStep, gamesSnakeTurn, gamesTick,
} from "../model.js";

test("rand is deterministic and in [0, 1)", () => {
  const a = gamesRand(42), b = gamesRand(42);
  assert.deepEqual(a, b);
  let seed = 7;
  for (let i = 0; i < 1000; i++) {
    const r = gamesRand(seed);
    assert.ok(r.value >= 0 && r.value < 1);
    seed = r.seed;
  }
});

test("pop: the cursor wraps and a bubble pops once", () => {
  let s = gamesPopNew(3, 2);
  s = gamesPopMove(s, -1, -1);
  assert.deepEqual([s.x, s.y], [2, 1]);
  s = gamesPopPress(s);
  assert.equal(gamesPopLeft(s), 5);
  assert.equal(gamesPopPress(s), s);
});

test("pop: the last bubble flips the sheet over, then a fresh one keeps the cursor", () => {
  let s = gamesPopNew(2, 2);
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0]]) s = gamesPopPress(gamesPopMove(s, dx, dy));
  assert.equal(gamesPopLeft(s), 0);
  assert.equal(s.flip, 0);
  assert.equal(gamesAnimated("pop", s), true);
  assert.equal(gamesPopScale(s), 1);
  // Presses wait while it turns.
  assert.equal(gamesPopPress(s), s);
  s = gamesPopStep(s, POP.flip / 2 - 10);
  assert.equal(s.round, 0);
  assert.ok(gamesPopScale(s) < 0.1);
  s = gamesTick("pop", s, 20);
  assert.equal(s.round, 1);
  assert.equal(gamesPopLeft(s), 4);
  s = gamesPopStep(s, POP.flip);
  assert.equal(s.flip, null);
  assert.equal(gamesPopScale(s), 1);
  assert.equal(gamesAnimated("pop", s), false);
  assert.equal(gamesPopLeft(s), 4);
  assert.equal(s.round, 1);
  assert.deepEqual([s.x, s.y], [0, 1]);
});

test("run: a jump leaves the ground and lands", () => {
  let s = gamesRunJump(gamesRunNew(1));
  assert.ok(s.vy > 0);
  s = gamesRunStep(s, 0.2);
  assert.ok(s.y > 0);
  s = gamesRunJump(s); // in the air: buffered, not a double jump
  assert.ok(s.buffered > 0);
  for (let i = 0; i < 20; i++) s = gamesRunStep(s, 0.05);
  assert.ok(s.y >= 0);
});

test("run: hitting an obstacle restarts quietly and keeps the best", () => {
  let s = { ...gamesRunNew(1), dist: 50, obstacles: [{ x: RUN.playerX, w: 3, h: 6 }], next: 999 };
  s = gamesRunStep(s, 0.01);
  assert.equal(s.runs, 1);
  assert.equal(s.obstacles.length, 0);
  assert.ok(s.best >= 50);
});

test("run: a jump clears the tallest, widest obstacle", () => {
  // Jump just as the obstacle reaches the player's front edge minus the jump's lead.
  let s = { ...gamesRunNew(1), obstacles: [{ x: RUN.playerX + RUN.playerW + 4, w: 5, h: 8 }], next: 999 };
  s = gamesRunJump(s);
  for (let i = 0; i < 40; i++) s = gamesRunStep(s, 0.025);
  assert.equal(s.runs, 0);
});

test("run: obstacles keep coming", () => {
  let s = gamesRunNew(3);
  let seen = 0;
  for (let i = 0; i < 200; i++) { s = gamesRunStep(s, 0.05); seen = Math.max(seen, s.obstacles.length); if (s.y === 0) s = gamesRunJump(s); }
  assert.ok(seen >= 1);
});

test("beat: notes are scheduled ahead on the beat", () => {
  const s = gamesBeatStep(gamesBeatNew(5), 16);
  assert.ok(s.notes.length > 0);
  for (const n of s.notes) assert.ok(n.at >= BEAT.lead && n.at <= s.t + BEAT.lead + BEAT.ms);
});

test("beat: a press on the line catches the nearest note; a stray press costs nothing", () => {
  const s = { ...gamesBeatNew(1), t: 1000, notes: [{ id: 0, at: 1060, hit: false }, { id: 1, at: 1400, hit: false }] };
  const hit = gamesBeatPress(s);
  assert.equal(hit.hits, 1);
  assert.equal(hit.streak, 1);
  assert.ok(hit.notes[0].hit);
  assert.equal(gamesBeatPress(hit), hit);
  const early = { ...s, t: 500 };
  assert.equal(gamesBeatPress(early), early);
});

test("beat: a missed note passes and only resets the streak", () => {
  let s = { ...gamesBeatNew(1), t: 0, streak: 3, next: 1e9, notes: [{ id: 0, at: 10, hit: false }] };
  s = gamesBeatStep(s, BEAT.gone + 50);
  assert.equal(s.notes.length, 0);
  assert.equal(s.streak, 0);
});

test("bricks: the ball is served from the paddle and the paddle follows the arrows", () => {
  let s = gamesBrickNew(1);
  const px = s.px;
  s = gamesBrickStep(s, 0.2, 1);
  assert.ok(s.px > px);
  assert.equal(s.vy, 0);
  s = gamesBrickStep(s, BRICK.serve, 0);
  assert.ok(s.vy < 0);
});

test("bricks: a missed ball is served again, nothing else changes", () => {
  let s = { ...gamesBrickNew(1), serve: 0, bx: 50, by: BRICK.height - 1, vx: 0, vy: 60, px: 0 };
  s = gamesBrickStep(s, 0.1, 0);
  assert.ok(s.serve > 0);
  assert.equal(s.bricks.length, BRICK.cols * BRICK.rows);
});

test("bricks: the ball breaks a brick and bounces", () => {
  const fresh = gamesBrickNew(1);
  const b = fresh.bricks.at(-1);
  let s = { ...fresh, serve: 0, bx: b.x + b.w / 2, by: b.y + b.h + 2, vx: 0, vy: -60 };
  s = gamesBrickStep(s, 0.1, 0);
  assert.equal(s.bricks.length, fresh.bricks.length - 1);
  assert.ok(s.vy > 0);
});

test("bricks: the paddle aims the ball", () => {
  const base = gamesBrickNew(1);
  const at = (off) => gamesBrickStep({ ...base, serve: 0, px: 40, bx: 40 + 10 + off, by: BRICK.paddleY - 3, vx: 0, vy: 60 }, 0.05, 0);
  assert.ok(at(-8).vx < 0);
  assert.ok(at(8).vx > 0);
});

test("bricks: clearing the wall builds a new one", () => {
  const fresh = gamesBrickNew(1);
  const b = fresh.bricks[0];
  let s = { ...fresh, bricks: [b], serve: 0, bx: b.x + b.w / 2, by: b.y + b.h + 2, vx: 0, vy: -60 };
  s = gamesBrickStep(s, 0.1, 0);
  assert.equal(s.walls, 1);
  assert.equal(s.bricks.length, BRICK.cols * BRICK.rows);
});

test("snake: waits for an arrow, then moves and wraps", () => {
  let s = gamesSnakeNew(1);
  assert.equal(gamesSnakeStep(s, 1000), s);
  s = gamesSnakeTurn(s, [0, -1]);
  s = gamesSnakeStep(s, SNAKE.ms);
  assert.deepEqual(s.body[0], { x: SNAKE.cols >> 1, y: (SNAKE.rows >> 1) - 1 });
  s = gamesSnakeStep(s, SNAKE.ms * (SNAKE.rows - 1));
  assert.deepEqual(s.body[0], { x: SNAKE.cols >> 1, y: SNAKE.rows >> 1 });
});

test("snake: can't reverse, and queues two quick turns", () => {
  let s = gamesSnakeTurn(gamesSnakeNew(1), [-1, 0]);
  assert.equal(s.queue.length, 0);
  s = gamesSnakeTurn(gamesSnakeTurn(s, [0, 1]), [-1, 0]);
  assert.deepEqual(s.queue, [[0, 1], [-1, 0]]);
  s = gamesSnakeStep(s, SNAKE.ms * 2);
  assert.deepEqual(s.dir, [-1, 0]);
});

test("snake: eats and grows; biting itself restarts quietly", () => {
  let s = gamesSnakeNew(1);
  const h = s.body[0];
  s = gamesSnakeStep(gamesSnakeTurn({ ...s, food: { x: h.x + 1, y: h.y } }, [1, 0]), SNAKE.ms);
  assert.equal(s.body.length, 4);
  assert.ok(s.food);
  // A ring: the head steps onto its own body.
  const ring = { ...s, body: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 6, y: 4 }], dir: [1, 0], queue: [], moving: true, acc: 0, length: 5, food: { x: 0, y: 0 } };
  const after = gamesSnakeStep(ring, SNAKE.ms);
  assert.equal(after.moving, false);
  assert.equal(after.body.length, 3);
  assert.equal(after.best, 5);
});

test("picker: digits pick, tab cycles both ways", () => {
  assert.equal(gamesPick("pop", "3"), "beat");
  assert.equal(gamesPick("pop", "9"), null);
  assert.equal(gamesPick("snake", "tab"), "pop");
  assert.equal(gamesPick("pop", "shift-tab"), "snake");
  assert.equal(gamesPick("pop", "x"), null);
});

test("every game starts, takes its keys and ticks", () => {
  for (const g of GAMES) {
    let s = gamesNew(g.id, 9);
    assert.ok(s, g.id);
    for (const k of ["space", "left", "up", "j"]) s = gamesKey(g.id, s, k) ?? s;
    for (let i = 0; i < 100; i++) s = gamesTick(g.id, s, 16, new Set(["left"]));
    assert.ok(s, g.id);
    assert.equal(gamesKey(g.id, s, "q"), null);
  }
  assert.equal(gamesAnimated("pop"), false);
  assert.equal(gamesAnimated("run"), true);
  assert.equal(gamesPausable("pop"), false);
  assert.equal(gamesPausable("snake"), true);
});
