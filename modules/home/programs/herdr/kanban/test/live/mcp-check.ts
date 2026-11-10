// The daemon for real, on its own ports and a temp state dir: Bonjour sees it, a remote
// agent pairs over MCP and creates a card, no token is refused, MCP off refuses the port.
//   node test/live/mcp-check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 17742, MCP = 17743, NAME = `Herdr Kanban check ${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "herdr-kanban-live-"));
const api = `http://127.0.0.1:${PORT}/api`;
const daemon = spawn(process.execPath, [new URL("../../src/daemon.ts", import.meta.url).pathname], {
  env: { ...process.env, HERDR_KANBAN_STATE_DIR: dir, HERDR_KANBAN_PORT: String(PORT), HERDR_KANBAN_MCP_PORT: String(MCP), HERDR_KANBAN_NAME: NAME, HERDR_KANBAN_ESTIMATOR: '["echo", "{\\"tokens\\": 1234}"]' },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
daemon.stdout.on("data", (d) => (logs += d));
daemon.stderr.on("data", (d) => (logs += d));

const ok = (m: string) => console.log(`ok - ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(api + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json() as any;
};
const refused = () => new Promise<boolean>((resolve) => {
  const s = connect(MCP, "127.0.0.1");
  s.on("connect", () => { s.destroy(); resolve(false); });
  s.on("error", (e: any) => resolve(e.code === "ECONNREFUSED"));
});
async function mcpClient(token?: string) {
  const c = new Client({ name: "kanban-check", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP}/mcp`), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
  return c;
}
const textOf = (r: any) => r.content?.[0]?.text ?? "";

try {
  for (let i = 0; i < 50 && !logs.includes("herdr-kanban on"); i++) await sleep(100);
  assert.ok(logs.includes("herdr-kanban on"), logs);
  ok("daemon up on 127.0.0.1:" + PORT);

  assert.equal(await refused(), true);
  ok("MCP is off by default: its port refuses connections");

  await local("PATCH", "/settings", { mcpEnabled: true });
  assert.equal((await local("GET", "/state")).mcp.listening, true);
  ok("enabled from the local API (as the Herdr UI does)");

  const browse = spawn("dns-sd", ["-B", "_herdr-kanban._tcp", "local"]);
  let seen = "";
  browse.stdout.on("data", (d) => (seen += d));
  for (let i = 0; i < 50 && !seen.includes(NAME); i++) await sleep(100);
  browse.kill();
  assert.ok(seen.includes(NAME), seen);
  console.log(seen.split("\n").filter((l) => l.includes(NAME)).map((l) => `   ${l.trim()}`).join("\n"));
  ok("dns-sd -B _herdr-kanban._tcp sees it");

  const anon = await mcpClient();
  const tools = (await anon.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["create_card", "get_card", "list_cards", "list_projects", "move_card", "pair_confirm", "pair_start", "update_card"]);
  const denied = await anon.callTool({ name: "create_card", arguments: { title: "sneaky" } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Not paired/);
  assert.equal((await local("GET", "/cards")).length, 0);
  ok("without a token: create_card refused, nothing created");

  const started = await anon.callTool({ name: "pair_start", arguments: { client_name: "check script" } });
  assert.ok(!started.isError, textOf(started));
  assert.ok(!textOf(started).match(/\b\d{6}\b/), "the code never goes back over MCP");
  const { pending } = await local("GET", "/pairing");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].client, "check script");
  ok(`pair_start: code ${pending[0].code} shown locally only`);

  const wrong = await anon.callTool({ name: "pair_confirm", arguments: { code: pending[0].code === "000000" ? "000001" : "000000" } });
  assert.equal(wrong.isError, true);
  const confirmed = await anon.callTool({ name: "pair_confirm", arguments: { code: pending[0].code } });
  const { token } = JSON.parse(textOf(confirmed));
  assert.ok(token?.length > 20);
  ok("pair_confirm: a wrong code fails, the right one gives a token");

  const paired = await mcpClient(token);
  const created = await paired.callTool({ name: "create_card", arguments: { title: "From a remote agent", prompt: "Check the MCP path", priority: 2 } });
  assert.ok(!created.isError, textOf(created));
  const card = JSON.parse(textOf(created));
  const cards = await local("GET", "/cards");
  assert.deepEqual(cards.map((c: any) => [c.id, c.title, c.priority]), [[card.id, "From a remote agent", 2]]);
  const listed = JSON.parse(textOf(await paired.callTool({ name: "list_cards", arguments: {} })));
  assert.equal(listed[0].id, card.id);
  ok(`with the token: create_card made ${card.id}, list_cards sees it`);

  const toReview = await paired.callTool({ name: "move_card", arguments: { id: card.id, column: "review" } });
  assert.equal(toReview.isError, true);
  ok("MCP can't move a card to Review");

  const { clients } = await local("GET", "/pairing");
  await fetch(`${api}/clients/${clients[0].id}`, { method: "DELETE" });
  const revoked = await fetch(`http://127.0.0.1:${MCP}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(revoked.status, 401);
  ok("a revoked token gets 401");

  await local("PATCH", "/settings", { mcpEnabled: false });
  assert.equal(await refused(), true);
  ok("disabled again: the port refuses connections");
  await Promise.all([anon.close(), paired.close()]);
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  daemon.kill();
  rmSync(dir, { recursive: true, force: true });
}
