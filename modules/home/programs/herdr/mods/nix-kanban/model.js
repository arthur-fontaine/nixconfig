// nix-kanban's figures, apart from the view so `node --test` runs them: nix joins this
// file into main.js (without `export`).

export const API = "http://127.0.0.1:7742/api";

// icon: one of nix-head's icons, the same wherever the column shows. As Linear and GitHub
// Projects: a circle that fills as the work goes, dashed while it's only an idea.
export const COLUMNS = [
  { id: "backlog", name: "Backlog", icon: "circle-dashed" },
  { id: "todo", name: "To-do", icon: "circle" },
  { id: "in_progress", name: "In progress", icon: "circle-half" },
  { id: "review", name: "Review", icon: "circle-three-quarters" },
  { id: "done", name: "Done", icon: "circle-check-filled" },
];
export const PRIORITIES = ["Low", "Normal", "High", "Urgent"];

// The Kanban sidebar's sections, top to bottom: the board's columns, in the order work goes.
export const SIDE_ORDER = COLUMNS.map((c) => c.id);
export const FOLDED_BY_DEFAULT = ["backlog", "done"];

/** Whether a sidebar section is folded: the person's choice, else the default. */
export const isFolded = (folds, column) => folds?.[column] ?? FOLDED_BY_DEFAULT.includes(column);

/** A scheduler reason, in the words the sidebar and the board both show. */
export function shortReason(w) {
  if (w === "no project picked") return "needs a project";
  if (/^RAM:/.test(w)) return "waiting: RAM";
  if (/^orchestrator /.test(w)) return "orchestrator busy";
  if (/^token budget/.test(w)) return "waiting: budget";
  if (/^\d+\/0 cards in progress/.test(w)) return "paused";
  const slots = /^(\d+\/\d+) cards in progress/.exec(w);
  if (slots) return `waiting: ${slots[1]} running`;
  const held = /^(.+) held by /.exec(w);
  if (held) return `waiting: ${held[1]}`;
  return `waiting: ${w}`;
}

/** A To-do card's line: the scheduler's first reason, short (all of them go in the tooltip). */
export const waitLabel = (card) => (card.waiting?.[0] ? shortReason(card.waiting[0]) : "next");

/** Every reason a To-do card waits, short and once each, for the board's card. */
export const waitLabels = (card) => [...new Set((card.waiting ?? []).map(shortReason))];

/** A review summary's first line, for a card that has room for one. */
export const firstLine = (text) => (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// Each column's tint, as Linear's: the waiting ones grey, In progress amber, Review green,
// Done the accent. The theme's ansi yellow and green, not its working (grey) and done.
export const columnColor = (t, column) =>
  ({ backlog: t.dim, todo: t.muted, in_progress: t.ansi3, review: t.ansi2, done: t.accent })[column] ?? t.dim;

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

/** The daemon's API: the launchd one, or a test daemon's port (a `port` prop). */
export function apiBase(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? `http://127.0.0.1:${n}/api` : API;
}

/** "900 B", "117 KB", "3.2 MB": an attachment's size. */
export function fileSize(n) {
  if (n < 1024) return `${n} B`;
  const [v, unit] = n < 1024 ** 2 ? [n / 1024, "KB"] : n < 1024 ** 3 ? [n / 1024 ** 2, "MB"] : [n / 1024 ** 3, "GB"];
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${unit}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?|svg)$/i;
/** Whether an attachment shows as a thumbnail (others as a chip). */
export const isImage = (a) => /^image\//.test(a.mime ?? "") || IMAGE_EXT.test(a.name ?? "");

/** The file picker's answer: one POSIX path a line. */
export const pickedPaths = (stdout) => String(stdout).split("\n").filter(Boolean);

/** As macOS names screenshots: "Pasted image 2026-11-10 at 09.05.03.png". */
export function pastedName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `Pasted image ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
}

// ---- A card's estimate, edited in its dialog ----

/** The names Sonnet picks exclusive resources from: the daemon's estimator.ts KNOWN_EXCLUSIVE. */
export const KNOWN_EXCLUSIVE = ["ios-simulator", "android-emulator", "heavy-build", "browser", "docker"];
// The daemon's bounds (kanban/src/store.ts).
const MAX_ESTIMATE = 100_000_000;
const MAX_RAM_GB = 512;

/** Whether the person set some of the card's estimate by hand. */
export const isEdited = (card) => (card.factors?.manual?.length ?? 0) > 0;

/** The dialog's fields for a card's estimate, as text and a list. */
export function estimateDraft(card) {
  return {
    tokens: card.estimate != null ? kTokens(card.estimate) : "",
    ram: card.factors ? String(Math.round(card.factors.ramGB * 10) / 10) : "",
    exclusive: [...(card.factors?.exclusive ?? [])],
  };
}

/**
 * What Save sends for the estimate: only the fields that differ from what the dialog
 * showed (the tokens field shows "412k", not the exact count), or the first error.
 */
export function estimateEdits(draft, initial) {
  const body = {};
  const factors = {};
  if (draft.tokens.trim() !== initial.tokens) {
    const n = parseNumber(draft.tokens, { min: 1, integer: true });
    if (n === null || n > MAX_ESTIMATE) return { error: "Tokens: a whole number, as 250k, 1.5M or 250000 (100M at most)." };
    body.estimate = n;
  }
  if (draft.ram.trim() !== initial.ram) {
    const n = parseNumber(draft.ram);
    if (n === null || n > MAX_RAM_GB) return { error: `RAM: a number of GB, 0 to ${MAX_RAM_GB}.` };
    factors.ramGB = Math.round(n * 10) / 10;
  }
  const a = draft.exclusive, b = initial.exclusive;
  if (a.length !== b.length || a.some((x) => !b.includes(x))) factors.exclusive = [...a];
  if (Object.keys(factors).length) body.factors = factors;
  return { body };
}

/** A resource typed in the dialog, as the daemon takes it ("My GPU" → "my-gpu"), or null. */
export function resourceName(text) {
  const s = String(text).trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  return s.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) ? s : null;
}
