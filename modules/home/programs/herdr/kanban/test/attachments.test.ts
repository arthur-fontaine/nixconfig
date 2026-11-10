import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kanban } from "../src/kanban.ts";
import { Store, StoreError } from "../src/store.ts";
import { Attachments, safeName } from "../src/attachments.ts";
import { dispatchText } from "../src/herdr.ts";
import type { Card } from "../src/types.ts";

function withDirs(fn: (state: string, src: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-att-"));
    const state = join(root, "state"), src = join(root, "src");
    mkdirSync(src);
    try { await fn(state, src); } finally {
      await new Promise((r) => setTimeout(r, 50));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

// A kanban that never reaches Herdr or Sonnet.
const kanban = (dir: string) => new Kanban({
  dir, log: () => {}, ram: async () => 64, ask: async () => '{"tokens": 1000}',
  herdr: { ls: async () => null, start: async () => { throw new Error("no"); }, send: async () => { throw new Error("no"); } },
});

const file = (dir: string, name: string, text = "hello") => { const p = join(dir, name); writeFileSync(p, text); return p; };

test("a staged file is copied, the original stays where it was", withDirs(async (state, src) => {
  const k = kanban(state);
  const shot = file(src, "Screenshot 1.png", "PNGDATA");
  const a = await k.attachments.stage(shot);
  assert.match(a.id, /^a[0-9a-f]{12}$/);
  assert.equal(a.name, "Screenshot 1.png");
  assert.equal(a.size, 7);
  assert.equal(a.mime, "image/png");
  assert.ok(a.path.startsWith(join(state, "attachments")));
  assert.equal(readFileSync(a.path, "utf8"), "PNGDATA");
  assert.ok(existsSync(shot));
}));

test("a new card adopts its staged files under attachments/<card id>/", withDirs(async (state, src) => {
  const k = kanban(state);
  const a = await k.attachments.stage(file(src, "a.png"));
  const b = await k.attachments.stage(file(src, "clip.mp4"));
  const c = k.create({ title: "With files", attachments: [a.id, b.id] });
  assert.deepEqual(c.attachments.map((x) => x.name), ["a.png", "clip.mp4"]);
  for (const x of c.attachments) {
    assert.equal(x.path, join(state, "attachments", c.id, x.name));
    assert.ok(existsSync(x.path));
  }
  assert.equal(c.attachments[1].mime, "video/mp4");
  // Staged once, adopted once.
  assert.throws(() => k.create({ title: "again", attachments: [a.id] }), StoreError);
  await k.store.flush();
  assert.deepEqual(new Store(state).get(c.id)!.attachments, c.attachments);
}));

test("saving a card's list adds the staged files and deletes the dropped ones", withDirs(async (state, src) => {
  const k = kanban(state);
  const a = await k.attachments.stage(file(src, "a.png"));
  const b = await k.attachments.stage(file(src, "b.pdf"));
  const c = k.create({ title: "x", attachments: [a.id, b.id] });
  const [ka, kb] = c.attachments;
  const d = await k.attachments.stage(file(src, "a.png", "another"));
  const u = k.update(c.id, { attachments: [kb.id, d.id] });
  assert.deepEqual(u.attachments.map((x) => x.name), ["b.pdf", "a.png"]);
  // The dropped a.png is gone; the new one took its name.
  assert.equal(u.attachments[1].path, ka.path);
  assert.deepEqual(readdirSync(join(state, "attachments", c.id)).sort(), ["a.png", "b.pdf"]);
  assert.ok(existsSync(kb.path));
  assert.equal(readFileSync(u.attachments[1].path, "utf8"), "another");
  // Other edits leave the list alone.
  assert.equal(k.update(c.id, { title: "y" }).attachments.length, 2);
  assert.throws(() => k.update(c.id, { attachments: ["a000000000000"] }), StoreError);
}));

test("two files of one name don't overwrite each other", withDirs(async (state, src) => {
  const k = kanban(state);
  mkdirSync(join(src, "x")); mkdirSync(join(src, "y"));
  const a = await k.attachments.stage(file(join(src, "x"), "shot.png", "1"));
  const b = await k.attachments.stage(file(join(src, "y"), "shot.png", "2"));
  const c = k.create({ title: "x", attachments: [a.id, b.id] });
  assert.deepEqual(c.attachments.map((x) => x.name), ["shot.png", "shot (2).png"]);
  assert.deepEqual(c.attachments.map((x) => readFileSync(x.path, "utf8")), ["1", "2"]);
}));

test("deleting a card deletes its files; unstaging deletes a staged one", withDirs(async (state, src) => {
  const k = kanban(state);
  const a = await k.attachments.stage(file(src, "a.png"));
  const c = k.create({ title: "x", attachments: [a.id] });
  const dir = join(state, "attachments", c.id);
  assert.ok(existsSync(dir));
  k.remove(c.id);
  assert.ok(!existsSync(dir));
  const s = await k.attachments.stage(file(src, "b.png"));
  k.attachments.unstage(s.id);
  assert.ok(!existsSync(s.path));
  assert.throws(() => k.create({ title: "x", attachments: [s.id] }), StoreError);
}));

test("bad sources and ids are refused", withDirs(async (state, src) => {
  const k = kanban(state);
  await assert.rejects(k.attachments.stage("relative.png"), StoreError);
  await assert.rejects(k.attachments.stage(join(src, "missing.png")), StoreError);
  await assert.rejects(k.attachments.stage(src), StoreError); // a folder
  assert.throws(() => k.attachments.unstage("../../state.json"), StoreError);
  assert.throws(() => k.create({ title: "x", attachments: ["../k1"] }), StoreError);
  assert.throws(() => k.create({ title: "x", attachments: "a.png" as any }), StoreError);
  const big = new Attachments(join(state, "small"), 4);
  await assert.rejects(big.stage(file(src, "big.bin", "12345")), StoreError);
}));

test("names are kept readable but can't escape their folder", () => {
  assert.equal(safeName("Screenshot 2026-11-10 at 10.00.00.png"), "Screenshot 2026-11-10 at 10.00.00.png");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName(".hidden"), "_hidden");
  assert.equal(safeName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(safeName(""), "file");
  assert.equal(safeName(".."), "file");
  const long = safeName(`${"x".repeat(300)}.png`);
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith(".png"));
});

test("cards from an older state file have no attachments", withDirs(async (state) => {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "state.json"), JSON.stringify({ next: 2, cards: [{ id: "k1", title: "old", prompt: "", project: null, priority: 1, column: "backlog" }] }));
  const k = kanban(state);
  assert.deepEqual(k.store.get("k1")!.attachments, []);
  assert.equal(k.update("k1", { title: "still" }).title, "still");
  k.remove("k1");
}));

