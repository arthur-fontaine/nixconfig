import assert from "node:assert/strict";
import { test } from "node:test";
import {
  infoCache, infoCategory, infoCommand, infoFiles, infoLastCall, infoContext, infoDuration, infoFeed, infoLineDiff, infoLines, infoNewSession, infoParseTitle,
  infoRunning, infoSessionDir, infoSpan, infoSpark, infoTokens, infoTools, infoUsage, infoUtf8Length,
  infoCapValue, infoClock, infoEditDiff, infoJsonLines, infoParseDiff, infoResultLines, RESULT_CAP,
  infoPace, FIVE_HOURS, SEVEN_DAYS, infoBudgetLeft,
} from "../model.js";

const line = (o) => JSON.stringify(o) + "\n";
const assistant = (ts, usage, calls = []) => line({ type: "message", timestamp: ts, message: { role: "assistant", model: "claude-opus-5-5", thinkingLevel: "high", timestamp: Date.parse(ts), usage, content: calls.map((c) => ({ type: "toolCall", ...c })) } });
const result = (ts, id, extra = {}) => line({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: id, timestamp: Date.parse(ts), ...extra } });

const SESSION = [
  line({ type: "session", cwd: "/repo", timestamp: "2026-11-03T10:00:00.000Z" }),
  line({ type: "session_info", name: "herdr-layout-ideas", timestamp: "2026-11-03T10:00:01.000Z" }),
  line({ type: "message", timestamp: "2026-11-03T10:00:02.000Z", message: { role: "user", content: "go" } }),
  assistant("2026-11-03T10:00:05.000Z", { input: 2, cacheRead: 0, cacheWrite: 1000, output: 10 }, [
    { id: "a", name: "edit", arguments: { path: "/repo/src/x.ts", edits: [{ oldText: "a\nb", newText: "a\nc\nd" }] } },
    { id: "b", name: "bash", arguments: { command: "pnpm test\nmore" } },
  ]),
  result("2026-11-03T10:00:06.000Z", "a", { durationMs: 120 }),
  result("2026-11-03T10:00:09.000Z", "b", { durationMs: 2400, isError: true }),
  line({ type: "compaction", timestamp: "2026-11-03T10:01:00.000Z" }),
  assistant("2026-11-03T10:01:05.000Z", { input: 2, cacheRead: 900, cacheWrite: 100, output: 5 }, [
    { id: "c", name: "write", arguments: { path: "/repo/src/x.test.ts", content: "1\n2" } },
    { id: "d", name: "read", arguments: { path: "/repo/README.md" } },
  ]),
  result("2026-11-03T10:01:06.000Z", "c", { durationMs: 50 }),
].join("");

test("a session fed in arbitrary chunks gives the same figures", () => {
  const whole = infoNewSession("f");
  infoFeed(whole, SESSION);
  const parts = infoNewSession("f");
  for (let i = 0; i < SESSION.length; i += 37) infoFeed(parts, SESSION.slice(i, i + 37));
  for (const s of [whole, parts]) {
    assert.equal(s.name, "herdr-layout-ideas");
    assert.equal(s.model, "claude-opus-5-5");
    assert.equal(s.thinking, "high");
    assert.equal(s.messages, 3);
    assert.equal(s.compactions, 1);
    assert.equal(s.offset, infoUtf8Length(SESSION));
  }
  assert.deepEqual(infoSpark(whole), [{ ratio: 1002 / 1e6, afterCompaction: false }, { ratio: 1002 / 1e6, afterCompaction: true }]);
});

test("context, cache, tools and lines", () => {
  const s = infoNewSession("f");
  infoFeed(s, SESSION);
  assert.deepEqual(infoContext(s), { used: 1002, window: 1e6, ratio: 1002 / 1e6, compactions: 1 });
  const c = infoCache(s);
  assert.equal(c.last, 900 / 1002);
  assert.equal(c.session, 900 / 2004);
  assert.equal(c.read, 900);
  assert.equal(c.written, 1100);
  const tools = infoTools(s);
  assert.deepEqual(tools.map((t) => [t.kind, t.arg, t.running, t.error]), [
    ["read", "README.md", true, null],
    ["write", "src/x.test.ts", false, false],
    ["bash", "pnpm test", false, true],
    ["edit", "src/x.ts", false, false],
  ]);
  assert.deepEqual(infoRunning(s).map((t) => t.id), ["d"]);
  // edit: b → c, d (1 removed, 2 added); write of a new file: 2 added; the failed bash counts nothing.
  assert.deepEqual(infoLines(s), { files: 2, rows: [{ category: "Code", files: 1, added: 2, removed: 1 }, { category: "Tests", files: 1, added: 2, removed: 0 }] });
});

