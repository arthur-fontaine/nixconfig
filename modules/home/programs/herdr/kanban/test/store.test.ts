import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StoreError } from "../src/store.ts";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-store-"));
    try { await fn(dir); } finally {
      // Let the stores' background writes land before the folder goes.
      await new Promise((r) => setTimeout(r, 50));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("cards are created in Backlog with short ids, and survive a reload", withDir(async (dir) => {
  let now = 1000;
  const s = new Store(dir, () => now);
  const a = s.create({ title: "Fix login", prompt: "The login button…", project: "p", priority: 2 });
  const b = s.create({ title: "Second", column: "todo" });
  assert.equal(a.id, "k1");
  assert.equal(b.id, "k2");
  assert.equal(a.column, "backlog");
  assert.equal(b.column, "todo");
  assert.equal(a.createdAt, 1000);
  assert.equal(b.priority, 1);
  await s.flush();
  const again = new Store(dir, () => now);
  assert.deepEqual(again.get("k1"), a);
  assert.equal(again.create({ title: "Third" }).id, "k3");
}));

test("saves are atomic: a temp file renamed over state.json", withDir(async (dir) => {
  const s = new Store(dir);
  s.create({ title: "x" });
  await s.flush();
  assert.deepEqual(readdirSync(dir).sort(), ["state.json"]);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.cards[0].title, "x");
}));

test("a corrupt state file is kept aside, not overwritten", withDir((dir) => {
  writeFileSync(join(dir, "state.json"), "{nope");
  const s = new Store(dir);
  assert.deepEqual(s.cards(), []);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")));
}));

test("moving stamps the time; Review is reachable only through review()", withDir((dir) => {
  let now = 1000;
  const s = new Store(dir, () => now);
  const c = s.create({ title: "x", column: "todo" });
  now = 2000;
  s.move(c.id, "in_progress");
  assert.equal(s.get(c.id)!.movedAt, 2000);
  assert.throws(() => s.move(c.id, "review"), StoreError);
  now = 3000;
  s.review(c.id, "Done: added a test");
  const r = s.get(c.id)!;
  assert.equal(r.column, "review");
  assert.equal(r.review, "Done: added a test");
  assert.equal(r.movedAt, 3000);
}));

test("editing the prompt drops the cached estimate", withDir((dir) => {
  const s = new Store(dir);
  const c = s.create({ title: "x", prompt: "a" });
  s.setEstimate(c.id, 1234, { ramGB: 2, exclusive: ["heavy-build"], notes: "" });
  s.update(c.id, { priority: 3 });
  assert.equal(s.get(c.id)!.estimate, 1234);
  s.update(c.id, { prompt: "b" });
  assert.equal(s.get(c.id)!.estimate, null);
  assert.equal(s.get(c.id)!.factors, null);
}));

test("bad input is refused", withDir((dir) => {
  const s = new Store(dir);
  assert.throws(() => s.create({ title: "" }), StoreError);
  assert.throws(() => s.create({ title: "x", priority: 7 }), StoreError);
  assert.throws(() => s.create({ title: "x", column: "nowhere" as any }), StoreError);
  assert.throws(() => s.update("k404", { title: "y" }), StoreError);
}));

test("every change bumps the version and wakes waiters", withDir(async (dir) => {
  const s = new Store(dir);
  const v = s.version;
  const woke = s.changed(v, 1000);
  s.create({ title: "x" });
  assert.equal(await woke, true);
  assert.ok(s.version > v);
  assert.equal(await s.changed(s.version, 20), false);
}));

test("settings merge and are validated", withDir((dir) => {
  const s = new Store(dir);
  s.setSettings({ maxInProgress: 3, mcpEnabled: true });
  assert.equal(s.settings().maxInProgress, 3);
  assert.equal(s.settings().mcpEnabled, true);
  assert.throws(() => s.setSettings({ maxInProgress: -1 }), StoreError);
  assert.throws(() => s.setSettings({ bogus: 1 } as any), StoreError);
}));
