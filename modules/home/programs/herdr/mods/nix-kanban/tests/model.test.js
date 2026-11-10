import assert from "node:assert/strict";
import { test } from "node:test";
import { API, COLUMNS, SIDE_ORDER, apiBase, byColumn, fileSize, isImage, pastedName, pickedPaths, columnColor, factorChips, firstLine, glance, isFolded, kTokens, livePending, neighbor, parseNumber, spacedCode, unrecordedSpaces, waitLabel, waitLabels } from "../model.js";

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

test("a To-do card says, short, why it waits", () => {
  const w = (...waiting) => waitLabel({ waiting });
  assert.equal(w(), "next");
  assert.equal(w("RAM: 3.2 GB free, needs 6 GB", "token budget: 1.9M used + 200k > 2M per 5h"), "waiting: RAM");
  assert.equal(w("orchestrator busy with K4"), "orchestrator busy");
  assert.equal(w("orchestrator is blocked"), "orchestrator busy");
  assert.equal(w("token budget: 1.9M used + 200k > 2M per 5h"), "waiting: budget");
  assert.equal(w("2/2 cards in progress"), "waiting: 2/2 running");
  assert.equal(w("1/0 cards in progress"), "paused");
  assert.equal(w("ios-simulator held by K2"), "waiting: ios-simulator");
  assert.equal(w("no project picked"), "needs a project");
});

test("the board says the same, every reason once", () => {
  assert.deepEqual(waitLabels({ waiting: ["no project picked", "2/0 cards in progress", "orchestrator busy with K4", "orchestrator is blocked"] }),
    ["needs a project", "paused", "orchestrator busy"]);
  assert.deepEqual(waitLabels({ waiting: [] }), []);
});

test("sidebar sections in workflow order", () => {
  assert.deepEqual(SIDE_ORDER, ["backlog", "todo", "in_progress", "review", "done"]);
});

test("sidebar sections: Backlog and Done folded until unfolded", () => {
  assert.equal(isFolded(undefined, "backlog"), true);
  assert.equal(isFolded(undefined, "done"), true);
  assert.equal(isFolded({}, "todo"), false);
  assert.equal(isFolded({ done: false, todo: true }, "done"), false);
  assert.equal(isFolded({ done: false, todo: true }, "todo"), true);
});

test("a review summary's first line", () => {
  assert.equal(firstLine("\n  Bumped core to 2.1.\nAll tests pass."), "Bumped core to 2.1.");
  assert.equal(firstLine(null), "");
});

test("column colors from the theme: grey while waiting, then amber, green, accent", () => {
  const t = { dim: "dim", muted: "muted", ansi3: "amber", ansi2: "green", accent: "accent" };
  assert.deepEqual(COLUMNS.map((c) => columnColor(t, c.id)), ["dim", "muted", "amber", "green", "accent"]);
});

test("attachments: sizes, which ones get a thumbnail", () => {
  assert.equal(fileSize(0), "0 B");
  assert.equal(fileSize(900), "900 B");
  assert.equal(fileSize(1536), "1.5 KB");
  assert.equal(fileSize(120_000), "117 KB");
  assert.equal(fileSize(3_400_000), "3.2 MB");
  assert.equal(fileSize(2.5 * 1024 ** 3), "2.5 GB");
  assert.equal(isImage({ name: "a.png", mime: "image/png" }), true);
  assert.equal(isImage({ name: "Shot.JPG", mime: null }), true);
  assert.equal(isImage({ name: "logo.svg", mime: "image/svg+xml" }), true);
  assert.equal(isImage({ name: "clip.mp4", mime: "video/mp4" }), false);
  assert.equal(isImage({ name: "notes", mime: null }), false);
});

test("the API, on another port for a test daemon", () => {
  assert.equal(apiBase(undefined), API);
  assert.equal(apiBase(7799), "http://127.0.0.1:7799/api");
  assert.equal(apiBase("7799"), "http://127.0.0.1:7799/api");
  assert.equal(apiBase("evil.com/x"), API);
  assert.equal(apiBase(70000), API);
});

test("files picked in the dialog, and a pasted image's name", () => {
  assert.deepEqual(pickedPaths("/a/b c.png\n/d/e.mp4\n\n"), ["/a/b c.png", "/d/e.mp4"]);
  assert.deepEqual(pickedPaths(""), []);
  assert.equal(pastedName(new Date(2026, 10, 10, 9, 5, 3)), "Pasted image 2026-11-10 at 09.05.03.png");
});
