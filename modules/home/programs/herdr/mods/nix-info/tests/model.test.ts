import assert from "node:assert/strict";
import { test } from "node:test";
import {
  infoCache, infoCategory, infoCommand, infoFiles, infoLastCall, infoContext, infoDuration, infoFeed, infoLineDiff, infoLines, infoNewSession, infoParseTitle,
  infoRunning, infoSessionDir, infoSpan, infoSpark, infoTokens, infoTools, infoUsage, infoUtf8Length,
  infoCapValue, infoClock, infoEditDiff, infoJsonLines, infoParseDiff, infoResultLines, RESULT_CAP,
  infoPace, FIVE_HOURS, SEVEN_DAYS, infoTokensLeft, infoScriptKey, infoNeedsTitles,
  infoKeep, infoCommandKey, infoWantsTitle, infoKeyTitles, infoRows, infoViewCommand,
} from "../model.js";
import { keyOf, scriptKey, wantsTitle } from "../../../../pi/extensions/bash-titles/titles.ts";

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

test("usage: the tokens left, as herdr-session estimated them", () => {
  const now = 1_793_700_000_000;
  const estimate = { perPoint: 269_466, spread: 0.11, stretches: 225, needed: 8, mix: 11.4 };
  const u = infoUsage({ at: now, fiveHour: { utilization: 0.43, tokensLeft: 174_506_624, estimate }, sevenDay: { utilization: 0.1, tokensLeft: null, estimate: { ...estimate, perPoint: null, spread: null, stretches: 3 } } }, now);
  assert.deepEqual(u.fiveHour.left, { tokens: 174_506_624, spread: 0.11, stretches: 225, needed: 8 });
  assert.deepEqual(infoTokensLeft(u.fiveHour.left, "5-hour"), {
    text: "≈ 175M left",
    tip: "About 175M tokens (±11%) before the 5-hour limit, at the token mix of your last 5 hours, cache reads included, from 225 stretches of your past usage",
  });
  assert.deepEqual(infoTokensLeft(u.sevenDay.left, "weekly"), {
    text: "estimating…",
    tip: "Estimating the tokens left before the weekly limit: 3 of the 8 stretches of 5 points it needs so far",
  });
  // Nothing estimated (an older herdr-session): nothing shown.
  assert.equal(infoUsage({ at: now, fiveHour: { utilization: 0.4 } }, now).fiveHour.left, null);
  assert.equal(infoTokensLeft(null, "5-hour"), null);
  assert.equal(infoTokensLeft({ tokens: 0, spread: 0.1, stretches: 9, needed: 8 }, "5-hour").text, "≈ 0 left");
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

// ---- codemode: a script's row says what it did, not its first line of code ------------

const codemode = (id, code) => ({ id, name: "codemode", arguments: { code } });
const nested = (id, calls) => ({ nestedCalls: { complete: true, calls: calls.map(([name, args], i) => ({ id: `${id}/${i + 1}`, name, status: "ok", arguments: args })) } });
const rows = (s, titles) => { infoKeyTitles(s); return infoTools(s, titles).map((c) => [c.id, c.kind, c.arg]); };

test("a codemode call is a short kind; while it runs, its arg comes from the code", () => {
  const s = infoNewSession("f");
  infoFeed(s, line({ type: "session", cwd: "/repo", timestamp: "2026-11-03T10:00:00.000Z" }) + assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [
    codemode("one", "const r = await tools.bash({command: `cd /repo && git status -sb`});\nreturn r.output"),
    codemode("path", 'return await tools.read({ path: "/repo/src/a.ts" })'),
    codemode("vars", "const r = await tools.bash({ command: `P=$(pwd); ls $P ${dir}` });"),
    codemode("many", "const [a, b] = await Promise.allSettled([tools.bash({ command: 'ls' }), tools.bash({ command: 'pwd' })]);\nconst c = await tools.read({ path: 'x' });\nreturn [a, b, c]"),
    codemode("plain", "// @options: {\"timeout_ms\": 1000}\n\nconst xs = [1, 2, 3];\nreturn xs.map((x) => x * 2)"),
  ]));
  assert.deepEqual(rows(s).reverse(), [
    ["one", "code", "bash: git status -sb"],
    ["path", "code", "read: src/a.ts"],
    ["vars", "code", "bash: ls $P ${dir}"],
    ["many", "code", "bash ×2, read"],
    ["plain", "code", "const xs = [1, 2, 3];"],
  ]);
  // The tooltip and the inspector keep the whole script.
  assert.equal(infoTools(s).find((c) => c.id === "plain").full, "// @options: {\"timeout_ms\": 1000}\n\nconst xs = [1, 2, 3];\nreturn xs.map((x) => x * 2)");
});

test("a finished codemode call is named by the calls it made", () => {
  const s = infoNewSession("f");
  infoFeed(s, line({ type: "session", cwd: "/repo", timestamp: "2026-11-03T10:00:00.000Z" }) + assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [
    codemode("one", "const r = await tools.bash({ command: cmd });\nreturn r.output"),
    codemode("many", "for (const f of files) await tools.edit({ path: f, edits });\nreturn await tools.bash({ command: 'pnpm test' })"),
    codemode("details", "const r = await tools.bash({ command: cmd })"),
    codemode("threw", "const r = await tools.bash({ command: cmd });\nthrow new Error('x')"),
  ])
    + result("2026-11-03T10:00:06.000Z", "one", nested("one", [["bash", { command: "cd /repo && pnpm test --filter x" }]]))
    + result("2026-11-03T10:00:06.000Z", "many", nested("many", [["edit", { path: "/repo/a" }], ["edit", { path: "/repo/b" }], ["edit", { path: "/repo/c" }], ["bash", { command: "pnpm test" }]]))
    // Without nestedCalls, details.calls: its args are JSON cut at some length, so not parsable.
    + result("2026-11-03T10:00:06.000Z", "details", { details: { calls: [{ id: "details/1", name: "bash", args: '{"command":"git log --oneline -20; ls modules/home/programs/pi modules/home/progr...', status: "ok" }] } })
    + result("2026-11-03T10:00:06.000Z", "threw", { isError: true, ...nested("threw", []) }));
  assert.deepEqual(rows(s).reverse(), [
    ["one", "code", "bash: pnpm test --filter x"],
    ["many", "code", "edit ×3, bash"],
    ["details", "code", "bash: git log --oneline -20; ls modules/home/programs/pi modules/home/progr..."],
    ["threw", "code", "const r = await tools.bash({ command: cmd });"],
  ]);
});

