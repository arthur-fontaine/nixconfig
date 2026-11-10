import assert from "node:assert/strict";
import { test } from "node:test";
import { byColumn, factorChips, glance, kTokens, livePending, neighbor, parseNumber, spacedCode, unrecordedSpaces } from "../model.js";

const card = (id, column, o = {}) => ({ id, column, priority: 1, createdAt: 0, movedAt: 0, startedAt: null, project: null, orchestrator: null, ...o });

test("columns: To-do in the scheduler's order, the worked ones newest first", () => {
  const col = byColumn([
    card("a", "todo", { priority: 1, createdAt: 1 }), card("b", "todo", { priority: 3, createdAt: 5 }),
    card("c", "todo", { priority: 1, createdAt: 0 }), card("d", "done", { movedAt: 1 }), card("e", "done", { movedAt: 9 }),
  ]);
  assert.deepEqual(col.todo.map((c) => c.id), ["b", "c", "a"]);
  assert.deepEqual(col.done.map((c) => c.id), ["e", "d"]);
  assert.deepEqual(col.review, []);
});

test("the sidebar glance: Review first, then In progress, then what's next", () => {
  const cards = [card("t", "todo"), card("r", "review"), card("p", "in_progress"), card("b", "backlog"), card("d", "done")];
  assert.deepEqual(glance(cards).map((c) => c.id), ["r", "p", "t"]);
  assert.equal(glance([...cards, card("t2", "todo"), card("t3", "todo")], 3).length, 3);
});

test("arrows step over Review, which only the orchestrator reaches", () => {
  assert.equal(neighbor("in_progress", 1), "done");
  assert.equal(neighbor("done", -1), "in_progress");
  assert.equal(neighbor("todo", 1), "in_progress");
  assert.equal(neighbor("backlog", -1), null);
  assert.equal(neighbor("done", 1), null);
});

test("figures", () => {
  assert.equal(kTokens(1234), "1k");
  assert.equal(kTokens(2_450_000), "2.5M");
  assert.equal(kTokens(null), null);
  assert.deepEqual(factorChips({ estimate: 120000, factors: { ramGB: 6, exclusive: ["ios-simulator"] } }), ["~120k tokens", "6 GB", "ios-simulator"]);
  assert.deepEqual(factorChips({ estimate: null, factors: null }), []);
  assert.equal(spacedCode("642991"), "642 991");
});

test("number fields take 2, 4.5, 200k, 1.5M", () => {
  assert.equal(parseNumber("2", { integer: true }), 2);
  assert.equal(parseNumber("4.5"), 4.5);
  assert.equal(parseNumber("200k", { integer: true }), 200000);
  assert.equal(parseNumber("1.5M"), 1500000);
  assert.equal(parseNumber("-1"), null);
  assert.equal(parseNumber("lots"), null);
  assert.equal(parseNumber("0", { min: 1 }), null);
});

test("pairing codes shown only while valid", () => {
  assert.deepEqual(livePending([{ code: "1", expiresAt: 5 }, { code: "2", expiresAt: 20 }], 10).map((p) => p.code), ["2"]);
});

test("orchestrator spaces the daemon started are handed to the sidebar once they show", () => {
  const cards = [
    card("a", "review", { project: "P", startedAt: 1, orchestrator: { space: "s1" } }),
    card("b", "in_progress", { project: "P", startedAt: 2, orchestrator: { space: "s2" } }),
    card("c", "in_progress", { project: "Q", startedAt: 3, orchestrator: { space: "s3" } }),
    card("d", "in_progress", { project: "R", startedAt: 3, orchestrator: { space: "gone" } }),
  ];
  assert.deepEqual(unrecordedSpaces(cards, { Q: "s9" }, new Set(["s1", "s2", "s3"])), { P: "s2" });
});
