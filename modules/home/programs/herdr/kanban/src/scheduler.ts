// Which To-do cards start now. Each factor looks at one card against what is
// running (plus what this pass already started) and answers null (fine) or why not.
import type { Card, OrchestratorStatus, Settings } from "./types.ts";

export interface SchedulerContext {
  now: number;
  settings: Settings;
  cards: Card[];
  /** Free RAM in GB, null when it couldn't be read (then RAM never blocks). */
  freeRamGB: number | null;
  orchestratorStatus: (project: string) => OrchestratorStatus;
}

export interface Factor {
  name: string;
  /** `running`: in-progress cards, including those started earlier in this pass. */
  check: (card: Card, ctx: SchedulerContext, running: Card[]) => string | null;
}

const tokens = (c: Card, s: Settings) => c.estimate ?? s.defaultEstimate;
const gb = (n: number) => `${Math.round(n * 10) / 10} GB`;
const k = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1e3)}k`);

export const FACTORS: Factor[] = [
  {
    name: "project",
    check: (c) => (c.project ? null : "no project picked"),
  },
  {
    name: "max-in-progress",
    check: (_c, ctx, running) =>
      running.length >= ctx.settings.maxInProgress ? `${running.length}/${ctx.settings.maxInProgress} cards in progress` : null,
  },
  {
    name: "orchestrator-free",
    check: (c, ctx, running) => {
      if (!c.project) return null;
      const other = running.find((r) => r.project === c.project);
      if (other) return `orchestrator busy with ${other.id}`;
      const status = ctx.orchestratorStatus(c.project);
      return status === "working" || status === "blocked" || status === "error" ? `orchestrator is ${status}` : null;
    },
  },
  {
    name: "free-ram",
    check: (c, ctx, running) => {
      if (ctx.freeRamGB === null) return null;
      // Cards started in this pass haven't taken their RAM yet: count it now.
      const reserved = running.filter((r) => r.startedAt === ctx.now).reduce((n, r) => n + (r.factors?.ramGB ?? 0), 0);
      const free = ctx.freeRamGB - reserved;
      const need = ctx.settings.minFreeRamGB + (c.factors?.ramGB ?? 0);
      return free < need ? `RAM: ${gb(free)} free, needs ${gb(need)}` : null;
    },
  },
  {
    name: "token-budget",
    check: (c, ctx) => {
      const s = ctx.settings;
      const since = ctx.now - s.budgetWindowHours * 3600_000;
      const used = ctx.cards.filter((x) => x.startedAt !== null && x.startedAt >= since && x.id !== c.id).reduce((n, x) => n + tokens(x, s), 0);
      const want = tokens(c, s);
      return used + want > s.tokenBudget ? `token budget: ${k(used)} used + ${k(want)} > ${k(s.tokenBudget)} per ${s.budgetWindowHours}h` : null;
    },
  },
  {
    name: "exclusive",
    check: (c, _ctx, running) => {
      for (const res of c.factors?.exclusive ?? []) {
        const holder = running.find((r) => r.factors?.exclusive.includes(res));
        if (holder) return `${res} held by ${holder.id}`;
      }
      return null;
    },
  },
];

export function orderTodo(cards: Card[]): Card[] {
  return cards.filter((c) => c.column === "todo").sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

export function plan(ctx: SchedulerContext, factors: Factor[] = FACTORS) {
  const start: Card[] = [];
  const waiting = new Map<string, string[]>();
  const running = ctx.cards.filter((c) => c.column === "in_progress");
  // Started cards count toward the budget and RAM of the rest of the pass.
  const view: SchedulerContext = { ...ctx, cards: ctx.cards.map((c) => ({ ...c })) };
  for (const card of orderTodo(ctx.cards)) {
    const reasons = factors.map((f) => f.check(card, view, running)).filter((r): r is string => r !== null);
    if (reasons.length) { waiting.set(card.id, reasons); continue; }
    start.push(card);
    const started = { ...card, column: "in_progress" as const, startedAt: ctx.now };
    running.push(started);
    view.cards = view.cards.map((c) => (c.id === card.id ? started : c));
  }
  return { start, waiting };
}
