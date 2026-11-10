// The daemon's core: the store, the scheduler loop that moves To-do cards to In
// progress by sending them to their project's orchestrator, and Sonnet's estimates.
import { Store, StoreError, type CardInput } from "./store.ts";
import { Pairing } from "./pairing.ts";
import { FACTORS, plan, type Factor } from "./scheduler.ts";
import { Estimator, askSonnet, estimatePrompt, parseEstimate, type Ask } from "./estimator.ts";
import { dispatchText, findOrchestrator, herdr as realHerdr, type Found, type Herdr } from "./herdr.ts";
import { discover, projectSpaces } from "./projects.ts";
import { freeRamGB } from "./system.ts";
import type { Card, Column, OrchestratorStatus, Project } from "./types.ts";

export interface KanbanOptions {
  dir: string;
  /** How the orchestrator reaches us: `herdr-kanban` on PATH, or a test's own command. */
  cli?: string;
  herdr?: Herdr;
  ask?: Ask;
  ram?: () => Promise<number | null>;
  factors?: Factor[];
  tickMs?: number;
  log?: (msg: string) => void;
}

const RETRY_MS = 120_000;

// A dispatch that failed is retried, but not at once.
const backoff: Factor = {
  name: "retry-after-error",
  check: (c, ctx) => (c.error && ctx.now - c.movedAt < RETRY_MS ? `retrying soon after: ${c.error}` : null),
};

export class Kanban {
  readonly store: Store;
  readonly pairing: Pairing;
  readonly cli: string;
  private herdr: Herdr;
  private ram: () => Promise<number | null>;
  private factors: Factor[];
  private estimator: Estimator;
  private log: (msg: string) => void;
  private orchestrators = new Map<string, Found | null>();
  private freeRam: number | null = null;
  private ticking: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private tickMs: number;

  constructor(o: KanbanOptions) {
    this.store = new Store(o.dir);
    this.pairing = new Pairing({ clients: this.store.clients(), onChange: () => this.store.clientsChanged() });
    this.cli = o.cli ?? "herdr-kanban";
    this.herdr = o.herdr ?? realHerdr;
    this.ram = o.ram ?? freeRamGB;
    this.factors = [...(o.factors ?? FACTORS), backoff];
    this.log = o.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.tickMs = o.tickMs ?? 15_000;
    this.estimator = new Estimator(o.ask ?? askSonnet, (id, ask) => this.estimate(id, ask));
  }

