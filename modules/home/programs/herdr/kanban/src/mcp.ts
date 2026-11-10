// The LAN endpoint: MCP over Streamable HTTP (stateless: a server per request), for other
// agents. Everything but pairing needs `Authorization: Bearer <token>` from pair_confirm.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readBody, send } from "./http.ts";
import { CODE_TTL_MS, PairingError } from "./pairing.ts";
import { StoreError } from "./store.ts";
import type { Kanban } from "./kanban.ts";
import { COLUMNS, type PairedClient } from "./types.ts";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const error = (msg: string) => ({ ...text(msg), isError: true });

const bearer = (req: IncomingMessage) => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? null;

export function mcpServer(k: Kanban, client: PairedClient | null, onPairing: (client: string) => void): McpServer {
  const server = new McpServer({ name: "herdr-kanban", version: "0.1.0" }, {
    instructions: "A kanban whose cards are sent to Pi project orchestrators on the person's Mac. Pair first: pair_start, ask the person for the code Herdr shows, then pair_confirm, and send the token as `Authorization: Bearer <token>` on every request.",
  });
  // Every tool but pairing: refused without a valid token.
  const authed = <A,>(fn: (args: A) => unknown) => async (args: A) => {
    if (!client) return error("Not paired: call pair_start, ask the person for the code shown in Herdr, then pair_confirm, and send the token as `Authorization: Bearer <token>`.");
    try { return text(await fn(args)); } catch (e) {
      return error(e instanceof StoreError || e instanceof PairingError ? e.message : `failed: ${(e as Error).message}`);
    }
  };

  server.registerTool("pair_start", {
    description: "Ask to pair with this kanban. Herdr shows a 6-digit code to the person; ask them for it, then call pair_confirm. Codes last 2 minutes.",
    inputSchema: { client_name: z.string().max(80).describe("Who is asking, shown to the person (e.g. 'Claude on laptop')") },
  }, async ({ client_name }) => {
    try {
      const { expiresAt } = k.pairing.start(client_name);
      onPairing(client_name);
      return text({ shown_on: hostname(), expires_at: new Date(expiresAt).toISOString(), ttl_seconds: CODE_TTL_MS / 1000, next: "Ask the person for the code Herdr shows, then call pair_confirm." });
    } catch (e) { return error((e as Error).message); }
  });

  server.registerTool("pair_confirm", {
    description: "Finish pairing with the code the person read in Herdr. Returns a bearer token to send as `Authorization: Bearer <token>` on every request. Keep it secret.",
    inputSchema: { code: z.string().max(12), client_name: z.string().max(80).optional() },
  }, async ({ code, client_name }) => {
    try {
      const { token, id } = k.pairing.confirm(code, client_name);
      return text({ token, client_id: id, header: `Authorization: Bearer ${token}` });
    } catch (e) { return error((e as Error).message); }
  });

  const column = z.enum(COLUMNS);
  const priority = z.number().int().min(0).max(3).describe("0 low, 1 normal, 2 high, 3 urgent");

  server.registerTool("list_projects", { description: "The repos cards can target (key, name, root folder)." },
    authed(() => k.projects()));
  server.registerTool("list_cards", {
    description: "Cards, optionally of one column or project.",
    inputSchema: { column: column.optional(), project: z.string().optional() },
  }, authed(({ column: col, project }: { column?: string; project?: string }) =>
    k.store.cards().filter((c) => (!col || c.column === col) && (!project || c.project === project))));
  server.registerTool("get_card", { description: "One card, with its estimate, factors, waiting reasons and review summary.", inputSchema: { id: z.string() } },
    authed(({ id }: { id: string }) => k.store.get(id) ?? (() => { throw new StoreError(`no card ${id}`, 404); })()));
  server.registerTool("create_card", {
    description: "A new card. In `todo`, it is sent to the project's orchestrator as soon as the scheduler allows; `backlog` (default) keeps it as an idea.",
    inputSchema: {
      title: z.string().min(1).max(500), prompt: z.string().max(100_000).optional(),
      project: z.string().optional().describe("A project key from list_projects"), priority: priority.optional(),
      column: z.enum(["backlog", "todo"]).optional(),
    },
  }, authed((a: any) => k.create(a)));
  server.registerTool("update_card", {
    description: "Change a card's title, prompt, project or priority. A new prompt is estimated again.",
    inputSchema: { id: z.string(), title: z.string().min(1).max(500).optional(), prompt: z.string().max(100_000).optional(), project: z.string().optional(), priority: priority.optional() },
  }, authed(({ id, ...rest }: any) => k.update(id, rest)));
  server.registerTool("move_card", {
    description: "Move a card. `in_progress` sends it to its orchestrator now; Review is reached only when the orchestrator reports the work done.",
    inputSchema: { id: z.string(), column: z.enum(["backlog", "todo", "in_progress", "done"]) },
  }, authed(({ id, column: col }: any) => k.move(id, col)));
  return server;
}

export function mcpHttp(k: Kanban, onPairing: (client: string) => void): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/mcp") return send(res, 404, { error: "the MCP endpoint is /mcp" });
      const token = bearer(req);
      const client = k.pairing.verify(token);
      if (token && !client) return send(res, 401, { error: "unknown or revoked token: pair again" });
      if (req.method !== "POST") return send(res, 405, { error: "POST only (stateless)" });
      const body = await readBody(req);
      const server = mcpServer(k, client, onPairing);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });
}
