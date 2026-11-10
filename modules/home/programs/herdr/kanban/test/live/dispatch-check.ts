// End to end on a scratch repo: a To-do card goes to a `<scratch>-project-orchestrator` Pi the
// daemon starts in Herdr, which runs `herdr-kanban review`, and the card reaches Review.
// Needs the Herdr app open. Closes the space it made.
//   node test/live/dispatch-check.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17752;
const stamp = Date.now().toString(36);
const repo = realpathSync(mkdtempSync("/tmp/hk-scratch-"));
const name = repo.split("/").pop()!;
const dir = mkdtempSync(join(tmpdir(), "herdr-kanban-e2e-"));
const api = `http://127.0.0.1:${PORT}/api`;
const cliPath = new URL("../../src/cli.ts", import.meta.url).pathname;

execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "-c", "user.email=kanban@example.invalid", "-c", "user.name=kanban", "commit", "-q", "--allow-empty", "-m", "scratch"]);

const daemon = spawn(process.execPath, [new URL("../../src/daemon.ts", import.meta.url).pathname], {
  env: {
    ...process.env, HERDR_KANBAN_STATE_DIR: dir, HERDR_KANBAN_PORT: String(PORT), HERDR_KANBAN_MCP_PORT: "17753",
    HERDR_KANBAN_TICK_MS: "3000", HERDR_KANBAN_ESTIMATOR: '["echo", "{\\"tokens\\": 20000}"]',
    // The orchestrator reaches this daemon, not the installed one.
    HERDR_KANBAN_CLI: `${process.execPath} ${cliPath} --url http://127.0.0.1:${PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
daemon.stdout.on("data", (d) => (logs += d));
daemon.stderr.on("data", (d) => (logs += d));
const ok = (m: string) => console.log(`ok - ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(api + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json() as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${out.error}`);
  return out;
};

let card: any = null;
try {
  for (let i = 0; i < 50 && !logs.includes("herdr-kanban on"); i++) await sleep(100);
  const project = await local("POST", "/projects", { folder: repo });
  assert.equal(project.name, name);
  ok(`project ${project.name} at ${project.root}`);

  card = await local("POST", "/cards", {
    title: `Kanban e2e check ${stamp}`,
    prompt: "This is an automated check of the kanban, not real work: change no file, start no worker, ask nothing. Report it as done right away.",
    project: project.key, priority: 2, column: "todo",
  });
  ok(`card ${card.id} created in To-do`);

  let c = card;
  for (let i = 0; i < 60 && c.column === "todo"; i++) { await sleep(1000); c = await local("GET", `/cards/${card.id}`); }
  assert.equal(c.column, "in_progress", `still ${c.column}: ${c.waiting.join("; ")} ${c.error ?? ""}\n${logs}`);
  assert.ok(c.orchestrator?.terminal, JSON.stringify(c));
  card = c;
  ok(`scheduler moved it to In progress and sent it to ${c.orchestrator.terminal} (${c.orchestrator.name}), space ${c.orchestrator.space}`);

  const tabs = JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8" })).spaces.flatMap((s: any) => s.tabs.map((t: any) => ({ space: s.name, ...t })));
  const tab = tabs.find((t: any) => t.terminals.some((x: any) => x.terminal === c.orchestrator.terminal));
  assert.equal(tab?.name, `${name}-project-orchestrator`);
  ok(`Herdr shows it as "${tab.space} / ${tab.name}"`);

  for (let i = 0; i < 300 && c.column === "in_progress"; i++) { await sleep(1000); c = await local("GET", `/cards/${card.id}`); }
  assert.equal(c.column, "review", `still ${c.column}\n${execFileSync("hc", ["read", "--lines", "40", card.orchestrator.terminal], { encoding: "utf8" })}`);
  ok(`the orchestrator ran herdr-kanban review: card in Review with "${c.review}"`);
  console.log(logs.split("\n").filter((l) => l.includes(card.id)).map((l) => `   ${l}`).join("\n"));
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  daemon.kill();
  const space = card?.orchestrator?.space;
  if (space) {
    try { execFileSync("herdr-app", ["do", "space.close", "--id", space, "--confirmed", "true"]); ok(`closed space ${space}`); }
    catch (e) { console.error(`couldn't close space ${space}: ${e}`); }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  // The orchestrator's Pi session for the scratch folder.
  const sessions = join(homedir(), ".pi/agent/sessions", `-${repo.replace(/\//g, "-")}--`);
  if (existsSync(sessions)) rmSync(sessions, { recursive: true, force: true });
}
