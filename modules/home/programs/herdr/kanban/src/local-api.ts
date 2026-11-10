// The local API: plain HTTP JSON on 127.0.0.1, for the nix-kanban mod and the CLI.
// No auth (only this user's processes reach loopback), but browsers are kept out: a Host
// that isn't loopback (DNS rebinding) is refused, and changes need a JSON content type
// (a page can't send that cross-origin without a preflight we never answer).
import { createServer, type Server } from "node:http";
import { readBody, send, fail } from "./http.ts";
import { StoreError } from "./store.ts";
import type { Kanban } from "./kanban.ts";
import type { Column } from "./types.ts";

export interface LocalApiHooks {
  /** Settings changed: the MCP listener follows mcpEnabled. */
  onSettings: () => Promise<void>;
  mcp: () => { enabled: boolean; listening: boolean; port: number; error: string | null };
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function localApi(k: Kanban, hooks: LocalApiHooks): Server {
  return createServer(async (req, res) => {
    try {
      if (!LOOPBACK.test(req.headers.host ?? "")) return send(res, 403, { error: "loopback only" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "DELETE" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return send(res, 415, { error: "send application/json" });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return send(res, 404, { error: "not found" });
      const [, what, id, action] = parts;
      const body = method === "POST" || method === "PATCH" ? ((await readBody(req)) as any) : {};
      const snapshot = () => k.snapshot({ mcp: hooks.mcp() });

      if (what === "state" && method === "GET") {
        // Long poll: ?since=<version> waits (25 s at most) for anything newer.
        const since = Number(url.searchParams.get("since") ?? 0);
        if (since) await k.store.changed(since, Math.min(Number(url.searchParams.get("wait") ?? 25_000), 60_000));
        return send(res, 200, snapshot());
      }
      if (what === "cards") {
        if (!id && method === "GET") return send(res, 200, k.store.cards());
        if (!id && method === "POST") return send(res, 201, k.create(body));
        if (id && !action && method === "GET") {
          const c = k.store.get(id);
          return c ? send(res, 200, c) : send(res, 404, { error: `no card ${id}` });
        }
        if (id && !action && method === "PATCH") return send(res, 200, k.update(id, body));
        if (id && !action && method === "DELETE") { k.remove(id); return send(res, 200, { ok: true }); }
        if (id && action === "move" && method === "POST") return send(res, 200, k.move(id, body.column as Column));
        if (id && action === "review" && method === "POST") return send(res, 200, k.review(id, body.summary));
        if (id && action === "estimate" && method === "POST") { k.reestimate(id); return send(res, 202, { ok: true }); }
      }
      if (what === "settings") {
        if (method === "GET") return send(res, 200, k.store.settings());
        if (method === "PATCH") {
          const s = k.store.setSettings(body);
          await hooks.onSettings();
          k.poke();
          return send(res, 200, s);
        }
      }
      if (what === "projects" && !id && method === "GET") return send(res, 200, k.projects());
      if (what === "projects" && !id && method === "POST") return send(res, 201, await k.addProject(body.folder));
      if (what === "projects" && id === "refresh" && method === "POST") { await k.refresh(); return send(res, 200, k.projects()); }
      if (what === "pairing" && method === "GET") return send(res, 200, { pending: k.pairing.pending(), clients: k.pairing.list() });
      if (what === "clients" && id && method === "DELETE") {
        if (!k.pairing.revoke(id)) throw new StoreError(`no client ${id}`, 404);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: `no route ${method} ${url.pathname}` });
    } catch (e) { fail(res, e); }
  });
}