  start() {
    // A card that was being estimated when the daemon stopped is asked again.
    for (const c of this.store.cards()) {
      if (c.estimating) this.store.patch(c.id, { estimating: false });
      if (c.estimate === null && c.column !== "done") this.estimator.push(c.id);
    }
    this.timer = setInterval(() => this.poke(), this.tickMs);
    this.poke();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  // ---- Edits (from the local API and MCP) ----

  create(input: CardInput): Card {
    if (input.project) this.mustProject(input.project);
    const c = this.store.create(input);
    this.estimator.push(c.id);
    this.poke();
    return c;
  }

  update(id: string, input: CardInput): Card {
    if (input.project) this.mustProject(input.project);
    const { column, ...fields } = input;
    const c = this.store.update(id, fields);
    if (c.estimate === null) this.estimator.push(c.id);
    if (column) return this.move(id, column);
    this.poke();
    return c;
  }

  /** Dragging a card into In progress starts it now, whatever the factors say. */
  move(id: string, column: Column): Card {
    const c = this.store.get(id);
    if (!c) throw new StoreError(`no card ${id}`, 404);
    if (column === "in_progress" && c.column !== "in_progress") {
      if (!c.project) throw new StoreError("pick a project first");
      this.mark(c);
      void this.refresh().then(() => this.deliver(c)).catch((e) => this.log(`${id}: ${e}`));
      return c;
    }
    this.store.move(id, column);
    this.poke();
    return c;
  }

  review(id: string, summary: string): Card {
    const c = this.store.review(id, summary);
    this.log(`${id} → review: ${summary.slice(0, 120)}`);
    this.poke();
    return c;
  }

  remove(id: string) { this.store.remove(id); this.poke(); }

  reestimate(id: string) {
    if (!this.store.get(id)) throw new StoreError(`no card ${id}`, 404);
    this.store.patch(id, { estimate: null, factors: null });
    this.estimator.push(id);
  }

  projects(): Project[] { return this.store.projects(); }

  private mustProject(key: string) {
    if (!this.store.projects().some((p) => p.key === key)) throw new StoreError(`unknown project ${key} (see list_projects)`);
  }

  // ---- The scheduler ----

  /** Schedule a pass soon; passes never overlap (a poke during one runs another after). */
  poke() {
    if (this.ticking) { this.again = true; return; }
    this.ticking = (async () => {
      do {
        this.again = false;
        try { await this.tick(); } catch (e) { this.log(`tick failed: ${(e as Error).stack}`); }
      } while (this.again);
      this.ticking = null;
    })();
  }

  /** Resolves once the current pass (and any it queued) is over. */
  async settled() { while (this.ticking) await this.ticking; }

  async refresh() {
    const [spaces, ram, recorded] = await Promise.all([this.herdr.ls(), this.ram(), projectSpaces()]);
    this.freeRam = ram;
    if (spaces) {
      this.store.setProjects(await discover(spaces.filter((s) => !s.machine).map((s) => s.folder), this.store.projects()));
      for (const p of this.store.projects()) this.orchestrators.set(p.key, findOrchestrator(spaces, p, recorded[p.key] ?? this.startedSpace(p.key)));
    }
  }

  // The space this daemon last started the project's orchestrator in, until the sidebar records it.
  private startedSpace(key: string): string | null {
    const cs = this.store.cards().filter((c) => c.project === key && c.orchestrator?.space).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return cs[0]?.orchestrator?.space ?? null;
  }

  orchestratorStatus(key: string): OrchestratorStatus {
    return this.orchestrators.get(key)?.status ?? "missing";
  }

  async tick() {
    await this.refresh();
    const now = Date.now();
    const { start, waiting } = plan({
      now, settings: this.store.settings(), cards: this.store.cards(), freeRamGB: this.freeRam,
      orchestratorStatus: (p) => this.orchestratorStatus(p),
    }, this.factors);
    for (const c of this.store.cards()) if (c.column === "todo") this.store.patch(c.id, { waiting: waiting.get(c.id) ?? [] });
    for (const c of start) this.mark(c);
    for (const c of start) await this.deliver(c);
  }

  // In progress at once, so no other pass picks it while it's being delivered.
  private mark(card: Card) {
    const now = Date.now();
    this.store.patch(card.id, { column: "in_progress", startedAt: now, movedAt: now, waiting: [], error: null, review: null });
  }

  private async deliver(card: Card) {
    const project = this.store.projects().find((p) => p.key === card.project);
    const found = project ? this.orchestrators.get(project.key) ?? null : null;
    try {
      if (!project) throw new Error("its project isn't known any more");
      const text = dispatchText(card, this.cli);
      let ref;
      if (found?.terminal) {
        await this.herdr.send(found.terminal, found.status, text);
        ref = { terminal: found.terminal, name: project.name, space: found.space };
      } else {
        ref = await this.herdr.start(project, found?.space ?? null, text);
      }
      this.store.patch(card.id, { orchestrator: ref });
      // Until the next look, the orchestrator counts as working on it.
      this.orchestrators.set(project.key, { terminal: ref.terminal, space: ref.space ?? "", tab: null, status: "working" });
      this.log(`${card.id} → ${ref.terminal} (${project.name})`);
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`${card.id} dispatch failed: ${msg}`);
      this.store.patch(card.id, { column: "todo", startedAt: null, movedAt: Date.now(), error: msg.slice(0, 500) });
    }
  }

  // ---- Estimates ----

  private async estimate(id: string, ask: Ask) {
    const c = this.store.get(id);
    if (!c || c.estimate !== null || c.column === "done") return;
    this.store.patch(id, { estimating: true });
    try {
      const name = this.store.projects().find((p) => p.key === c.project)?.name ?? null;
      const r = parseEstimate(await ask(estimatePrompt(c, name)));
      if (!this.store.get(id)) return;
      if (!r) throw new Error("no estimate in Sonnet's answer");
      this.store.setEstimate(id, r.tokens, r.factors);
      this.log(`${id} estimated: ${r.tokens} tokens ${JSON.stringify(r.factors)}`);
      this.poke();
    } catch (e) {
      this.log(`${id} estimate failed: ${(e as Error).message}`);
      if (this.store.get(id)) this.store.patch(id, { estimating: false });
    }
  }

  // ---- What the UI shows ----

  snapshot(extra: Record<string, unknown> = {}) {
    const orchestrators: Record<string, OrchestratorStatus> = {};
    for (const p of this.store.projects()) orchestrators[p.key] = this.orchestratorStatus(p.key);
    return {
      version: this.store.version,
      cards: this.store.cards(),
      settings: this.store.settings(),
      projects: this.store.projects(),
      orchestrators,
      freeRamGB: this.freeRam,
      pairing: { pending: this.pairing.pending(), clients: this.pairing.list() },
      ...extra,
    };
  }
}
