// Chromecast-style pairing: a remote agent asks (pair_start), Herdr shows a short code,
// the agent sends it back (pair_confirm) and gets a bearer token, kept here only hashed.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { PairedClient } from "./types.ts";

export const CODE_TTL_MS = 120_000;
const WINDOW_MS = 60_000;
const MAX_STARTS = 3; // per window
const MAX_FAILURES = 5; // per window, then confirmation locks and pending codes die

export class PairingError extends Error {}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

interface Pending { code: string; client: string; expiresAt: number }

export class Pairing {
  private clients: PairedClient[];
  private now: () => number;
  private onChange: () => void;
  private codes: Pending[] = [];
  private starts: number[] = [];
  private failures: number[] = [];

  constructor(o: { clients: PairedClient[]; now?: () => number; onChange: () => void }) {
    this.clients = o.clients;
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange;
  }

  private prune() {
    const t = this.now();
    this.codes = this.codes.filter((c) => c.expiresAt > t);
    this.starts = this.starts.filter((s) => s > t - WINDOW_MS);
    this.failures = this.failures.filter((s) => s > t - WINDOW_MS);
  }

  start(client: string): { expiresAt: number } {
    this.prune();
    if (this.starts.length >= MAX_STARTS) throw new PairingError("too many pairing requests, try again in a minute");
    this.starts.push(this.now());
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (this.codes.some((c) => c.code === code));
    const p = { code, client: (client || "remote agent").slice(0, 80), expiresAt: this.now() + CODE_TTL_MS };
    this.codes.push(p);
    this.onChange();
    return { expiresAt: p.expiresAt };
  }

  pending(): Pending[] {
    this.prune();
    return this.codes.map((c) => ({ ...c }));
  }

  confirm(code: string, name?: string): { token: string; id: string } {
    this.prune();
    if (this.failures.length >= MAX_FAILURES) throw new PairingError("too many wrong codes, try again in a minute");
    const i = this.codes.findIndex((c) => c.code === String(code).trim());
    if (i < 0) {
      this.failures.push(this.now());
      if (this.failures.length >= MAX_FAILURES) this.codes = [];
      this.onChange();
      throw new PairingError("invalid or expired code");
    }
    const [p] = this.codes.splice(i, 1);
    const token = randomBytes(32).toString("base64url");
    const client: PairedClient = {
      id: randomBytes(6).toString("hex"), name: (name || p.client).slice(0, 80), hash: hashToken(token),
      createdAt: this.now(), lastUsedAt: null,
    };
    this.clients.push(client);
    this.onChange();
    return { token, id: client.id };
  }

  verify(token: string | undefined | null): PairedClient | null {
    if (!token) return null;
    const h = Buffer.from(hashToken(token), "hex");
    const c = this.clients.find((x) => timingSafeEqual(Buffer.from(x.hash, "hex"), h));
    if (!c) return null;
    // Not worth a write of its own: saved with the next change.
    c.lastUsedAt = this.now();
    return c;
  }

  list() { return this.clients.map(({ hash: _h, ...c }) => c); }

  revoke(id: string): boolean {
    const i = this.clients.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.clients.splice(i, 1);
    this.onChange();
    return true;
  }
}
