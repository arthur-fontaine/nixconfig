import type { IncomingMessage, ServerResponse } from "node:http";
import { StoreError } from "./store.ts";
import { PairingError } from "./pairing.ts";

const MAX_BODY = 1 << 20;

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new StoreError("body too large", 413);
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new StoreError("body isn't JSON"); }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

export function fail(res: ServerResponse, e: unknown) {
  if (e instanceof StoreError) return send(res, e.status, { error: e.message });
  if (e instanceof PairingError) return send(res, 429, { error: e.message });
  send(res, 500, { error: (e as Error).message ?? String(e) });
}