test("a codemode call takes its bash-titles title when there is one", () => {
  const code = "const a = await tools.bash({ command: 'ls' });\nconst b = await tools.read({ path: 'x' });";
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [codemode("t", code), codemode("old", "return 1"), codemode("none", "return 2")]));
  const titles = { [infoScriptKey(code)]: "Lists the files and reads x", [infoScriptKey("return 1")]: "A title cut by the old limit…" };
  assert.deepEqual(rows(s, titles).reverse(), [["t", "code", "Lists the files and reads x"], ["old", "code", "return 1"], ["none", "code", "return 2"]]);
  assert.deepEqual(rows(s).map((r) => r[2]).reverse(), ["bash, read", "return 1", "return 2"]);
});

test("the script key is bash-titles' own", () => {
  const samples = ["return 1", "  padded\n  ", "é è ü — 漢字 🎉", "lone \ud800 surrogate", ...[55, 56, 63, 64, 119, 120].map((n) => "x".repeat(n - "codemode\0".length))];
  for (const code of samples) assert.equal(infoScriptKey(code), keyOf(scriptKey(code)), JSON.stringify(code));
  // Byte lengths around the sha256 block edges, with multi-byte characters in them.
  for (const n of [54, 55, 56, 62, 63, 64, 118, 119, 120]) {
    const code = "é" + "a".repeat(n - 2);
    assert.equal(infoScriptKey(code), keyOf(scriptKey(code)), String(n));
  }
});


test("a codemode result's details.title names the call, before bash-titles.json", () => {
  const code = "const a = await tools.bash({ command: 'ls' });\nconst b = await tools.read({ path: 'x' });";
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [codemode("t", code), codemode("blank", "return 1"), codemode("run", "return 2")])
    + result("2026-11-03T10:00:06.000Z", "t", { details: { title: "Lists the files and reads x", calls: [] }, ...nested("t", [["bash", { command: "ls" }], ["read", { path: "x" }]]) })
    + result("2026-11-03T10:00:06.000Z", "blank", { details: { title: "  " } }));
  const titles = { [infoScriptKey(code)]: "An older title from the file", [infoScriptKey("return 2")]: "Returns two" };
  assert.deepEqual(rows(s, titles).reverse(), [["t", "code", "Lists the files and reads x"], ["blank", "code", "return 1"], ["run", "code", "Returns two"]]);
  assert.deepEqual(rows(s).reverse(), [["t", "code", "Lists the files and reads x"], ["blank", "code", "return 1"], ["run", "code", "return 2"]]);
});

