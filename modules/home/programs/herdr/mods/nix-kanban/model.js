// nix-kanban's figures, apart from the view so `node --test` runs them: nix joins this
// file into main.js (without `export`).

export const API = "http://127.0.0.1:7742/api";

export const COLUMNS = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "To-do" },
  { id: "in_progress", name: "In progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];
export const PRIORITIES = ["Low", "Normal", "High", "Urgent"];

// Each column in Herdr's own status words, so a card reads like an agent does:
// In progress is working, Review needs the person (blocked), Done is done.
export const columnColor = (t, column) =>
  ({ backlog: t.dim, todo: t.muted, in_progress: t.working, review: t.blocked, done: t.done })[column] ?? t.dim;

export function kTokens(n) {
  if (n == null) return null;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function ago(ms, now = Date.now()) {
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/** Cards by column, each column in the order it is worked: To-do as the scheduler picks. */
export function byColumn(cards) {
  const out = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const c of cards) (out[c.column] ?? out.backlog).push(c);
  out.todo.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  out.backlog.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
  for (const k of ["in_progress", "review", "done"]) out[k].sort((a, b) => b.movedAt - a.movedAt);
  return out;
}

/** The sidebar's short list: what needs the person, what runs, what's next. */
export function glance(cards, limit = 6) {
  const col = byColumn(cards);
  return [...col.review, ...col.in_progress, ...col.todo].slice(0, limit);
}

export const neighbor = (column, step) => {
  const i = COLUMNS.findIndex((c) => c.id === column) + step;
  const next = COLUMNS[i]?.id ?? null;
  // Review is the orchestrator's to reach: arrows step over it.
  if (next === "review") return step > 0 ? "done" : "in_progress";
  return next;
};

export function projectName(projects, key) {
  return projects.find((p) => p.key === key)?.name ?? null;
}

/** What a card shows of Sonnet's prediction: "~120k", "6 GB", "ios-simulator". */
export function factorChips(card) {
  const out = [];
  if (card.estimate != null) out.push(`~${kTokens(card.estimate)} tokens`);
  if (card.factors?.ramGB > 0) out.push(`${Math.round(card.factors.ramGB * 10) / 10} GB`);
  for (const x of card.factors?.exclusive ?? []) out.push(x);
  return out;
}

/** Pairing codes still valid, newest first. */
export function livePending(pending, now = Date.now()) {
  return (pending ?? []).filter((p) => p.expiresAt > now).sort((a, b) => b.expiresAt - a.expiresAt);
}

/** "642 991": a code read aloud in two halves. */
export const spacedCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A number field's text, or null when it isn't one (kept as typed until it is). */
export function parseNumber(text, { min = 0, integer = false } = {}) {
  const s = String(text).trim().replace(/[_\s,]/g, "");
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1);
  if (!Number.isFinite(n) || n < min) return null;
  return integer ? Math.round(n) : n;
}

/** Repo keys the daemon started an orchestrator space for that the sidebar doesn't know. */
export function unrecordedSpaces(cards, recorded, liveSpaceIds) {
  const out = {};
  const latest = [...cards].filter((c) => c.project && c.orchestrator?.space).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const c of latest) {
    if (recorded[c.project] || !liveSpaceIds.has(c.orchestrator.space)) continue;
    out[c.project] = c.orchestrator.space;
  }
  return out;
}