test("helpers", () => {
  assert.equal(infoSessionDir("/Users/a/x.y"), "--Users-a-x.y--");
  assert.deepEqual(infoParseTitle("π - herdr-layout-ideas - main"), { name: "herdr-layout-ideas", folder: "main" });
  assert.deepEqual(infoParseTitle("π - main"), { name: null, folder: "main" });
  assert.equal(infoParseTitle("zsh"), null);
  assert.deepEqual(infoLineDiff("a\nb\nb", "b\na\nc"), { added: 1, removed: 1 });
  assert.equal(infoCategory("modules/x/default.nix"), "Config");
  assert.equal(infoCategory("src/__tests__/a.ts"), "Tests");
  assert.equal(infoCategory("docs/a.ts"), "Docs");
  assert.equal(infoCategory("a/.gitignore"), "Config");
  assert.equal(infoCategory("src/app.tsx"), "Code");
  assert.equal(infoTokens(412000), "412k");
  assert.equal(infoTokens(1_400_000), "1.4M");
  assert.equal(infoTokens(8600), "8.6k");
  assert.equal(infoDuration(120), "0.1s");
  assert.equal(infoDuration(40), "");
  assert.equal(infoDuration(242000), "4m 02s");
  assert.equal(infoSpan(130 * 60000), "2h 10m");
  assert.equal(infoSpan(4 * 86400000), "4d");
  assert.equal(infoUtf8Length("π-é"), 5);
});

test("usage: ratios, reset times, staleness", () => {
  const now = 1_793_700_000_000;
  const u = infoUsage({ at: now - 60000, fiveHour: { utilization: 0.91, resetsAt: 1_793_707_800 }, sevenDay: { utilization: 0.38 }, usingOverage: false }, now);
  assert.equal(u.stale, false);
  assert.equal(u.fiveHour.ratio, 0.91);
  assert.equal(u.fiveHour.resetsAt, 1_793_707_800_000);
  assert.equal(u.sevenDay.resetsAt, null);
  assert.equal(infoUsage({ at: now - 11 * 60000, fiveHour: { utilization: 0.1 } }, now).stale, true);
  assert.equal(infoUsage(null), null);
});

test("usage: tokens left in the Kanban's budget, counted as its scheduler does", () => {
  const now = 1_793_700_000_000;
  const h = 3600 * 1000;
  const settings = { tokenBudget: 2_000_000, budgetWindowHours: 5, defaultEstimate: 100_000 };
  const cards = [
    { startedAt: now - h, estimate: 1_000_000 },
    { startedAt: now - 4 * h, estimate: null }, // the default estimate
    { startedAt: now - 6 * h, estimate: 500_000 }, // before the window
    { startedAt: null, estimate: 300_000 }, // not started
  ];
  assert.deepEqual(infoBudgetLeft({ settings, cards }, now), { left: 900_000, used: 1_100_000, budget: 2_000_000, windowHours: 5 });
  // Over budget: nothing left, not a negative figure.
  assert.equal(infoBudgetLeft({ settings: { ...settings, tokenBudget: 1_000_000 }, cards }, now).left, 0);
  assert.equal(infoBudgetLeft({ settings, cards: [] }, now).left, 2_000_000);
  assert.equal(infoBudgetLeft(null, now), null);
  assert.equal(infoBudgetLeft({ cards: [] }, now), null);
});

test("usage: the normal pace is the elapsed share of each window", () => {
  const now = 1_793_700_000_000;
  const h = 3600 * 1000;
  // 2h30 into the 5 h window: halfway.
  assert.equal(infoPace(now + 2.5 * h, FIVE_HOURS, now), 0.5);
  assert.equal(infoPace(now + FIVE_HOURS, FIVE_HOURS, now), 0);
  assert.equal(infoPace(now, FIVE_HOURS, now), 1);
  // Out of range (a stale reset time, a clock skew) stays on the bar.
  assert.equal(infoPace(now - h, FIVE_HOURS, now), 1);
  assert.equal(infoPace(now + 6 * h, FIVE_HOURS, now), 0);
  assert.equal(infoPace(null, FIVE_HOURS, now), null);
  // 5 days left of 7: 2/7 gone.
  assert.equal(infoPace(now + 5 * 24 * h, SEVEN_DAYS, now), 2 / 7);

  const u = infoUsage({ at: now, fiveHour: { utilization: 0.62, resetsAt: (now + 2.5 * h) / 1000 }, sevenDay: { utilization: 0.1 } }, now);
  assert.equal(u.fiveHour.pace, 0.5);
  assert.ok(Math.abs(u.fiveHour.ahead - 0.12) < 1e-9);
  assert.equal(u.sevenDay.pace, null);
  assert.equal(u.sevenDay.ahead, null);
  const w = infoUsage({ at: now, sevenDay: { utilization: 0.1, resetsAt: (now + 3.5 * 24 * h) / 1000 } }, now);
  assert.equal(w.sevenDay.pace, 0.5);
  assert.ok(Math.abs(w.sevenDay.ahead + 0.4) < 1e-9);
});