test("bash-titles.json is needed only while a codemode call has no title of its own", () => {
  const s = infoNewSession("f");
  infoFeed(s, SESSION);
  // SESSION's bash "pnpm test\nmore" spans two lines: bash-titles names it, so it needs one too.
  assert.equal(infoNeedsTitles(s), true);
  infoFeed(s, line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-03T10:01:59.000Z", data: { toolCallId: "b", title: "Runs the tests" } }));
  assert.equal(infoNeedsTitles(s), false);
  infoFeed(s, assistant("2026-11-03T10:02:00.000Z", { input: 1, output: 1 }, [codemode("x", "return 1")]));
  assert.equal(infoNeedsTitles(s), true);
  infoFeed(s, result("2026-11-03T10:02:01.000Z", "x", { details: { title: "Returns one" } }));
  assert.equal(infoNeedsTitles(s), false);
  // An older session: results without a title keep needing the file.
  infoFeed(s, assistant("2026-11-03T10:03:00.000Z", { input: 1, output: 1 }, [codemode("y", "return 2")]) + result("2026-11-03T10:03:01.000Z", "y", nested("y", [])));
  assert.equal(infoNeedsTitles(s), true);
});


test("a title that arrived later, as a bash-titles session entry, names the call after details.title", () => {
  const late = (ts, id, title) => line({ type: "custom", customType: "bash-titles", timestamp: ts, data: { toolCallId: id, title } });
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [codemode("a", "return 1"), codemode("b", "return 2"), codemode("c", "return 3")])
    + result("2026-11-03T10:00:06.000Z", "a", { details: { title: "From the result" } })
    + result("2026-11-03T10:00:06.000Z", "b", nested("b", []))
    + late("2026-11-03T10:00:07.000Z", "a", "Later, but details.title wins")
    + late("2026-11-03T10:00:07.000Z", "b", "First late title")
    + late("2026-11-03T10:00:08.000Z", "b", "Latest late title")
    + late("2026-11-03T10:00:08.000Z", "c", "   ")
    + line({ type: "custom", customType: "other", timestamp: "2026-11-03T10:00:08.000Z", data: { toolCallId: "c", title: "Not ours" } }));
  const titles = { [infoScriptKey("return 2")]: "From the file", [infoScriptKey("return 3")]: "Three, from the file" };
  assert.deepEqual(rows(s, titles).reverse(), [["a", "code", "From the result"], ["b", "code", "Latest late title"], ["c", "code", "Three, from the file"]]);
  // Only c lacks a title of its own; once one arrives, the file isn't needed.
  assert.equal(infoNeedsTitles(s), true);
  infoFeed(s, late("2026-11-03T10:00:09.000Z", "c", "Three, late"));
  assert.equal(infoNeedsTitles(s), false);
  assert.equal(rows(s, titles)[0][2], "Three, late");
});

test("a late title fed before its call is kept for it", () => {
  const s = infoNewSession("f");
  infoFeed(s, line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-03T10:00:04.000Z", data: { toolCallId: "e", title: "Early" } })
    + assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, [codemode("e", "return 1")]));
  assert.equal(infoNeedsTitles(s), false);
  assert.equal(rows(s)[0][2], "Early");
});

