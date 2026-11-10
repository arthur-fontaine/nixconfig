// The project orchestrators: found in Herdr's spaces, started the way nix-sidebar starts
// them, and given a card with `hc send`.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { run } from "./run.ts";
import type { Card, OrchestratorRef, OrchestratorStatus, Project } from "./types.ts";
import { PRIORITIES } from "./types.ts";

// As nix-sidebar's orchestratorName / orchestratorArgv / isOrchestrator (keep them in step).
export const orchestratorName = (label: string) => `${label.replace(/[^A-Za-z0-9._-]+/g, "-")}-project-orchestrator`;
export const orchestratorArgv = (label: string, home = homedir()) =>
  ["pi", "--name", orchestratorName(label), "--append-system-prompt", `${home}/.pi/agent/orchestrator/project.md`];
export const isOrchestratorTab = (name: string) => /^Orchestrator$|-(project-)?orchestrator$/.test(name);

export interface LsTerminal { terminal: string; status: string | null; app: string | null }
export interface LsTab { id: string; name: string; terminals: LsTerminal[] }
export interface LsSpace { id: string; name: string; folder: string; machine: string | null; tabs: LsTab[] }

export interface Found { terminal: string | null; space: string; tab: string | null; status: OrchestratorStatus }

/**
 * The project's orchestrator in `herdr-app ls`: in the space the sidebar recorded for the
 * project, else in a tab named after it. `terminal: null` when its space is there but Pi
 * isn't running in it (it exited to its shell): a new tab is needed.
 */
export function findOrchestrator(spaces: LsSpace[], project: Project, projectSpace: string | null): Found | null {
  const local = spaces.filter((s) => !s.machine);
  const name = orchestratorName(project.name);
  const pick = (s: LsSpace, tabs: LsTab[]): Found => {
    for (const t of tabs) {
      const pi = t.terminals.find((x) => x.app === "pi");
      if (pi) return { terminal: pi.terminal, space: s.id, tab: t.id, status: toStatus(pi.status) };
    }
    return { terminal: null, space: s.id, tab: null, status: "missing" };
  };
  const recorded = projectSpace ? local.find((s) => s.id === projectSpace) : undefined;
  if (recorded) return pick(recorded, recorded.tabs.filter((t) => isOrchestratorTab(t.name)));
  for (const s of local) {
    const tabs = s.tabs.filter((t) => t.name === name);
    if (tabs.length) return pick(s, tabs);
  }
  return null;
}

export function toStatus(s: string | null | undefined): OrchestratorStatus {
  return s === "idle" || s === "done" || s === "working" || s === "blocked" || s === "error" ? s : s == null ? "idle" : "unknown";
}

/** What the orchestrator is told: the card, and how to hand it back for review. */
export function dispatchText(card: Card, cli: string): string {
  return `Kanban card ${card.id} (${PRIORITIES[card.priority]} priority): ${card.title}

${card.prompt.trim() || "(no details beyond the title)"}

This task comes from the Herdr kanban: handle it as a request from the person, with workers in the right worktree as usual. When it is finished and ready for a human review, run once, at the very end:
${cli} review ${card.id} "<two sentences: what was done, and what the person should check>"
That command moves the card to Review. If you are stuck, ask the person (ask_user_question) instead.`;
}

export interface Herdr {
  ls(): Promise<LsSpace[] | null>;
  start(project: Project, inSpace: string | null, task: string): Promise<OrchestratorRef>;
  send(terminal: string, status: OrchestratorStatus, text: string): Promise<void>;
}

const json = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

export const herdr: Herdr = {
  async ls() {
    const r = await run("herdr-app", ["ls"], { timeout: 10_000 });
    return r.code === 0 ? json(r.stdout)?.spaces ?? null : null;
  },

  async start(project, inSpace, task) {
    const name = orchestratorName(project.name);
    const argv = orchestratorArgv(project.name);
    // Its own space at the repo's root, as the sidebar makes it; a new tab when its space
    // is still there; `hc run` with Herdr's labels when the window isn't open.
    const args = inSpace
      ? ["do", "tab.new", "--space", inSpace, "--name", name, "--folder", project.root, "--argv", JSON.stringify(argv), "--task", task]
      : ["do", "space.new", "--name", `${project.name} project`, "--folder", project.root, "--tab", name, "--argv", JSON.stringify(argv), "--task", task];
    const r = await run("herdr-app", args, { timeout: 30_000 });
    const out = json(r.stdout);
    if (r.code === 0 && out?.terminal) return { terminal: out.terminal, name, space: out.space ?? inSpace };
    const space = inSpace ?? `sp${randomBytes(16).toString("hex")}`;
    const tab = `tb${randomBytes(16).toString("hex")}`;
    const h = await run("hc", ["run", "--json", "--bg", "--keep", "--no-parent", "--outlive-parent", "--cwd", project.root,
      "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`, "--", ...argv, task], { timeout: 90_000 });
    const made = json(h.stdout);
    if (h.code !== 0 || !made?.address) throw new Error(`couldn't start ${name}: ${(out?.error ?? r.stderr ?? "").toString().slice(0, 200)} / ${h.stderr.slice(0, 200) || h.stdout.slice(0, 200)}`);
    if (made.first_message && made.first_message.sent === false) throw new Error(`${name} started as ${made.address} but its task wasn't delivered: ${made.first_message.reason ?? "unknown"}`);
    return { terminal: made.address, name, space };
  },

  async send(terminal, status, text) {
    let r = await run("hc", sendArgs(terminal, status, text), { timeout: 60_000 });
    if (finishedTurn(r)) r = await run("hc", sendArgs(terminal, "done", text), { timeout: 60_000 });
    if (r.code !== 0) throw new Error(`hc send ${terminal}: ${hcError(r)?.message ?? (r.stderr || r.stdout).slice(0, 300)}`);
  },
};

// `--if idle` keeps a card out of a chat that started working since the scheduler looked.
// hc's `--if` knows idle and working only, and Herdr may call idle a chat hc calls done (its
// turn ended, nothing typed since): free all the same, so that one is sent without the guard.
export const sendArgs = (terminal: string, status: OrchestratorStatus, text: string) =>
  ["send", "--json", ...(status === "idle" ? ["--if", "idle"] : []), terminal, text];

const hcError = (r: { stdout: string; stderr: string }): { kind?: string; message?: string } | undefined =>
  json(r.stderr)?.error ?? json(r.stdout)?.error;

/** hc refused `--if idle` because the chat is done, not because it is working. */
export const finishedTurn = (r: { code: number; stdout: string; stderr: string }) => {
  const e = hcError(r);
  return r.code === 10 && e?.kind === "status_mismatch" && / is done,/.test(e.message ?? "");
};
