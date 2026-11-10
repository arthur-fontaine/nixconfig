export const COLUMNS = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = 0 | 1 | 2 | 3;

/** What Sonnet predicts a card will need, for the scheduler. */
export interface Factors {
  /** RAM the work will take on top of what's running, in GB. */
  ramGB: number;
  /** Resources only one card may hold at a time: "ios-simulator", "heavy-build", ... */
  exclusive: string[];
  notes: string;
  /** What the person set by hand (the card's estimate included): a background estimate keeps it. */
  manual?: ManualField[];
}

export const MANUAL_FIELDS = ["estimate", "ramGB", "exclusive"] as const;
export type ManualField = (typeof MANUAL_FIELDS)[number];

export interface OrchestratorRef {
  terminal: string;
  name: string;
  space: string | null;
}

/** A file attached to a card: the daemon's own copy, under its state dir. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string | null;
  /** Absolute. */
  path: string;
}

export interface Card {
  id: string;
  title: string;
  prompt: string;
  /** A project key (see projects.ts), or null until one is picked. */
  project: string | null;
  priority: Priority;
  /** Estimated tokens, null until Sonnet has answered. */
  estimate: number | null;
  estimating: boolean;
  factors: Factors | null;
  column: Column;
  createdAt: number;
  updatedAt: number;
  movedAt: number;
  startedAt: number | null;
  orchestrator: OrchestratorRef | null;
  review: string | null;
  /** Why a To-do card hasn't started, from the last scheduler pass. */
  waiting: string[];
  error: string | null;
  attachments: Attachment[];
}

export interface Settings {
  maxInProgress: number;
  /** Cards start only while at least this much RAM stays free (GB). */
  minFreeRamGB: number;
  /** Tokens the cards started within the window may add up to. */
  tokenBudget: number;
  budgetWindowHours: number;
  /** What a card not estimated yet counts as. */
  defaultEstimate: number;
  mcpEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxInProgress: 2,
  minFreeRamGB: 4,
  tokenBudget: 2_000_000,
  budgetWindowHours: 5,
  defaultEstimate: 100_000,
  mcpEnabled: false,
};

export interface Project {
  /** The nix-sidebar's repo key: JSON [machine, git common dir]. */
  key: string;
  name: string;
  /** The repo's own folder, where its project orchestrator runs. */
  root: string;
}

export interface PairedClient {
  id: string;
  name: string;
  /** sha256 of the bearer token, hex. */
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export type OrchestratorStatus = "missing" | "idle" | "done" | "working" | "blocked" | "error" | "unknown";