// ---- calls made inside codemode scripts: the filters, the errors, the lines changed ---------
// Real toolResult lines from a session of 439 codemode calls (outputs and long strings cut,
// paths anonymised): a nested bash that failed in a script that didn't throw; two writes, one
// carrying only argumentsBytes, with bash-changes' fileChanges on the script's result (the
// write of mods.nix is in both: counted once); a nested edit without fileChanges.
const REAL = [
  line({ type: "session", cwd: "/repo", timestamp: "2026-11-16T21:28:45.145Z" }),
  assistant("2026-11-16T21:29:00.000Z", { input: 1, output: 1 }, [
    { id: "toolu_01NZrSTC2p7ssRymJ4A1iLvk", name: "codemode", arguments: { code: "const r=await tools.bash({command:\"which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr\"});text(r.output)" } },
  ]),
  line({ type: "message", timestamp: "2026-11-16T21:29:18.778Z", message: { role: "toolResult", toolCallId: "toolu_01NZrSTC2p7ssRymJ4A1iLvk", toolName: "codemode", content: [{ type: "text", text: "…" }],
    details: { calls: [{ id: "toolu_01NZrSTC2p7ssRymJ4A1iLvk/1", name: "bash", args: "{\"command\":\"which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr\"}", status: "error", durationMs: 1943.7231250000004, error: "/opt/homebrew/bin/herdr-app\n…" }], autoMode: { allowed: true } },
    isError: false, durationMs: 1977, timestamp: 1794864558778,
    nestedCalls: { calls: [{ id: "toolu_01NZrSTC2p7ssRymJ4A1iLvk/1", name: "bash", status: "error", arguments: { command: "which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr" }, durationMs: 1943, error: "/opt/homebrew/bin/herdr-app\n…" }], complete: true } } }),
  assistant("2026-11-16T21:30:00.000Z", { input: 1, output: 1 }, [
    { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt", name: "codemode", arguments: { code: "const p=\"modules/home/programs/herdr/\";\nawait tools.write({path:p+\"mods.nix\",content:mods});\nconst src=await tools.read({path:p+\"default.nix\"});\nawait tools.write({path:p+\"default.nix\",content:src});\nconst r=await tools.bash({command:\"cd \"+p+\" && git add mods.nix default.nix && git diff --cached --stat\"});\ntext(r.output)" } },
  ]),
  line({ type: "message", timestamp: "2026-11-16T21:30:55.879Z", message: { role: "toolResult", toolCallId: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt", toolName: "codemode", content: [{ type: "text", text: "…" }],
    details: {
      calls: [
        { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/1", name: "write", args: "{\"path\":\"modules/home/programs/herdr/mods.nix\",\"content\":\"# The mods deployed to Herdr's home, and how each main.js is made (default.nix's bundle):\\n# shared mods/_lib files and the mod's own modul...", status: "ok", durationMs: 4.108208999998169 },
        { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/2", name: "read", args: "{\"path\":\"modules/home/programs/herdr/default.nix\"}", status: "ok", durationMs: 1.767707999999402 },
        { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/3", name: "write", args: "{\"path\":\"modules/home/programs/herdr/default.nix\",\"content\":\"{ config, lib, pkgs, ... }:\\nlet\\n  # herdr-core (hc) runs the Herdr app's terminals and agents; the app (the\\n  # herdr-app cask) w...", status: "ok", durationMs: 3.7022500000020955 },
        { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/4", name: "bash", args: "{\"command\":\"cd modules/home/programs/herdr/ && git add mods.nix default.nix && git diff --cached --stat\"}", status: "ok", durationMs: 2194.7288750000007 },
      ],
      autoMode: { allowed: true },
      fileChanges: { root: "/repo", before: "d053cf387d8f3468f486ee0089ffd3d82fefc9c0", after: "eeb5186b0198be5774b8840458d2118ab9910173",
        files: [{ path: "modules/home/programs/herdr/default.nix", status: "M", added: 2, removed: 28 }, { path: "modules/home/programs/herdr/mods.nix", status: "A", added: 31, removed: 0 }], patch: "" },
    },
    isError: false, durationMs: 2244, timestamp: 1794864655879,
    nestedCalls: { calls: [
      { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/1", name: "write", status: "ok", arguments: { path: "modules/home/programs/herdr/mods.nix", content: "# The mods deployed to Herdr's home\n{\n  nix-info = { shared = [ \"editor.js\" ]; modules = [ \"model.js\" ]; };\n}\n" }, durationMs: 4 },
      { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/2", name: "read", status: "ok", arguments: { path: "modules/home/programs/herdr/default.nix" }, durationMs: 2 },
      { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/3", name: "write", status: "ok", argumentsBytes: 11317, durationMs: 3 },
      { id: "toolu_01CdG5Nu7zL7rxJuWhL1CZjt/4", name: "bash", status: "ok", arguments: { command: "cd modules/home/programs/herdr/ && git add mods.nix default.nix && git diff --cached --stat" }, durationMs: 2195 },
    ], complete: false } } }),
  assistant("2026-11-16T22:02:00.000Z", { input: 1, output: 1 }, [
    { id: "toolu_01CLKS9CX6zyphy73bQpqtZU", name: "codemode", arguments: { code: "const D=\"/home/u/notes\";\nawait tools.edit({path:D+\"/feasibility.md\",edits});\nconst r=await tools.bash({command:\"sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js\"});text(r.output)" } },
  ]),
  line({ type: "message", timestamp: "2026-11-16T22:02:56.767Z", message: { role: "toolResult", toolCallId: "toolu_01CLKS9CX6zyphy73bQpqtZU", toolName: "codemode", content: [{ type: "text", text: "…" }],
    details: { calls: [
      { id: "toolu_01CLKS9CX6zyphy73bQpqtZU/1", name: "edit", args: "{\"path\":\"/home/u/notes/feasibility.md\",\"edits\":[...", status: "ok", durationMs: 15886.733042000094 },
      { id: "toolu_01CLKS9CX6zyphy73bQpqtZU/2", name: "bash", args: "{\"command\":\"sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js\"}", status: "ok", durationMs: 48.59408299997449 },
    ], autoMode: { allowed: true } },
    isError: false, durationMs: 15965, timestamp: 1794866576767,
    nestedCalls: { calls: [
      { id: "toolu_01CLKS9CX6zyphy73bQpqtZU/1", name: "edit", status: "ok", arguments: { path: "/home/u/notes/feasibility.md", edits: [
        { oldText: "(lightsPadding, mods/nix-tabs/main.js:124-127)", newText: "(lightsPadding, mods/nix-tabs/main.js:114-117)" },
        { oldText: "(nix-sidebar render() .bg(t.chrome), nix-tabs, nix-head)", newText: "(mods/nix-sidebar/main.js:671,706, mods/nix-tabs/main.js:131, nix-head)" },
      ] }, durationMs: 15886 },
      { id: "toolu_01CLKS9CX6zyphy73bQpqtZU/2", name: "bash", status: "ok", arguments: { command: "sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js" }, durationMs: 48 },
    ], complete: true } } }),
].join("");

// Shaped like the real ones above: a script editing mods.nix again (relative path) and failing
// an edit; a top-level bash that went on in the background, whose fileChanges came as a real
// bash-changes entry (paths renamed), and again on its result: counted once.
const BG_CHANGES = { root: "/repo", before: "f3b48c3bbf960cb5a81038c41f4050bf7f92c0e8", after: "beff30b1bfba5cf0242be062dd51d8c96bbf6ccd",
  files: [{ path: ".env.base", status: "M", added: 4, removed: 0 }, { path: "infra/gcloud.yml", status: "M", added: 6, removed: 0 }, { path: "src/http/api.ts", status: "M", added: 4, removed: 1 }], patch: "", overlapping: true };
const MORE = [
  assistant("2026-11-16T22:10:00.000Z", { input: 1, output: 1 }, [codemode("again", "for (const e of edits) await tools.edit(e)")]),
  result("2026-11-16T22:10:01.000Z", "again", { isError: false, nestedCalls: { complete: true, calls: [
    { id: "again/1", name: "edit", status: "ok", arguments: { path: "modules/home/programs/herdr/mods.nix", edits: [{ oldText: "{", newText: "{\n  # one more" }] } },
    { id: "again/2", name: "edit", status: "error", arguments: { path: "/repo/x.ts", edits: [{ oldText: "a", newText: "b\nc" }] }, error: "Could not find the exact text" },
  ] } }),
  assistant("2026-11-16T22:11:00.000Z", { input: 1, output: 1 }, [{ id: "bg", name: "bash", arguments: { command: "pnpm install" } }]),
  result("2026-11-16T22:11:01.000Z", "bg", { details: { fileChanges: BG_CHANGES } }),
  line({ type: "custom", customType: "bash-changes", data: { toolCallId: "bg", fileChanges: BG_CHANGES }, id: "1630dee6", parentId: "117a0f58", timestamp: "2026-11-16T22:12:03.999Z" }),
].join("");

test("lines changed count a script's edits and writes and bash-changes' fileChanges, a file once", () => {
  const s = infoNewSession("f");
  infoFeed(s, REAL);
  assert.deepEqual(infoLines(s), { files: 3, rows: [{ category: "Config", files: 2, added: 33, removed: 28 }, { category: "Docs", files: 1, added: 2, removed: 2 }] });
  infoFeed(s, MORE);
  // mods.nix again (+1), the failed edit nothing, the background bash's three files once.
  assert.deepEqual(infoLines(s), { files: 6, rows: [
    { category: "Code", files: 1, added: 4, removed: 1 },
    { category: "Config", files: 4, added: 44, removed: 28 },
    { category: "Docs", files: 1, added: 2, removed: 2 },
  ] });
  assert.deepEqual(infoFiles(s).map((f) => [f.rel, f.added, f.removed]).slice(0, 2), [["modules/home/programs/herdr/mods.nix", 32, 0], ["modules/home/programs/herdr/default.nix", 2, 28]]);
});

test("a nested call that failed makes its script an error, though the script didn't throw", () => {
  const s = infoNewSession("f");
  infoFeed(s, REAL + MORE);
  const byId = Object.fromEntries(infoTools(s).map((c) => [c.id, c]));
  assert.equal(byId.toolu_01NZrSTC2p7ssRymJ4A1iLvk.error, true);
  assert.equal(byId.toolu_01NZrSTC2p7ssRymJ4A1iLvk.threw, false);
  assert.equal(byId.again.error, true);
  assert.equal(byId.toolu_01CdG5Nu7zL7rxJuWhL1CZjt.error, false);
  assert.equal(infoTools(s).filter((c) => c.error).length, 2);
});

test("the kind filters keep a script for the calls it made, with only those under it", () => {
  const s = infoNewSession("f");
  infoFeed(s, REAL + MORE);
  const kept = (kind) => infoRows(infoTools(s).map((c) => infoKeep(c, kind)).filter(Boolean)).map((r) => [r.level, r.id, r.kind, r.arg]);
  const [fail, edit, nofc] = ["toolu_01NZrSTC2p7ssRymJ4A1iLvk", "toolu_01CdG5Nu7zL7rxJuWhL1CZjt", "toolu_01CLKS9CX6zyphy73bQpqtZU"];
  assert.deepEqual(kept("bash"), [
    [0, "bg", "bash", "pnpm install"],
    [0, nofc, "code", "edit, bash"],
    [1, nofc + "/2", "bash", "sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js"],
    [0, edit, "code", "write ×2, read, bash"],
    [1, edit + "/4", "bash", "git add mods.nix default.nix && git diff --cached --stat"],
    [0, fail, "code", "bash: which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr"],
    [1, fail + "/1", "bash", "which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr"],
  ]);
  assert.deepEqual(kept("read"), [[0, edit, "code", "write ×2, read, bash"], [1, edit + "/2", "read", "modules/home/programs/herdr/default.nix"]]);
  // The write with argumentsBytes only is named from details.calls' cut JSON.
  assert.deepEqual(kept("edit").filter((r) => r[1].startsWith(edit)), [
    [0, edit, "code", "write ×2, read, bash"],
    [1, edit + "/1", "write", "modules/home/programs/herdr/mods.nix"],
    [1, edit + "/3", "write", "modules/home/programs/herdr/default.nix"],
  ]);
  assert.deepEqual(kept("edit").map((r) => r[1]), ["again", "again/1", "again/2", nofc, nofc + "/1", edit, edit + "/1", edit + "/3"]);
  assert.deepEqual(kept("errors"), [
    [0, "again", "code", "edit ×2"], [1, "again/2", "edit", "x.ts"],
    [0, fail, "code", "bash: which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr"],
    [1, fail + "/1", "bash", "which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr"],
  ]);
  assert.deepEqual(kept("ask"), []);
});

test("a codemode call lists the calls it made under it, in call order, at level 1", () => {
  const s = infoNewSession("f");
  infoFeed(s, REAL);
  const all = infoRows(infoTools(s));
  const edit = "toolu_01CdG5Nu7zL7rxJuWhL1CZjt";
  const at = all.findIndex((r) => r.id === edit);
  assert.deepEqual(all.slice(at, at + 5).map((r) => [r.level, r.kind, r.arg, r.duration, r.error, r.path]), [
    [0, "code", "write ×2, read, bash", 2244, false, null],
    // Shown relative, opened by their absolute path.
    [1, "write", "modules/home/programs/herdr/mods.nix", 4, false, "/repo/modules/home/programs/herdr/mods.nix"],
    [1, "read", "modules/home/programs/herdr/default.nix", 2, false, "/repo/modules/home/programs/herdr/default.nix"],
    [1, "write", "modules/home/programs/herdr/default.nix", 3, false, "/repo/modules/home/programs/herdr/default.nix"],
    [1, "bash", "git add mods.nix default.nix && git diff --cached --stat", 2195, false, null],
  ]);
  const sub = all[at + 4];
  assert.equal(sub.parent, edit);
  assert.equal(sub.running, false);
  assert.deepEqual(sub.args, { command: "cd modules/home/programs/herdr/ && git add mods.nix default.nix && git diff --cached --stat" });
  // A failed nested call: its error is its result.
  const failed = all.find((r) => r.id === "toolu_01NZrSTC2p7ssRymJ4A1iLvk/1");
  assert.equal(failed.error, true);
  assert.equal(failed.result, "/opt/homebrew/bin/herdr-app\n…");
  assert.equal(all.filter((r) => r.level === 0).length, 3);
  assert.equal(all.length, 3 + 1 + 4 + 2);
});

test("a nested call's output preview (details.callOutputs) is its result", () => {
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-17T15:49:40.000Z", { input: 1, output: 1 }, [codemode("co", "await tools.bash({command:'git status -sb'})")])
    + result("2026-11-17T15:49:42.905Z", "co", { details: { calls: [{ id: "co/1", name: "bash", args: "{\"command\":\"git status -sb\"}", status: "ok", durationMs: 2255.6 }],
      callOutputs: { "co/1": { lines: ["## fix/pi-codemode-rows", "1ad0c29 fix(herdr/nix-editor): the command line"], total: 146 } } },
      nestedCalls: { calls: [{ id: "co/1", name: "bash", status: "ok", arguments: { command: "git status -sb" }, durationMs: 2255 }], complete: true } }));
  const sub = infoRows(infoTools(s))[1];
  assert.equal(sub.result, "## fix/pi-codemode-rows\n1ad0c29 fix(herdr/nix-editor): the command line");
  assert.equal(sub.resultCut, true);
});

// ---- a top-level bash: its title instead of its command, for the commands bash-titles names ----
// The call and result keep a real top-level bash's shape (its command replaced); details.title
// and the bash-titles entry follow titles.ts's withTitle and ENTRY: no session has one yet.
const LONG = "cd /tmp/spec && ls -la *.html *.md 2>/dev/null; git log --oneline -5; git status --short | head -20";
const bashCall = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const bashResult = (ts, id, details = { autoMode: { allowed: true } }) => line({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: id, toolName: "bash",
  content: [{ type: "text", text: "…" }], details, isError: false, durationMs: 72, timestamp: Date.parse(ts) } });

test("a top-level bash shows its title when bash-titles names it; the command stays in full", () => {
  const s = infoNewSession("f");
  infoFeed(s, line({ type: "session", cwd: "/repo", timestamp: "2026-11-05T09:26:10.912Z" })
    + assistant("2026-11-05T09:30:00.000Z", { input: 1, output: 1 }, [bashCall("file", LONG), bashCall("short", "ls -la"), bashCall("res", LONG + " # 2"), bashCall("late", LONG + " # 3")])
    + bashResult("2026-11-05T09:30:01.000Z", "file")
    + bashResult("2026-11-05T09:30:01.000Z", "short", { autoMode: { allowed: true }, title: "Lists the files" })
    + bashResult("2026-11-05T09:30:01.000Z", "res", { autoMode: { allowed: true }, title: "Lists the spec files and recent commits" })
    + bashResult("2026-11-05T09:30:01.000Z", "late")
    + line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-05T09:30:02.000Z", data: { toolCallId: "late", title: "Shows the spec, a third time" } })
    + line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-05T09:30:02.000Z", data: { toolCallId: "short", title: "Lists the files, late" } }));
  const titles = { [infoCommandKey(LONG)]: "Lists the spec files, plus recent commits", [infoCommandKey("ls -la")]: "Lists the files" };
  assert.deepEqual(rows(s, titles).reverse(), [
    ["file", "bash", "Lists the spec files, plus recent commits"],
    ["short", "bash", "ls -la"],
    ["res", "bash", "Lists the spec files and recent commits"],
    ["late", "bash", "Shows the spec, a third time"],
  ]);
  // Without bash-titles.json, the command as before.
  assert.equal(rows(s)[3][2], "ls -la *.html *.md 2>/dev/null; git log --oneline -5; git status --short | head -20");
  assert.equal(infoTools(s, titles).find((c) => c.id === "file").full, LONG);
  // Only "file" lacks a title of its own: it needs bash-titles.json; the short one never does.
  assert.equal(infoNeedsTitles(s), true);
  infoFeed(s, line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-05T09:30:03.000Z", data: { toolCallId: "file", title: "Lists the spec" } }));
  assert.equal(infoNeedsTitles(s), false);
});

test("the command key and which commands get a title are bash-titles' own", () => {
  const samples = ["ls -la", "git status && git diff", "cd a && make && make test && make install", "python3 -c 'print(1)'\necho done", "x".repeat(80), "x".repeat(81), "  padded  ", "é è — 漢字 🎉 && a || b | c", "a; b; c", LONG];
  for (const c of samples) {
    assert.equal(infoWantsTitle(c), wantsTitle(c), JSON.stringify(c));
    assert.equal(infoCommandKey(c), keyOf(c), JSON.stringify(c));
  }
});

test("bash-titles.json keys are worked out a few calls at a time", () => {
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-03T10:00:05.000Z", { input: 1, output: 1 }, ["return 1", "return 2", "return 3"].map((code, i) => codemode(`k${i}`, code))));
  const titles = Object.fromEntries(["return 1", "return 2", "return 3"].map((code) => [infoScriptKey(code), `Title of ${code}`]));
  // Not keyed yet: listed by their code, nothing hashed while listing.
  assert.deepEqual(infoTools(s, titles).map((c) => c.arg), ["return 3", "return 2", "return 1"]);
  assert.equal(infoKeyTitles(s, 2), true);
  assert.deepEqual(infoTools(s, titles).map((c) => c.arg), ["return 3", "Title of return 2", "Title of return 1"]);
  assert.equal(infoKeyTitles(s, 2), false);
  assert.deepEqual(infoTools(s, titles).map((c) => c.arg), ["Title of return 3", "Title of return 2", "Title of return 1"]);
});

test("a sub-row takes its nested call's title when it carries one, else its command", () => {
  const s = infoNewSession("f");
  infoFeed(s, assistant("2026-11-17T15:49:40.000Z", { input: 1, output: 1 }, [codemode("nt", "await tools.bash({command:a}); await tools.bash({command:b})")])
    + result("2026-11-17T15:49:42.000Z", "nt", { nestedCalls: { complete: true, calls: [
      { id: "nt/1", name: "bash", status: "ok", title: "Lists the spec files", arguments: { command: LONG } },
      { id: "nt/2", name: "bash", status: "ok", title: "  ", arguments: { command: "git status -sb" } },
    ] } }));
  const [, titled, plain] = infoRows(infoTools(s));
  assert.equal(titled.arg, "Lists the spec files");
  assert.equal(titled.full, LONG);
  assert.equal(plain.arg, "git status -sb");
});

test("a nested bash takes its bash-titles.json title, keyed by its whole command", () => {
  // The real nested command of REAL's first script (details.calls cuts it: nestedCalls' is whole).
  const cmd = "which herdr-app hc; herdr-app --help 2>&1 | head -60; ls /tmp | grep -i herdr";
  assert.equal(infoCommandKey(cmd), keyOf(cmd));
  assert.equal(wantsTitle(cmd), true);
  const s = infoNewSession("f");
  infoFeed(s, REAL);
  // Three scripts with no title of their own, and that nested bash.
  assert.equal(infoNeedsTitles(s), true);
  const titles = { [keyOf(cmd)]: "Finds the herdr-app binaries", [keyOf("sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js")]: "Not wanted: short and one step" };
  infoKeyTitles(s);
  const all = infoRows(infoTools(s, titles));
  const sub = all.find((r) => r.id === "toolu_01NZrSTC2p7ssRymJ4A1iLvk/1");
  assert.equal(sub.arg, "Finds the herdr-app binaries");
  assert.equal(sub.full, cmd);
  assert.equal(all.find((r) => r.id === "toolu_01CLKS9CX6zyphy73bQpqtZU/2").arg, "sed -n 112,118p modules/home/programs/herdr/mods/nix-tabs/main.js");
  // Under a filter too.
  assert.equal(infoRows([infoKeep(infoTools(s, titles).find((c) => c.id === "toolu_01NZrSTC2p7ssRymJ4A1iLvk"), "bash")])[1].arg, "Finds the herdr-app binaries");
  // The scripts titled, the nested bash still wants the file.
  const late = (id) => line({ type: "custom", customType: "bash-titles", timestamp: "2026-11-16T23:00:00.000Z", data: { toolCallId: id, title: "A title" } });
  infoFeed(s, late("toolu_01NZrSTC2p7ssRymJ4A1iLvk") + late("toolu_01CdG5Nu7zL7rxJuWhL1CZjt") + late("toolu_01CLKS9CX6zyphy73bQpqtZU"));
  assert.equal(infoNeedsTitles(s), true);
});

test("nix-info.<verb> commands put the panel in a state", () => {
  const home = { detail: null, kind: "all", sel: null, all: false };
  const on = (view, c) => infoViewCommand(view, c);
  // detail:<key> opens a detail; "detail:" is the overview, as Back leaves it.
  assert.deepEqual(on(home, "detail:lines"), { ...home, detail: "lines" });
  assert.deepEqual(on({ detail: "activity", kind: "bash", sel: "x", all: true }, "detail:"), home);
  assert.equal(on(home, "detail:nope"), null);
  // kind:<key> filters the activity detail, opening it.
  assert.deepEqual(on(home, "kind:errors"), { ...home, detail: "activity", kind: "errors" });
  assert.equal(on(home, "kind:nope"), null);
  // select:<id> selects a call (a nested one too, "<parent>/<n>"), from the overview into the
  // activity detail as a click does; "select:" closes the inspector.
  assert.deepEqual(on(home, "select:a/2"), { ...home, detail: "activity", sel: "a/2" });
  assert.deepEqual(on({ ...home, detail: "activity", sel: "a" }, "select:"), { ...home, detail: "activity" });
  assert.deepEqual(on(home, "all"), { ...home, all: true });
  // back: as Esc, the inspector first, then the detail.
  assert.deepEqual(on({ ...home, detail: "activity", sel: "a" }, "back"), { ...home, detail: "activity" });
  assert.deepEqual(on({ ...home, detail: "activity", kind: "read" }, "back"), home);
  assert.equal(on(home, "whatever"), null);
});
