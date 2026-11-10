// Sonnet, through `pi --print`, guesses a card's token cost and what it will need
// (RAM, the iOS simulator, a heavy build): one call per card, one at a time.
import { tmpdir } from "node:os";
import { run } from "./run.ts";
import type { Card, Factors } from "./types.ts";

export const KNOWN_EXCLUSIVE = ["ios-simulator", "android-emulator", "heavy-build", "browser", "docker"];

export function estimatePrompt(card: Card, projectName: string | null): string {
  return `You size coding tasks before an autonomous coding agent (Claude, through Pi, with its own
sub-agents) takes them. Estimate the task below.

Answer with one JSON object and nothing else:
{"tokens": <total tokens the agent and its workers will consume, input + output, an integer>,
 "ramGB": <extra RAM the work needs on this Mac beyond the agent itself, GB, 0 if nothing special>,
 "exclusive": [<resources only one task may use at a time, from: ${KNOWN_EXCLUSIVE.map((x) => `"${x}"`).join(", ")}>],
 "notes": "<one short sentence: why>"}

Typical scale: a one-line fix ~30000 tokens, a small feature ~200000, a large refactor 1000000+.
A Rust or iOS build, a monorepo-wide test run or a bundler is "heavy-build" and several GB.

Project: ${projectName ?? "unknown"}
Title: ${card.title}
Task:
${card.prompt || "(no details)"}${card.attachments?.length ? `\nAttached files: ${card.attachments.map((a) => a.name).join(", ")}` : ""}`;
}

// The first JSON object in the text that has a token count (the answer may quote others).
function firstEstimate(text: string): any {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    for (let j = text.indexOf("}", i); j >= 0; j = text.indexOf("}", j + 1)) {
      try {
        const o = JSON.parse(text.slice(i, j + 1));
        if (o && typeof o === "object" && "tokens" in o) return o;
      } catch { /* not this one */ }
    }
  }
  return null;
}

export function parseEstimate(text: string): { tokens: number; factors: Factors } | null {
  const o = firstEstimate(text);
  if (!o) return null;
  const tokens = Number(o.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const ramGB = Number(o.ramGB);
  const exclusive = Array.isArray(o.exclusive) ? o.exclusive.filter((x: unknown) => typeof x === "string" && KNOWN_EXCLUSIVE.includes(x)) : [];
  return {
    tokens: Math.round(tokens),
    factors: { ramGB: Number.isFinite(ramGB) && ramGB > 0 ? Math.min(ramGB, 256) : 0, exclusive, notes: typeof o.notes === "string" ? o.notes.slice(0, 300) : "" },
  };
}

export type Ask = (prompt: string) => Promise<string>;

/** `pi --print` on Sonnet: no session, no tools, no context files. */
export const askSonnet: Ask = async (prompt) => {
  // Extensions stay on: Pi's claude-code provider, which `sonnet` resolves to, is one.
  const env = process.env.HERDR_KANBAN_ESTIMATOR;
  const argv: string[] = env?.startsWith("[") ? JSON.parse(env) : (env ?? "pi --print --model sonnet --thinking off --no-session --no-tools --no-skills --no-context-files --no-prompt-templates --no-mcp").split(" ");
  const r = await run(argv[0], [...argv.slice(1), prompt], { cwd: tmpdir(), timeout: 180_000 });
  if (r.code !== 0) throw new Error(`estimator exited ${r.code}: ${r.stderr.trim().slice(-300)}`);
  return r.stdout;
};

/** A queue: cards are estimated one by one, in the background. */
export class Estimator {
  private queue: string[] = [];
  private busy = false;
  private ask: Ask;
  private onCard: (id: string) => Promise<void>;

  constructor(ask: Ask, onCard: (id: string, ask: Ask) => Promise<void>) {
    this.ask = ask;
    this.onCard = (id) => onCard(id, this.ask);
  }

  push(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.drain();
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        await this.onCard(id).catch(() => {});
      }
    } finally { this.busy = false; }
  }
}