test("last call, last compaction, touched files", () => {
  const s = infoNewSession("f");
  infoFeed(s, SESSION);
  assert.equal(infoLastCall(s), Date.parse("2026-11-03T10:01:05.000Z"));
  assert.equal(s.lastCompaction, Date.parse("2026-11-03T10:01:00.000Z"));
  assert.deepEqual(infoFiles(s).map((f) => [f.rel, f.added, f.removed]), [["src/x.ts", 2, 1], ["src/x.test.ts", 2, 0]]);
});

test("bash commands lose their set-up in front", () => {
  assert.equal(infoCommand("cd ~/Developer/code/x && git status --porcelain"), "git status --porcelain");
  assert.equal(infoCommand('cd "/a b"; export HERDR_APP_HOME=/tmp/h; herdr-app check x'), "herdr-app check x");
  assert.equal(infoCommand("cd /x && python3 - <<'EOF'\nimport json, re\nprint(1)\nEOF"), "python3 · import json, re");
  assert.equal(infoCommand("bash -lc 'git fetch origin\ngit status'"), "bash · git fetch origin");
  assert.equal(infoCommand("cat > /tmp/a <<EOF\n\nhello\nEOF"), "cat · hello");
  assert.equal(infoCommand("H=~/.config/herdr-app; sed -n 1,5p $H/AGENTS.md"), "sed -n 1,5p $H/AGENTS.md");
  assert.equal(infoCommand("set -euo pipefail; FOO=1 BAR=$(date) node --test x"), "node --test x");
  assert.equal(infoCommand("cd modules/home\ngrep -n x y"), "grep -n x y");
  assert.equal(infoCommand("export A=1 B=2 && pnpm test"), "pnpm test");
  assert.equal(infoCommand("cd /tmp"), "cd /tmp");
  assert.equal(infoCommand("git log -n 5"), "git log -n 5");
});

test("each call keeps its arguments, its result text and when it finished", () => {
  const s = infoNewSession("f");
  infoFeed(s, SESSION + result("2026-11-03T10:01:07.000Z", "d", { content: [{ type: "text", text: "line 1\nline 2" }] }));
  const byId = Object.fromEntries(infoTools(s).map((c) => [c.id, c]));
  assert.deepEqual(byId.b.args, { command: "pnpm test\nmore" });
  assert.equal(byId.d.result, "line 1\nline 2");
  assert.equal(byId.d.finished, Date.parse("2026-11-03T10:01:07.000Z"));
  assert.equal(byId.c.result, "");
  assert.equal(byId.d.running, false);
  // A huge result is cut, and says so.
  const big = infoNewSession("f");
  infoFeed(big, assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [{ id: "x", name: "bash", arguments: { command: "cat big" } }])
    + result("2026-11-03T10:00:06.000Z", "x", { content: [{ type: "text", text: "y".repeat(RESULT_CAP + 10) }] }));
  const x = infoTools(big)[0];
  assert.equal(x.result.length, RESULT_CAP);
  assert.equal(x.resultCut, true);
  assert.ok(infoCapValue({ content: "z".repeat(20000) }).content.length < 20000);
});

test("pretty JSON comes as lines of colored parts", () => {
  const lines = infoJsonLines({ path: "a.ts", n: 2, ok: true, list: [1, null], empty: {} });
  const text = lines.map((l) => "  ".repeat(l.indent) + l.parts.map((p) => p.text).join("")).join("\n");
  assert.equal(text, JSON.stringify({ path: "a.ts", n: 2, ok: true, list: [1, null], empty: {} }, null, 2));
  const kinds = new Set(lines.flatMap((l) => l.parts.map((p) => p.kind)));
  assert.deepEqual([...kinds].sort(), ["key", "literal", "number", "punct", "string"]);
});

test("an edit reads as a diff, a result as its first lines", () => {
  assert.deepEqual(infoEditDiff({ edits: [{ oldText: "a\nb", newText: "a\nc" }, { oldText: "x", newText: "y" }] }).map((l) => l.sign + l.text),
    ["-a", "-b", "+a", "+c", " ⋯", "-x", "+y"]);
  assert.deepEqual(infoEditDiff({ path: "p" }), []);
  assert.deepEqual(infoResultLines("1\n2\n3\n", 2), { lines: ["1", "2"], more: 1 });
  assert.match(infoClock(Date.UTC(2026, 10, 3, 10, 0, 0, 7)), /^\d\d:00:00\.007$/);
});

test("Pi's edit diff gives numbered lines and the changed range", () => {
  const d = infoParseDiff("     ...\n  27 }\n- 28 const a = 1;\n+ 28 const a = 2;\n+ 29   // indented\n     ...\n  40 end");
  assert.deepEqual(d.lines.map((l) => `${l.sign}${l.num ?? ""}|${l.text}`), [" |⋯", " 27|}", "-28|const a = 1;", "+28|const a = 2;", "+29|  // indented", " |⋯", " 40|end"]);
  assert.equal(d.from, 28);
  assert.equal(d.to, 29);
  assert.match(infoClock(Date.UTC(2026, 10, 3, 10, 0, 0, 7), false), /^\d\d:00:00$/);
});
