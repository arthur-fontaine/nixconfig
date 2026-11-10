import assert from "node:assert/strict";
import { test } from "node:test";
import { plan, orderTodo, FACTORS, type Factor, type SchedulerContext } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type Card, type OrchestratorStatus } from "../src/types.ts";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
let n = 0;
const card = (o: Partial<Card> = {}): Card => ({
  id: `k${++n}`, title: "t", prompt: "p", project: "repo-a", priority: 1,
  estimate: 10_000, estimating: false, factors: { ramGB: 0, exclusive: [], notes: "" },
  column: "todo", createdAt: NOW - HOUR, updatedAt: NOW - HOUR, movedAt: NOW - HOUR,
  startedAt: null, orchestrator: null, review: null, waiting: [], error: null, ...o,
});
const ctx = (cards: Card[], o: Partial<SchedulerContext> = {}, status: Record<string, OrchestratorStatus> = {}): SchedulerContext => ({
  now: NOW, settings: { ...DEFAULT_SETTINGS }, cards, freeRamGB: 32,
  orchestratorStatus: (p) => status[p] ?? "missing", ...o,
});
const ids = (cs: Card[]) => cs.map((c) => c.id);

test("To-do is ordered by priority, then age", () => {
  const a = card({ priority: 1, createdAt: NOW - 3 * HOUR });
  const b = card({ priority: 3, createdAt: NOW - HOUR });
  const c = card({ priority: 1, createdAt: NOW - 5 * HOUR });
  const d = card({ priority: 3, createdAt: NOW - 2 * HOUR, column: "backlog" });
  assert.deepEqual(ids(orderTodo([a, b, c, d])), [b.id, c.id, a.id]);
});

test("the most urgent cards start first, up to the in-progress limit", () => {
  const low = card({ project: "a", priority: 0 });
  const high = card({ project: "b", priority: 3 });
  const mid = card({ project: "c", priority: 2 });
  const busy = card({ project: "d", column: "in_progress", startedAt: NOW - HOUR });
  const { start, waiting } = plan(ctx([low, high, mid, busy]));
  assert.deepEqual(ids(start), [high.id]); // default max 2, one already running
  assert.match(waiting.get(mid.id)!.join(), /in progress/i);
  assert.match(waiting.get(low.id)!.join(), /in progress/i);
});

test("a card waits while its project's orchestrator is busy", () => {
  const running = card({ project: "a", column: "in_progress", startedAt: NOW });
  const next = card({ project: "a" });
  const other = card({ project: "b", createdAt: NOW });
  const r = plan(ctx([running, next, other]));
  assert.deepEqual(ids(r.start), [other.id]);
  assert.match(r.waiting.get(next.id)!.join(), /orchestrator/i);
});

test("an orchestrator working on something else, or blocked, holds its cards back", () => {
  const a = card({ project: "a" }), b = card({ project: "b" }), c = card({ project: "c" });
  const r = plan(ctx([a, b, c], { settings: { ...DEFAULT_SETTINGS, maxInProgress: 5 } }, { a: "working", b: "blocked", c: "idle" }));
  assert.deepEqual(ids(r.start), [c.id]);
  assert.match(r.waiting.get(a.id)!.join(), /working/);
  assert.match(r.waiting.get(b.id)!.join(), /blocked/);
});

test("two cards of one project never start in the same pass", () => {
  const a = card({ project: "a", priority: 2 }), b = card({ project: "a", priority: 1 });
  assert.deepEqual(ids(plan(ctx([a, b])).start), [a.id]);
});

test("a card without a project waits for one", () => {
  const a = card({ project: null });
  assert.match(plan(ctx([a])).waiting.get(a.id)!.join(), /project/i);
});

test("free RAM must stay above the threshold plus what the card needs", () => {
  const light = card({ project: "a", factors: { ramGB: 0, exclusive: [], notes: "" } });
  const heavy = card({ project: "b", priority: 3, factors: { ramGB: 8, exclusive: [], notes: "" } });
  const r = plan(ctx([light, heavy], { freeRamGB: 10 })); // threshold 4 by default
  assert.deepEqual(ids(r.start), [light.id]);
  assert.match(r.waiting.get(heavy.id)!.join(), /RAM/);
  // Started cards are counted against what is left in the same pass.
  const x = card({ project: "c", factors: { ramGB: 3, exclusive: [], notes: "" } });
  const y = card({ project: "d", factors: { ramGB: 3, exclusive: [], notes: "" } });
  assert.deepEqual(ids(plan(ctx([x, y], { freeRamGB: 8 })).start), [x.id]);
});

test("the token budget counts what started in the window", () => {
  const settings = { ...DEFAULT_SETTINGS, tokenBudget: 100_000, budgetWindowHours: 5, maxInProgress: 9 };
  const spent = card({ project: "z", column: "done", startedAt: NOW - HOUR, estimate: 70_000 });
  const old = card({ project: "y", column: "done", startedAt: NOW - 6 * HOUR, estimate: 500_000 });
  const fits = card({ project: "a", estimate: 30_000 });
  const tooBig = card({ project: "b", priority: 3, estimate: 40_000 });
  const r = plan(ctx([spent, old, fits, tooBig], { settings }));
  assert.deepEqual(ids(r.start), [fits.id]);
  assert.match(r.waiting.get(tooBig.id)!.join(), /token/i);
});

test("a card not estimated yet counts as the default estimate", () => {
  const settings = { ...DEFAULT_SETTINGS, tokenBudget: 50_000, defaultEstimate: 60_000 };
  const a = card({ estimate: null });
  assert.match(plan(ctx([a], { settings })).waiting.get(a.id)!.join(), /token/i);
});

test("cards needing the same exclusive resource never run together", () => {
  const sim = { ramGB: 0, exclusive: ["ios-simulator"], notes: "" };
  const running = card({ project: "a", column: "in_progress", startedAt: NOW, factors: sim });
  const wants = card({ project: "b", factors: sim });
  const free = card({ project: "c", createdAt: NOW });
  const r = plan(ctx([running, wants, free], { settings: { ...DEFAULT_SETTINGS, maxInProgress: 5 } }));
  assert.deepEqual(ids(r.start), [free.id]);
  assert.match(r.waiting.get(wants.id)!.join(), /ios-simulator/);
});

test("factors are a list: more can be added", () => {
  const veto: Factor = { name: "weekend", check: (c) => (c.title === "no" ? "not today" : null) };
  const a = card({ title: "no", project: "a" }), b = card({ project: "b" });
  const r = plan(ctx([a, b]), [...FACTORS, veto]);
  assert.deepEqual(ids(r.start), [b.id]);
  assert.deepEqual(r.waiting.get(a.id), ["not today"]);
});
