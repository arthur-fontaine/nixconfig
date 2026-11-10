import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVmStat } from "../src/system.ts";
import { parseEstimate } from "../src/estimator.ts";
import { distinct, projectOf, repoName, repoPath } from "../src/projects.ts";
import { dispatchText, findOrchestrator, orchestratorArgv, orchestratorName, type LsSpace } from "../src/herdr.ts";
import type { Card } from "../src/types.ts";

test("free RAM from vm_stat counts free, inactive, speculative and purgeable pages", () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    65536.
Pages active:                                 421326.
Pages inactive:                               131072.
Pages speculative:                                 0.
Pages purgeable:                               65536.
`;
  assert.equal(parseVmStat(text), 4);
  assert.equal(parseVmStat("nonsense"), null);
});

test("Sonnet's estimate is read from the first JSON object, cleaned", () => {
  const r = parseEstimate('Sure!\n{"tokens": 120000.4, "ramGB": 6, "exclusive": ["ios-simulator", "a-spaceship"], "notes": "Xcode build"}');
  assert.deepEqual(r, { tokens: 120000, factors: { ramGB: 6, exclusive: ["ios-simulator"], notes: "Xcode build" } });
  assert.equal(parseEstimate("no idea"), null);
  assert.equal(parseEstimate('{"tokens": "lots"}'), null);
  assert.deepEqual(parseEstimate('{"tokens": 5000}')?.factors, { ramGB: 0, exclusive: [], notes: "" });
});

test("projects are named as nix-sidebar names them", () => {
  assert.equal(repoName("/c/github.com/me/nixconfig/.bare"), "nixconfig");
  assert.equal(repoName("/c/app/.git"), "app");
  assert.equal(repoName("/srv/app.git"), "app");
  assert.deepEqual(repoPath("/c/me/nixconfig/.bare"), ["c", "me", "nixconfig"]);
  assert.deepEqual(projectOf("/c/me/nixconfig/.bare"), { key: '[null,"/c/me/nixconfig/.bare"]', name: "nixconfig", root: "/c/me/nixconfig" });
  const names = distinct([projectOf("/a/application/monorepo/.bare"), projectOf("/a/ddd-ts/monorepo/.git"), projectOf("/a/x/.git")]).map((p) => p.name);
  assert.deepEqual(names, ["application/monorepo", "ddd-ts/monorepo", "x"]);
});

test("orchestrators are named and started as the sidebar starts them", () => {
  assert.equal(orchestratorName("application/monorepo"), "application-monorepo-project-orchestrator");
  assert.deepEqual(orchestratorArgv("app", "/h"), ["pi", "--name", "app-project-orchestrator", "--append-system-prompt", "/h/.pi/agent/orchestrator/project.md"]);
});

const ls: LsSpace[] = [
  { id: "s1", name: "app project", folder: "/r/app", machine: null, tabs: [
    { id: "t1", name: "1", terminals: [{ terminal: "t10", status: "idle", app: "pi" }] },
    { id: "t2", name: "Orchestrator", terminals: [{ terminal: "t11", status: "working", app: "pi" }] },
  ] },
  { id: "s2", name: "lib project", folder: "/r/lib", machine: null, tabs: [
    { id: "t3", name: "lib-project-orchestrator", terminals: [{ terminal: "t12", status: null, app: null }] },
  ] },
  { id: "vps/s3", name: "remote", folder: "/r/web", machine: "vps", tabs: [
    { id: "t4", name: "web-project-orchestrator", terminals: [{ terminal: "t13", status: "idle", app: "pi" }] },
  ] },
];

test("the orchestrator is found in the project's recorded space, else by its tab name", () => {
  const app = projectOf("/r/app/.git");
  assert.deepEqual(findOrchestrator(ls, app, "s1"), { terminal: "t11", space: "s1", tab: "t2", status: "working" });
  // Its Pi exited, its shell stays: the space is reused for a new tab.
  assert.deepEqual(findOrchestrator(ls, projectOf("/r/lib/.git"), null), { terminal: null, space: "s2", tab: null, status: "missing" });
  // Another machine's spaces aren't this daemon's.
  assert.equal(findOrchestrator(ls, projectOf("/r/web/.git"), null), null);
  assert.equal(findOrchestrator(ls, app, null), null);
});

test("the dispatched prompt carries the card id and the review command", () => {
  const card = { id: "k7", title: "Fix login", prompt: "The button does nothing.", priority: 2 } as Card;
  const text = dispatchText(card, "herdr-kanban");
  assert.match(text, /k7/);
  assert.match(text, /The button does nothing\./);
  assert.match(text, /herdr-kanban review k7 "/);
});
