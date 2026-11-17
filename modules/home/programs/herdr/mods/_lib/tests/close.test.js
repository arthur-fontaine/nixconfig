import assert from "node:assert/strict";
import { test } from "node:test";
import { closeAsk } from "../close.js";

const shell = { kind: "terminal", shell: true, agent: false, name: "zsh" };
const prog = (name) => ({ kind: "terminal", shell: false, agent: false, name });
const agent = (app, status, resumable = null) => ({ kind: "terminal", shell: false, agent: true, app, status, name: app, resumable });
const board = { kind: "mod" };

// [what is closed, scope, items, extra, asks?]
const cases = [
  ["an idle shell, tab", "tab", [shell], {}, false],
  ["two idle shells, space", "space", [shell, shell], {}, false],
  ["a board, tab", "tab", [board], {}, false],
  ["a board, space (more than idle shells)", "space", [board], {}, true],
  ["sleep running, tab", "tab", [prog("sleep")], {}, true],
  ["nvim, pane", "pane", [prog("nvim")], {}, true],
  ["Pi working", "tab", [agent("pi", "working", true)], {}, true],
  ["Pi blocked", "tab", [agent("pi", "blocked", true)], {}, true],
  ["Pi idle, resumable, tab", "tab", [agent("pi", "idle", true)], {}, false],
  ["Pi done, resumable, pane", "pane", [agent("pi", "done", true)], {}, false],
  ["Pi idle, resumable, space", "space", [agent("pi", "idle", true)], {}, true],
  ["Pi idle, not resumable", "tab", [agent("pi", "idle", false)], {}, true],
  ["Pi idle, resumability unknown", "tab", [agent("pi", "idle", null)], {}, true],
  ["Claude Code idle (not resumable here)", "tab", [agent("claude-code", "idle")], {}, true],
  ["a shell whose sub-agent works", "tab", [shell], { workers: ["working"] }, true],
  ["a shell whose sub-agent is done", "tab", [shell], { workers: ["done"] }, false],
  ["nothing found", "tab", [], {}, true],
  ["a terminal without program facts", "tab", [{ kind: "terminal" }], {}, true],
  ["an idle shell on another machine", "tab", [shell], { remote: true }, true],
];

for (const [what, scope, items, extra, asks] of cases)
  test(`close: ${what} → ${asks ? "asks" : "no ask"}`, () => {
    const r = closeAsk({ scope, items, workers: [], remote: false, ...extra });
    assert.equal(r.ask, asks, JSON.stringify(r));
    if (asks) assert.ok(r.lost.length > 0, "an ask says what would be lost");
  });
