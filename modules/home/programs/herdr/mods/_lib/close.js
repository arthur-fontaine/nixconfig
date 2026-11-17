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
