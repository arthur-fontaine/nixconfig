# herdr-kanban

A kanban whose cards are tasks for the Pi project orchestrators in Herdr. The
`nix-kanban` mod is its UI; this folder is the daemon behind it and the
`herdr-kanban` CLI.

In Herdr, the left sidebar is one of two sidebars, switched at its top (or ⌘⇧K):
**Repos** (nix-sidebar's tree) or **Kanban**, the cards in sections (In progress,
Review, To-do, Backlog, Done; click a card to edit it, right-click to move it, drag
it to another section). ↗ opens the whole board as a tab.

A card can carry files of any kind: in its dialog, paste a screenshot (⌘V in the prompt),
drop files from Finder, or use Attach files. Images show as thumbnails, other files as
chips; × removes one. The orchestrator gets their paths with the card.

Backlog → **To-do** → **In progress** → **Review** → Done

- **To-do** cards start by themselves, most urgent (then oldest) first, as soon as
  every scheduler factor holds (below).
- **In progress**: the card's prompt was sent to its project's orchestrator, the Pi
  chat named `<repo>-project-orchestrator` (nix-sidebar's naming). If it isn't
  running, the daemon starts it the way the sidebar does: its own space at the repo's
  root, `pi --name … --append-system-prompt ~/.pi/agent/orchestrator/project.md`.
- **Review**: only the orchestrator puts a card there, by running
  `herdr-kanban review <id> "<summary>"` when the work is done (the prompt it gets
  says so).

## Running

launchd runs `herdr-kanban daemon` (agent `org.nix-community.home.herdr-kanban`,
declared in `../default.nix`). Logs: `~/Library/Logs/herdr-kanban.log`. State:
`~/.local/share/herdr-kanban/state.json` (cards, settings, known projects, paired
clients' token hashes), written atomically (temp file + rename).

| Variable | Default | |
|---|---|---|
| `HERDR_KANBAN_STATE_DIR` | `~/.local/share/herdr-kanban` | |
| `HERDR_KANBAN_PORT` | `7742` | local API, 127.0.0.1 only (lsp-bridge has 7741 and 7743) |
| `HERDR_KANBAN_MCP_PORT` | `7744` | MCP, all interfaces, only while enabled |
| `HERDR_KANBAN_NAME` | `Herdr Kanban` | the Bonjour instance name |
| `HERDR_KANBAN_CLI` | `herdr-kanban` | how the orchestrator's prompt says to call `review` |
| `HERDR_KANBAN_ESTIMATOR` | `pi --print --model sonnet …` | argv, space-separated or a JSON array; the prompt is appended |
| `HERDR_KANBAN_TICK_MS` | `15000` | scheduler pass interval (it also runs on every change) |

Why TypeScript without a build: Node 24 strips types itself, so `src/*.ts` run as they
are (erasable syntax only, see `tsconfig.json`). Nix fetches the pnpm dependencies
(`fetchPnpmDeps`, hash in `../default.nix`: update it when `pnpm-lock.yaml` changes)
and runs the unit tests while building.

## Scheduler

Every 15 s and after every change, each To-do card (by priority, then age) is checked
against `FACTORS` in `src/scheduler.ts`; a card starts when none objects, and the
reasons of those that object are shown on the card (`waiting`). A factor is
`{ name, check(card, ctx, running) → null | reason }`; add one to the list.

- **project**: a project is picked.
- **max-in-progress**: fewer than `maxInProgress` cards in progress (default 2).
- **orchestrator-free**: no other card of the project in progress, and its
  orchestrator isn't `working`, `blocked` or `error` (`herdr-app ls`).
- **free-ram**: free RAM (`vm_stat`: free + inactive + speculative + purgeable) minus
  what cards started this pass need ≥ `minFreeRamGB` (default 4) + the card's
  predicted `ramGB`.
- **token-budget**: estimated tokens of the cards started in the last
  `budgetWindowHours` (5) + this card's ≤ `tokenBudget` (2M). A card without an
  estimate counts as `defaultEstimate` (100k).
- **exclusive**: no running card holds a resource it needs (`ios-simulator`,
  `android-emulator`, `heavy-build`, `browser`, `docker`).
- **retry-after-error** (daemon side): a failed dispatch waits 2 minutes.

Dragging a card to In progress by hand starts it at once, whatever the factors say.

**Estimates**: on creation, and when the prompt changes, Sonnet (`pi --print --model
sonnet`, no session, no tools) answers `{tokens, ramGB, exclusive, notes}` for the
card, one card at a time in the background; the answer is cached on the card.

## Local API

`http://127.0.0.1:7742/api`, JSON. No auth (loopback only), but a `Host` other than
loopback is refused (403, against DNS rebinding) and every `POST`/`PATCH` needs
`Content-Type: application/json` (415 otherwise: a web page can't send that
cross-origin without a preflight, which is never answered).

| Route | |
|---|---|
| `GET /api/state?since=<version>&wait=<ms>` | everything the UI shows: `{version, cards, settings, projects, orchestrators: {key: status}, freeRamGB, pairing: {pending, clients}, mcp: {enabled, listening, port, error}}`. With `since`, waits (25 s, at most 60) for a newer version: a long poll. |
| `GET /api/cards` | all cards |
| `POST /api/cards` | `{title, prompt?, project?, priority? (0-3), column?, attachments? }` → the card (201) |
| `GET /api/cards/:id` | one card |
| `PATCH /api/cards/:id` | `{title?, prompt?, project?, priority?, column?, attachments?}` |
| `DELETE /api/cards/:id` | the card and its attached files |
| `POST /api/attachments` | `{path, name?}`: copies that local file (absolute path, 512 MB at most) into the staging area → `{id, name, size, mime, path}` (201) |
| `DELETE /api/attachments/:id` | throws a staged file away |
| `POST /api/cards/:id/move` | `{column}`: `backlog`, `todo`, `in_progress` (starts it now), `done`. Not `review`. |
| `POST /api/cards/:id/review` | `{summary}`: the orchestrator's report, the only way to Review |
| `POST /api/cards/:id/estimate` | ask Sonnet again (202) |
| `GET /api/settings`, `PATCH /api/settings` | `{maxInProgress, minFreeRamGB, tokenBudget, budgetWindowHours, defaultEstimate, mcpEnabled}`; `mcpEnabled` opens or closes the MCP port |
| `GET /api/projects` | `[{key, name, root}]`, from Herdr's spaces (`herdr-app ls`), the sidebar's project spaces (`nix.orchestrators` in Herdr's `shared.json`) and repos added by hand |
| `POST /api/projects` | `{folder}`: add the repo that folder is in |
| `POST /api/projects/refresh` | look at Herdr's spaces again now |
| `GET /api/pairing` | `{pending: [{code, client, expiresAt}], clients: [{id, name, createdAt, lastUsedAt}]}` |
| `DELETE /api/clients/:id` | revoke a paired client |

Errors are `{error}` with 400 (bad input), 404, 413, 415, 429 (pairing rate limit) or 500.

A card: `{id ("k12"), title, prompt, project (key), priority (0 low … 3 urgent),
estimate (tokens | null), estimating, factors ({ramGB, exclusive, notes} | null),
column, createdAt, updatedAt, movedAt, startedAt, orchestrator ({terminal, name,
space} | null), review (summary | null), waiting (reasons), error, attachments
([{id, name, size, mime, path}])}`. Times are ms since the epoch. A project key is nix-sidebar's repo key: `JSON [null, <git common dir>]`.

**Attachments**: files are the daemon's own copies. The card dialog stages each file it
gets (pasted, dropped, picked) with `POST /api/attachments`, then saves the card with
`attachments`: the card's whole list of ids, those it keeps and staged ones. Staged files
move to `<state dir>/attachments/<card id>/<name>` (`name (2).ext` on a clash), files
left out of the list are deleted, and so is the folder with its card. The message an
orchestrator gets lists their absolute paths. Staged files a day old, and folders of
cards that are gone, are swept when the daemon starts.

## MCP (remote agents)

Off by default; switched on from the kanban's settings in Herdr. Then the daemon
listens on `0.0.0.0:7744` and announces `_herdr-kanban._tcp` with Bonjour
(`dns-sd -R "Herdr Kanban" _herdr-kanban._tcp local 7744 path=/mcp`). Find it with
`dns-sd -B _herdr-kanban._tcp`, then `dns-sd -L "Herdr Kanban" _herdr-kanban._tcp`.

Endpoint: `POST http://<mac>:7744/mcp`, Streamable HTTP, stateless, JSON responses.

Pairing, like a Chromecast:
1. `pair_start {client_name}` (no token needed). Herdr shows a 6-digit code (in the
   kanban, plus a toast). Codes last 2 minutes; 3 requests a minute at most.
2. `pair_confirm {code}` → `{token}`. 5 wrong codes in a minute lock confirmation
   for that minute and drop pending codes.
3. Every later request sends `Authorization: Bearer <token>`. Tokens are stored as
   sha256 hashes, listed and revocable in the kanban's settings. A revoked or unknown
   token gets HTTP 401; no token gets a tool error on everything but pairing.

Tools: `pair_start`, `pair_confirm`, `list_projects`, `list_cards {column?, project?}`,
`get_card {id}`, `create_card {title, prompt?, project?, priority?, column?: backlog|todo}`,
`update_card {id, …}`, `move_card {id, column}` (not to Review).

## CLI

```
herdr-kanban review <id> <summary>
herdr-kanban ls [column] [--json]
herdr-kanban show <id>
herdr-kanban add <title> [--prompt <text>] [--project <name|key>] [--priority 0-3] [--todo]
herdr-kanban move <id> <column>
herdr-kanban projects
herdr-kanban add-project <folder>
herdr-kanban daemon
```

`--url` or `HERDR_KANBAN_URL` points it at another daemon (`HERDR_KANBAN_PORT` too).

## Tests

```sh
pnpm test                          # unit: scheduler, pairing, store, adapters (also run by nix)
node test/live/mcp-check.ts        # a real daemon on 17742/17743: Bonjour, pairing, auth, MCP on/off
node test/live/dispatch-check.ts   # Herdr open: a card to a scratch repo's orchestrator and back to Review
```
