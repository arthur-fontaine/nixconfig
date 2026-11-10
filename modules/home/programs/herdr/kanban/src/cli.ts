// herdr-kanban: talks to the daemon's local API. The orchestrators use `review`.
import { PRIORITIES, type Card } from "./types.ts";

const USAGE = `herdr-kanban: the Herdr kanban, from a shell

  herdr-kanban review <id> <summary>     the card's work is done: move it to Review
  herdr-kanban ls [column] [--json]      cards (backlog, todo, in_progress, review, done)
  herdr-kanban show <id>                 one card, as JSON
  herdr-kanban add <title> [--prompt <text>] [--project <name|key>] [--priority 0-3] [--todo]
  herdr-kanban move <id> <column>
  herdr-kanban projects
  herdr-kanban daemon                    run the daemon (launchd does this)

  --url <url>   the daemon (default: $HERDR_KANBAN_URL, else http://127.0.0.1:7742)`;

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function call(base: string, method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`the kanban daemon isn't answering at ${base} (launchctl kickstart -k gui/$(id -u)/org.nix-community.home.herdr-kanban)`);
  }
  const out = await res.json() as any;
  if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
  return out;
}

const line = (c: Card) => `${c.id.padEnd(5)} ${c.column.padEnd(11)} ${PRIORITIES[c.priority].padEnd(6)} ${c.title}${c.waiting.length ? `  (waiting: ${c.waiting.join("; ")})` : ""}`;

export async function cli(argv: string[]) {
  const args = [...argv];
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  const base = (takeFlag(args, "--url") ?? process.env.HERDR_KANBAN_URL ?? `http://127.0.0.1:${process.env.HERDR_KANBAN_PORT ?? 7742}`).replace(/\/+$/, "");
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "review": {
      const [id, ...words] = rest;
      if (!id || !words.length) throw new Error("usage: herdr-kanban review <id> <summary>");
      const c = await call(base, "POST", `/api/cards/${encodeURIComponent(id)}/review`, { summary: words.join(" ") });
      console.log(`${c.id} moved to Review.`);
      return;
    }
    case "ls": {
      const cards = (await call(base, "GET", "/api/cards")) as Card[];
      const shown = rest[0] ? cards.filter((c) => c.column === rest[0]) : cards;
      console.log(json ? JSON.stringify(shown, null, 2) : shown.map(line).join("\n") || "no cards");
      return;
    }
    case "show": console.log(JSON.stringify(await call(base, "GET", `/api/cards/${encodeURIComponent(rest[0] ?? "")}`), null, 2)); return;
    case "add": {
      const prompt = takeFlag(rest, "--prompt");
      const projectArg = takeFlag(rest, "--project");
      const priority = takeFlag(rest, "--priority");
      const todo = rest.includes("--todo");
      const title = rest.filter((a) => a !== "--todo").join(" ");
      let project: string | undefined;
      if (projectArg) {
        const ps = (await call(base, "GET", "/api/projects")) as { key: string; name: string }[];
        project = ps.find((p) => p.key === projectArg || p.name === projectArg)?.key;
        if (!project) throw new Error(`no project ${projectArg}; known: ${ps.map((p) => p.name).join(", ")}`);
      }
      const c = await call(base, "POST", "/api/cards", { title, prompt, project, priority: priority === undefined ? undefined : Number(priority), column: todo ? "todo" : "backlog" });
      console.log(json ? JSON.stringify(c, null, 2) : line(c));
      return;
    }
    case "move": console.log(line(await call(base, "POST", `/api/cards/${encodeURIComponent(rest[0] ?? "")}/move`, { column: rest[1] }))); return;
    case "projects": {
      const ps = await call(base, "GET", "/api/projects");
      console.log(json ? JSON.stringify(ps, null, 2) : ps.map((p: any) => `${p.name}\t${p.root}`).join("\n"));
      return;
    }
    case "daemon": { const { main } = await import("./daemon.ts"); await main(); return; }
    default: console.log(USAGE); if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 2;
  }
}

if (import.meta.main) {
  cli(process.argv.slice(2)).catch((e) => { console.error(`herdr-kanban: ${(e as Error).message}`); process.exit(1); });
}