test("staged files left behind and folders of deleted cards are swept", withDirs(async (state, src) => {
  const k = kanban(state);
  const old = await k.attachments.stage(file(src, "old.png"));
  const fresh = await k.attachments.stage(file(src, "fresh.png"));
  const kept = k.create({ title: "x", attachments: [(await k.attachments.stage(file(src, "kept.png"))).id] });
  const day = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(join(state, "attachments", ".staging", old.id), day, day);
  mkdirSync(join(state, "attachments", "k99"));
  k.attachments.sweep(new Set([kept.id]));
  assert.ok(!existsSync(old.path));
  assert.ok(existsSync(fresh.path));
  assert.ok(existsSync(kept.attachments[0].path));
  assert.ok(!existsSync(join(state, "attachments", "k99")));
}));

test("a symlink is copied as the file it points to", withDirs(async (state, src) => {
  const k = kanban(state);
  const real = file(src, "real.txt", "content");
  symlinkSync(real, join(src, "link.txt"));
  const a = await k.attachments.stage(join(src, "link.txt"));
  assert.equal(readFileSync(a.path, "utf8"), "content");
  assert.equal(readdirSync(join(state, "attachments", ".staging", a.id)).length, 1);
}));

test("the orchestrator is told where the attached files are", () => {
  const card = {
    id: "k7", title: "Fix login", prompt: "See the screenshot.", priority: 2,
    attachments: [
      { id: "a1", name: "shot.png", size: 120_000, mime: "image/png", path: "/s/attachments/k7/shot.png" },
      { id: "a2", name: "repro.mp4", size: 3_400_000, mime: "video/mp4", path: "/s/attachments/k7/repro.mp4" },
    ],
  } as Card;
  const text = dispatchText(card, "herdr-kanban");
  assert.match(text, /\/s\/attachments\/k7\/shot\.png/);
  assert.match(text, /\/s\/attachments\/k7\/repro\.mp4/);
  assert.doesNotMatch(dispatchText({ ...card, attachments: [] }, "herdr-kanban"), /attach/i);
});
