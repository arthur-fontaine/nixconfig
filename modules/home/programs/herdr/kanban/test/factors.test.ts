import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kanban } from "../src/kanban.ts";
import { Store, StoreError } from "../src/store.ts";
import { localApi } from "../src/local-api.ts";
import type { Ask } from "../src/estimator.ts";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-factors-"));
    try { await fn(dir); } finally {
      await new Promise((r) => setTimeout(r, 50));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const SONNET = '{"tokens": 400000, "ramGB": 6, "exclusive": ["ios-simulator", "heavy-build"], "notes": "an iOS build"}';

// A kanban that never reaches Herdr; Sonnet answers what `answer` holds, when `gate` lets it.
function kanban(dir: string, o: { answer?: () => string; ask?: Ask } = {}) {
  const started: string[] = [];
  const k = new Kanban({
    dir, log: () => {}, ram: async () => 64,
    ask: o.ask ?? (async () => (o.answer ?? (() => SONNET))()),
    herdr: {
      ls: async () => null,
      send: async () => { throw new Error("no"); },
      start: async (p) => { started.push(p.key); return { terminal: `t-${started.length}`, name: p.name, space: "s" }; },
    },
  });
  return { k, started };
}

const sized = (s: Store, title = "x") => {
  const c = s.create({ title, prompt: "p" });
  s.setEstimate(c.id, 400_000, { ramGB: 6, exclusive: ["ios-simulator", "heavy-build"], notes: "an iOS build" });
  return c.id;
};

test("the estimate and factors can be edited, and are marked as edited", withDir((dir) => {
  const s = new Store(dir);
  const id = sized(s);
  const c = s.update(id, { estimate: 250_000, factors: { exclusive: ["heavy-build"] } });
  assert.equal(c.estimate, 250_000);
  assert.deepEqual(c.factors!.exclusive, ["heavy-build"]);
  assert.equal(c.factors!.ramGB, 6);
  assert.equal(c.factors!.notes, "an iOS build");
  assert.deepEqual([...c.factors!.manual!].sort(), ["estimate", "exclusive"]);
  s.update(id, { factors: { ramGB: 0 } });
  assert.equal(s.get(id)!.factors!.ramGB, 0);
  assert.deepEqual([...s.get(id)!.factors!.manual!].sort(), ["estimate", "exclusive", "ramGB"]);
}));

test("saving the same values marks nothing", withDir((dir) => {
  const s = new Store(dir);
  const id = sized(s);
  s.update(id, { title: "y", estimate: 400_000, factors: { ramGB: 6, exclusive: ["heavy-build", "ios-simulator"] } });
  assert.equal(s.get(id)!.factors!.manual, undefined);
  // A card not sized yet keeps no factors when nothing is set.
  const b = s.create({ title: "b" });
  s.update(b.id, { title: "bb" });
  assert.equal(s.get(b.id)!.factors, null);
}));

test("exclusive names are deduplicated", withDir((dir) => {
  const s = new Store(dir);
  const id = sized(s);
  assert.deepEqual(s.update(id, { factors: { exclusive: ["docker", "docker", "my-gpu"] } }).factors!.exclusive, ["docker", "my-gpu"]);
}));

test("bad estimates and factors are refused", withDir((dir) => {
  const s = new Store(dir);
  const id = sized(s);
  const bad: any[] = [
    { estimate: 0 }, { estimate: -5 }, { estimate: 1.5 }, { estimate: "250k" }, { estimate: null }, { estimate: 1e9 },
    { factors: null }, { factors: [] }, { factors: { ramGB: -1 } }, { factors: { ramGB: 513 } }, { factors: { ramGB: "2" } },
    { factors: { exclusive: "ios-simulator" } }, { factors: { exclusive: ["iOS Simulator"] } }, { factors: { exclusive: [""] } },
    { factors: { exclusive: ["x".repeat(41)] } }, { factors: { exclusive: [3] } }, { factors: { notes: "mine" } }, { factors: { manual: [] } },
  ];
  for (const b of bad) assert.throws(() => s.update(id, b), StoreError, JSON.stringify(b));
  assert.equal(s.get(id)!.estimate, 400_000);
  // A new card has no estimate to edit yet.
  assert.throws(() => s.create({ title: "n", estimate: 5 } as any), StoreError);
}));

test("a prompt change still drops the estimate, edited values included", withDir((dir) => {
  const s = new Store(dir);
  const id = sized(s);
  s.update(id, { factors: { exclusive: [] } });
  s.update(id, { prompt: "something else" });
  assert.equal(s.get(id)!.estimate, null);
  assert.equal(s.get(id)!.factors, null);
}));

test("a background estimate keeps the edited values", withDir(async (dir) => {
  const s = new Store(dir);
  const c = s.create({ title: "x" });
  // Edited before Sonnet answered: only RAM.
  s.update(c.id, { factors: { ramGB: 1 } });
  s.setEstimate(c.id, 400_000, { ramGB: 6, exclusive: ["ios-simulator"], notes: "n" });
  const f = s.get(c.id)!.factors!;
  assert.equal(s.get(c.id)!.estimate, 400_000);
  assert.equal(f.ramGB, 1);
  assert.deepEqual(f.exclusive, ["ios-simulator"]);
  assert.deepEqual(f.manual, ["ramGB"]);
}));

test("the daemon's background estimate never overwrites an edit made while Sonnet was thinking", withDir(async (dir) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { k } = kanban(dir, { ask: async () => { await gate; return SONNET; } });
  const c = k.create({ title: "x", prompt: "p" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(k.store.get(c.id)!.estimating, true);
  k.update(c.id, { estimate: 50_000, factors: { exclusive: [] } });
  release();
  await new Promise((r) => setTimeout(r, 20));
  const after = k.store.get(c.id)!;
  assert.equal(after.estimating, false);
  assert.equal(after.estimate, 50_000);
  assert.deepEqual(after.factors!.exclusive, []);
  assert.equal(after.factors!.ramGB, 6); // not edited: Sonnet's
  assert.equal(after.factors!.notes, "an iOS build");
}));

test("Estimate again replaces the edited values with Sonnet's", withDir(async (dir) => {
  const { k } = kanban(dir);
  const id = sized(k.store);
  k.update(id, { estimate: 50_000, factors: { exclusive: [] } });
  k.reestimate(id);
  await new Promise((r) => setTimeout(r, 20));
  const c = k.store.get(id)!;
  assert.equal(c.estimate, 400_000);
  assert.deepEqual(c.factors!.exclusive, ["ios-simulator", "heavy-build"]);
  assert.equal(c.factors!.manual, undefined);
}));

test("PATCH /api/cards/:id takes the estimate and factors, and refuses bad ones", withDir(async (dir) => {
  const { k } = kanban(dir);
  const id = sized(k.store);
  const server = localApi(k, { onSettings: async () => {}, mcp: () => ({ enabled: false, listening: false, port: 0, error: null }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const patch = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/cards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ok = await patch({ estimate: 250_000, factors: { ramGB: 2, exclusive: ["heavy-build"] } });
    assert.equal(ok.status, 200);
    const c = await ok.json() as any;
    assert.equal(c.estimate, 250_000);
    assert.deepEqual(c.factors.exclusive, ["heavy-build"]);
    assert.equal(c.factors.ramGB, 2);
    const bad = await patch({ factors: { ramGB: 1000 } });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as any).error, /ramGB/);
  } finally {
    k.stop();
    await new Promise((r) => server.close(r));
    await k.settled();
  }
}));

test("a card waiting on ios-simulator starts once that resource is removed", withDir(async (dir) => {
  const { k, started } = kanban(dir);
  k.store.setProjects([{ key: "a", name: "A", root: "/a" }, { key: "b", name: "B", root: "/b" }]);
  k.store.setSettings({ maxInProgress: 5 });
  const holder = k.store.create({ title: "holder", project: "a", column: "in_progress" });
  k.store.setEstimate(holder.id, 10_000, { ramGB: 0, exclusive: ["ios-simulator"], notes: "" });
  const id = sized(k.store, "waits");
  k.store.update(id, { project: "b", column: "todo" });
  await k.tick();
  assert.equal(k.store.get(id)!.column, "todo");
  assert.match(k.store.get(id)!.waiting.join(), /ios-simulator held by/);
  k.update(id, { factors: { exclusive: ["heavy-build"] } });
  await k.settled();
  assert.equal(k.store.get(id)!.column, "in_progress");
  assert.deepEqual(started, ["b"]);
}));

test("state files from before edits load as they are", withDir((dir) => {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    next: 2, settings: {}, projects: [], clients: [],
    cards: [{ id: "k1", title: "old", prompt: "", project: null, priority: 1, estimate: 1000, estimating: false,
      factors: { ramGB: 2, exclusive: ["docker"], notes: "" }, column: "todo", createdAt: 1, updatedAt: 1, movedAt: 1,
      startedAt: null, orchestrator: null, review: null, waiting: [], error: null }],
  }));
  const s = new Store(dir);
  assert.equal(s.get("k1")!.factors!.manual, undefined);
  assert.deepEqual(s.update("k1", { factors: { exclusive: [] } }).factors!.manual, ["exclusive"]);
}));

test("the CLI reads 250k, 1.5M and plain token counts", async () => {
  const { tokenCount } = await import("../src/cli.ts");
  assert.equal(tokenCount("250k"), 250_000);
  assert.equal(tokenCount("1.5M"), 1_500_000);
  assert.equal(tokenCount("120000"), 120_000);
  assert.ok(Number.isNaN(tokenCount("lots")));
});
