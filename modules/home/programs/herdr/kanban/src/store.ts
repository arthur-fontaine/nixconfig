// The cards, settings, known projects and paired clients, in one JSON file written
// atomically (temp file, then rename) a moment after each change.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { COLUMNS, DEFAULT_SETTINGS, type Card, type Column, type Factors, type ManualField, type PairedClient, type Priority, type Project, type Settings } from "./types.ts";

export class StoreError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

interface State {
  next: number;
  cards: Card[];
  settings: Settings;
  projects: Project[];
  clients: PairedClient[];
}

export interface CardInput {
  title?: string;
  prompt?: string;
  project?: string | null;
  priority?: number;
  column?: Column;
  /** Set by hand on a card that exists: marked as the person's, kept by background estimates. */
  estimate?: number;
  factors?: { ramGB?: number; exclusive?: string[] };
}

const MAX_TEXT = 100_000;
export const MAX_ESTIMATE = 100_000_000;
export const MAX_RAM_GB = 512;
/** An exclusive resource's name: "ios-simulator", "my-gpu". */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 40;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export class Store {
  readonly dir: string;
  readonly now: () => number;
  version = 1;
  private state: State;
  private waiters = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
    mkdirSync(dir, { recursive: true });
    this.state = this.load();
  }

  private get file() { return join(this.dir, "state.json"); }

  private load(): State {
    const empty: State = { next: 1, cards: [], settings: { ...DEFAULT_SETTINGS }, projects: [], clients: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      // Cards saved before attachments existed have none.
      const cards = (s.cards ?? []).map((c: Card) => ({ ...c, attachments: c.attachments ?? [] }));
      return { ...empty, ...s, cards, settings: { ...DEFAULT_SETTINGS, ...s.settings } };
    } catch {
      renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
      return empty;
    }
  }

  // Changes are coalesced: one write per burst, always of the latest state.
  private changed_() {
    this.version++;
    this.dirty = true;
    for (const w of this.waiters) w();
    this.waiters.clear();
    if (!this.pending) this.pending = Promise.resolve().then(() => this.write());
  }

  private async write() {
    while (this.dirty) {
      this.dirty = false;
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.file);
    }
    this.pending = null;
  }

  async flush() { while (this.pending) await this.pending; }

  /** Synchronous save, for exit paths. */
  saveNow() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  /** Resolves true when the version moves past `since`, false after `ms`. */
  changed(since: number, ms: number): Promise<boolean> {
    if (this.version > since) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.waiters.delete(wake); resolve(false); }, ms);
      this.waiters.add(wake);
    });
  }

  cards(): Card[] { return this.state.cards; }
  get(id: string): Card | undefined { return this.state.cards.find((c) => c.id === id); }
  private must(id: string): Card {
    const c = this.get(id);
    if (!c) throw new StoreError(`no card ${id}`, 404);
    return c;
  }

  create(input: CardInput): Card {
    const now = this.now();
    const fields = this.validate({ prompt: "", project: null, priority: 1, column: "backlog", ...input }, true);
    const card: Card = {
      id: `k${this.state.next++}`, title: "", prompt: "", project: null, priority: 1, column: "backlog",
      ...fields,
      estimate: null, estimating: false, factors: null,
      createdAt: now, updatedAt: now, movedAt: now, startedAt: null,
      orchestrator: null, review: null, waiting: [], error: null, attachments: [],
    };
    this.state.cards.push(card);
    this.changed_();
    return card;
  }

  update(id: string, input: CardInput): Card {
    const c = this.must(id);
    const { column, estimate, factors, ...fields } = this.validate(input, false);
    // A new prompt is sized again from scratch, edited values included; edits sent with it still apply.
    if (fields.prompt !== undefined && fields.prompt !== c.prompt) { c.estimate = null; c.factors = null; }
    Object.assign(c, fields, { updatedAt: this.now() });
    this.edit(c, estimate, factors);
    if (column && column !== c.column) this.move(id, column);
    else this.changed_();
    return c;
  }

  /** Any column but Review: only the orchestrator's `herdr-kanban review` gets a card there. */
  move(id: string, column: Column): Card {
    const c = this.must(id);
    if (!COLUMNS.includes(column)) throw new StoreError(`no column ${column}`);
    if (column === "review") throw new StoreError("only `herdr-kanban review <id> <summary>` moves a card to Review");
    if (c.column === column) return c;
    c.column = column;
    c.movedAt = c.updatedAt = this.now();
    if (column !== "todo") c.waiting = [];
    if (column === "todo" || column === "backlog") c.error = null;
    this.changed_();
    return c;
  }

  review(id: string, summary: string): Card {
    const c = this.must(id);
    if (typeof summary !== "string" || !summary.trim()) throw new StoreError("a review needs a summary");
    c.column = "review";
    c.review = summary.trim().slice(0, MAX_TEXT);
    c.movedAt = c.updatedAt = this.now();
    c.waiting = [];
    this.changed_();
    return c;
  }

  remove(id: string) {
    this.must(id);
    this.state.cards = this.state.cards.filter((c) => c.id !== id);
    this.changed_();
  }

  /** Daemon-side fields: dispatch, estimates, waiting reasons. */
  patch(id: string, fields: Partial<Card>) {
    const c = this.must(id);
    const before = JSON.stringify(c);
    Object.assign(c, fields);
    if (JSON.stringify(c) !== before) this.changed_();
    return c;
  }

  // Only what differs is marked as the person's: saving the dialog unchanged marks nothing.
  private edit(c: Card, estimate: number | undefined, factors: CardInput["factors"]) {
    if (estimate === undefined && !factors) return;
    const f: Factors = c.factors ? { ...c.factors } : { ramGB: 0, exclusive: [], notes: "" };
    const manual = new Set(f.manual ?? []);
    // Not sized yet: there is nothing to compare with, whatever is sent is the person's.
    const fresh = !c.factors;
    if (estimate !== undefined && estimate !== c.estimate) { c.estimate = estimate; manual.add("estimate"); }
    if (factors?.ramGB !== undefined && (fresh || factors.ramGB !== f.ramGB)) { f.ramGB = factors.ramGB; manual.add("ramGB"); }
    if (factors?.exclusive !== undefined && (fresh || !sameSet(factors.exclusive, f.exclusive))) { f.exclusive = factors.exclusive; manual.add("exclusive"); }
    if (manual.size) c.factors = { ...f, manual: [...manual] };
  }

  /** Sonnet's answer: what the person edited stays as they set it. */
  setEstimate(id: string, tokens: number, factors: Factors) {
    const c = this.must(id);
    const manual = new Set<ManualField>(c.factors?.manual ?? []);
    if (!manual.size) return this.patch(id, { estimate: Math.round(tokens), factors, estimating: false });
    const keep = <K extends ManualField>(k: K, theirs: any, mine: any) => (manual.has(k) ? mine : theirs);
    return this.patch(id, {
      estimate: keep("estimate", Math.round(tokens), c.estimate),
      factors: { ...factors, ramGB: keep("ramGB", factors.ramGB, c.factors!.ramGB), exclusive: keep("exclusive", factors.exclusive, c.factors!.exclusive), manual: [...manual] },
      estimating: false,
    });
  }

  settings(): Settings { return this.state.settings; }
  setSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.state.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) throw new StoreError(`no setting ${k}`);
      const want = typeof (DEFAULT_SETTINGS as any)[k];
      if (typeof v !== want || (want === "number" && (!Number.isFinite(v) || (v as number) < 0))) throw new StoreError(`bad value for ${k}`);
      (next as any)[k] = v;
    }
    this.state.settings = next;
    this.changed_();
    return next;
  }

  projects(): Project[] { return this.state.projects; }
  setProjects(projects: Project[]) {
    if (JSON.stringify(projects) === JSON.stringify(this.state.projects)) return;
    this.state.projects = projects;
    this.changed_();
  }

  /** The live array Pairing edits; call clientsChanged() after. */
  clients(): PairedClient[] { return this.state.clients; }
  clientsChanged() { this.changed_(); }

  private validate(input: CardInput, creating: boolean) {
    const out: CardInput & { priority?: Priority } = {};
    const known = ["title", "prompt", "project", "priority", "column", ...(creating ? [] : ["estimate", "factors"])];
    for (const k of Object.keys(input)) if (!known.includes(k)) throw new StoreError(`unknown field ${k}`);
    if (input.title !== undefined || creating) {
      if (typeof input.title !== "string" || !input.title.trim()) throw new StoreError("a card needs a title");
      out.title = input.title.trim().slice(0, 500);
    }
    if (input.prompt !== undefined) {
      if (typeof input.prompt !== "string") throw new StoreError("prompt must be text");
      out.prompt = input.prompt.slice(0, MAX_TEXT);
    }
    if (input.project !== undefined) {
      if (input.project !== null && typeof input.project !== "string") throw new StoreError("project must be a project key or null");
      out.project = input.project || null;
    }
    if (input.priority !== undefined) {
      if (![0, 1, 2, 3].includes(input.priority)) throw new StoreError("priority is 0 (low) to 3 (urgent)");
      out.priority = input.priority as Priority;
    }
    if (input.column !== undefined) {
      if (!COLUMNS.includes(input.column)) throw new StoreError(`no column ${input.column}`);
      if (input.column === "review") throw new StoreError("only `herdr-kanban review` moves a card to Review");
      out.column = input.column;
    }
    if (input.estimate !== undefined) {
      if (!Number.isInteger(input.estimate) || input.estimate < 1 || input.estimate > MAX_ESTIMATE) throw new StoreError(`estimate is a whole number of tokens, 1 to ${MAX_ESTIMATE}`);
      out.estimate = input.estimate;
    }
    if (input.factors !== undefined) out.factors = this.validateFactors(input.factors);
    return out;
  }

  private validateFactors(f: unknown): NonNullable<CardInput["factors"]> {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new StoreError("factors is an object: { ramGB?, exclusive? }");
    const out: NonNullable<CardInput["factors"]> = {};
    for (const k of Object.keys(f)) if (k !== "ramGB" && k !== "exclusive") throw new StoreError(`factors.${k} can't be set (only ramGB and exclusive)`);
    const { ramGB, exclusive } = f as Record<string, unknown>;
    if (ramGB !== undefined) {
      if (typeof ramGB !== "number" || !Number.isFinite(ramGB) || ramGB < 0 || ramGB > MAX_RAM_GB) throw new StoreError(`factors.ramGB is 0 to ${MAX_RAM_GB} GB`);
      out.ramGB = ramGB;
    }
    if (exclusive !== undefined) {
      if (!Array.isArray(exclusive)) throw new StoreError("factors.exclusive is a list of resource names");
      for (const x of exclusive) {
        if (typeof x !== "string" || x.length > MAX_SLUG || !SLUG.test(x)) throw new StoreError(`factors.exclusive: ${JSON.stringify(x)} isn't a resource name (lowercase letters, digits and dashes, ${MAX_SLUG} at most)`);
      }
      out.exclusive = [...new Set(exclusive as string[])];
    }
    return out;
  }
}
