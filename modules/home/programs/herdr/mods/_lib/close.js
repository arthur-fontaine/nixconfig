// When closing something asks first: only when something would be lost (k31). Pure, so
// `node --test` covers it; nix joins it into the mods that close (no imports, `close` prefix).
//
// items: what the closed pane, tab or space holds, one per pane:
//   { kind: "mod" } or { kind: "terminal", shell, agent, app, status, name, resumable }
// (resumable: true/false for an idle agent's session, null when unknown).
// workers: the statuses of sub-agents started from it (no pane of their own).
// Unknown facts ask: with confirmed: true passed on, this is the only guard left.
export function closeAsk({ scope, items = [], workers = [], remote = false }) {
  const lost = [];
  if (remote) lost.push("terminals on another machine");
  if (!items.length) lost.push("what it holds (unknown)");
  for (const w of workers) if (w === "working" || w === "blocked") lost.push(`a sub-agent ${w === "working" ? "working" : "waiting for you"}`);
  for (const it of items) {
    if (it.kind === "mod") {
      // A space can't be reopened from Herdr's recent list: closing one keeps asking
      // whenever it holds more than idle shells.
      if (scope === "space") lost.push("a panel tab");
      continue;
    }
    if (typeof it.shell !== "boolean" || typeof it.agent !== "boolean") { lost.push("a terminal (unknown program)"); continue; }
    if (it.agent) {
      const who = it.app === "pi" ? "Pi" : it.name || "an agent";
      if (it.status === "working") lost.push(`${who}, working`);
      else if (it.status === "blocked") lost.push(`${who}, waiting for you`);
      else if (it.app !== "pi" || it.resumable !== true) lost.push(`${who}'s session${it.app === "pi" && it.resumable === null ? " (resumable unknown)" : ""}`);
      else if (scope === "space") lost.push("a Pi session (resumable)");
      continue;
    }
    if (!it.shell) lost.push(it.name || "a running program");
  }
  return { ask: lost.length > 0, lost };
}

// What an ask says: "Close tab? Pi, working and sleep would end."
export function closeQuestion(scope, lost) {
  const what = scope === "space" ? "space" : scope === "pane" ? "pane" : "tab";
  const list = [...new Set(lost)];
  return { title: `Close ${what}?`, detail: `${list.join(", ")} would end.` };
}

// What closing a target ends, and the commands that do it, from the herdr state:
// world { spaces, panes, terminals }; target { pane } | { tab } | { spaces: [ids] }.
// A tab's only pane closes the tab, a space's only tab closes the space (Herdr does the
// same); each command carries confirmed: true, since closeAsk asked already. null: gone.
export function closePlan(world, target) {
  const spaceOfTab = (id) => world.spaces.find((s) => (s.tabs ?? []).some((t) => t.id === id));
  const panesOf = (tab) => world.panes.filter((p) => p.tab === tab);
  let scope, ids;
  if (target.spaces) {
    const found = target.spaces.map((id) => world.spaces.find((s) => s.id === id)).filter(Boolean);
    if (!found.length) return null;
    scope = "space"; ids = found;
  } else {
    const pane = target.pane ? world.panes.find((p) => p.pane === target.pane) : null;
    if (target.pane && !pane) return null;
    const tab = pane ? pane.tab : target.tab;
    const space = spaceOfTab(tab);
    if (!space) return null;
    if (pane && panesOf(tab).length > 1) scope = "pane";
    else scope = (space.tabs ?? []).length > 1 ? "tab" : "space";
    ids = scope === "pane" ? [pane] : scope === "tab" ? [tab] : [space];
  }
  const tabsOf = (s) => (s.tabs ?? []).map((t) => t.id);
  const panes = scope === "pane" ? ids : world.panes.filter((p) => (scope === "tab" ? ids : ids.flatMap(tabsOf)).includes(p.tab));
  const term = (a) => (world.terminals ?? []).find((t) => t.address === a);
  const items = panes.map((p) => {
    if (!p.terminal) return { kind: "mod" };
    if (!p.program) return { kind: "terminal" };
    const agent = Boolean(p.program.agent || p.status);
    const it = { kind: "terminal", shell: Boolean(p.program.shell) && !agent, agent, app: p.app ?? null, status: p.status ?? null, name: p.program.name ?? null };
    if (agent) it.resumable = p.app === "pi" ? (term(p.terminal)?.labels?.["pi.session"] ? true : null) : false;
    return it;
  });
  const mine = new Set(panes.map((p) => p.terminal).filter(Boolean));
  const workers = (world.terminals ?? []).filter((t) => t.state === "live" && mine.has(t.parent) && !world.panes.some((p) => p.terminal === t.address)).map((t) => t.status ?? null);
  const spaces = scope === "space" ? ids : [spaceOfTab(scope === "tab" ? ids[0] : ids[0].tab)];
  const remote = spaces.some((s) => s.machine);
  const commands = scope === "pane" ? [["pane.close", { pane: ids[0].pane }]]
    : scope === "tab" ? [["tab.close", { id: ids[0], confirmed: true }]]
    : ids.map((s) => ["space.close", { id: s.id, confirmed: true }]);
  return { scope, items, workers, remote, commands };
}

// nix-status's close commands: "close-pane[:<pane>]", "close-tab[:<tab>]", "close-space[:<space>]"
// and "close-spaces:<id>,<id>", to their closePlan target; without ids, what's focused. null:
// not a close command, or nothing to close. The name is matched whole: close-spaces isn't close-space.
export function closeTarget(command, focus) {
  const i = command.indexOf(":");
  const name = i < 0 ? command : command.slice(0, i), arg = i < 0 ? null : command.slice(i + 1);
  if (name === "close-pane") return (arg || focus.pane) ? { pane: arg || focus.pane } : null;
  if (name === "close-tab") return (arg || focus.tab) ? { tab: arg || focus.tab } : null;
  if (name === "close-space") return (arg || focus.space) ? { spaces: [arg || focus.space] } : null;
  if (name === "close-spaces") { const ids = (arg ?? "").split(",").filter(Boolean); return ids.length ? { spaces: ids } : null; }
  return null;
}
