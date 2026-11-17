// What a worktree row does (k31): a click goes there and starts nothing; the worktree's
// orchestrator is started on demand. Pure: it returns the commands to run. nix joins it
// into nix-sidebar, nix-menu and nix-new (no imports, `wt` prefix).

// Orchestrator tabs, both scopes: "<worktree>-orchestrator", "<repo>-project-orchestrator",
// and "Orchestrator" from before they were named. kanban/src/herdr.ts has the same rule
// (isOrchestratorTab); a test keeps them in step.
export const ORCHESTRATOR_RE = /^Orchestrator$|-(project-)?orchestrator$/;

// The sessions the + popover leaves out of its resume list: orchestrators, and pi-subagents'
// workers ("general-purpose#534df88b"). A close can't call those resumable.
export const sessionHidden = (name) => ORCHESTRATOR_RE.test(name ?? "") || /#[0-9a-f]{6,}$/.test(name ?? "");
// Pi's folder for a cwd's sessions, as nix-new reads it: "/Users/a/x" → "--Users-a-x--".
export const wtSessionDirName = (path) => `--${String(path).replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}--`;

const wtName = (label) => `${String(label).replace(/[^A-Za-z0-9._-]+/g, "-")}-orchestrator`;
// As nix-sidebar's orchestratorArgv("worktree", label): Pi named after it, with its role.
export const wtArgv = (label, home) => ["pi", "--name", wtName(label), "--append-system-prompt", `${home}/.pi/agent/orchestrator/worktree.md`];

// A click: its space as it was left (Herdr shows its last tab); without one, a plain shell.
export function wtClick({ space, path, machine }) {
  return space ? [["space.select", { id: space.id }]] : [["space.new", { folder: path, machine: machine ?? "" }]];
}

// "Orchestrator": the worktree's one if it's there, else a new one (one per worktree: a second
// Pi with the same --name would break @mentions).
export function wtOrchestrator({ space, label, folder, home, machine }) {
  const name = wtName(label), argv = wtArgv(label, home);
  if (!space) return [["space.new", { folder, machine: machine ?? "", tab: name, argv }]];
  // Any worktree orchestrator in the space: its name may be from another folder (a cd, a rename).
  // A project's space (the kanban dispatches to its orchestrator) gets no second one: that one.
  const tabs = (space.tabs ?? []).filter((t) => t.named && ORCHESTRATOR_RE.test(t.name));
  const tab = tabs.find((t) => !/-project-orchestrator$/.test(t.name)) ?? tabs.find((t) => /-project-orchestrator$/.test(t.name));
  return tab ? [["space.select", { id: space.id }], ["tab.select", { id: tab.id }]]
    : [["space.select", { id: space.id }], ["tab.new", { space: space.id, name, folder, argv }]];
}
