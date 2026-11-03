import assert from "node:assert/strict";
import { test } from "node:test";
import {
  infoCache, infoCategory, infoCommand, infoFiles, infoLastCall, infoContext, infoDuration, infoFeed, infoLineDiff, infoLines, infoNewSession, infoParseTitle,
  infoRunning, infoSessionDir, infoSpan, infoSpark, infoTokens, infoTools, infoUsage, infoUtf8Length,
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
  assert.equal(infoCommand("H=~/.config/herdr-app; sed -n 1,5p $H/AGENTS.md"), "sed -n 1,5p $H/AGENTS.md");
  assert.equal(infoCommand("set -euo pipefail; FOO=1 BAR=$(date) node --test x"), "node --test x");
  assert.equal(infoCommand("cd modules/home\ngrep -n x y"), "grep -n x y");
  assert.equal(infoCommand("export A=1 B=2 && pnpm test"), "pnpm test");
  assert.equal(infoCommand("cd /tmp"), "cd /tmp");
  assert.equal(infoCommand("git log -n 5"), "git log -n 5");
});
