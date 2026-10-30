# cache-warmer for Pi

Port of the Claude Code mod
[cache-warmer](https://github.com/samyakjain0606/awesome-learning-material/tree/main/cache-warmer).
It keeps an idle session's prompt cache warm, then compacts the session
once when the warm window ends, so coming back to a large session costs a
cache read instead of a full re-send.

- After each run, if the context is at least 100k tokens, it arms a
  50-minute timer. Your next message cancels it.
- While you are idle it replays the session's last request every 50
  minutes, capped at one output token. The request is the one the provider
  just cached, so it is served from cache and restarts the cache's
  lifetime. Nothing is added to the conversation.
- After 10 idle hours it stops pinging. A session of at least 100k tokens
  is compacted once; a smaller one is left to cool.
- It never pings a cache that has already lapsed (laptop asleep, timer
  late), stops if a ping finds the cache cold, retries a failed ping twice,
  5 minutes apart, and keeps a daily keep-alive budget shared by every Pi
  session on the machine.

## What it shows, and where

Claude Code gave the mod one status line. Pi has footer statuses and
widgets, so the state is split by how much it matters right now:

| Where | When | Example |
| --- | --- | --- |
| Footer status (key `cache-warmer`) | Always, once there is something to say | `warm · next 16:16` (dim), `warm · retry 16:21`, `warm · cold`, `warm · stopped` (yellow), `warm · compacted` (green), `warm · off` (grey) |
| One line under the editor (widget `cache-warmer`) | Only when something needs knowing before the next message: a failed ping and its retry, why it stopped or found the cache cold, the warm window's last wake (it will compact or let the cache cool at that time), and the compaction's result | `cache-warmer: warm window ends · compacting 225k at 02:40 (≥ 100k)` |
| Notification | The same moments as the original's toasts: compaction done, budget reached, cache found cold | |
| `/warm` | On demand: the full status, including when the warm window ends and what happens then | |

The footer entry stays a few words long because other extensions share
that line (cache-timer's countdown sits just before it). The widget line
appears only while idle and goes away as soon as you send a message, so a
normal warm session shows nothing under the editor. When the timer and the
warmer are both on, the footer reads `cache 42:10 warm · next 16:16`.

## Features and how they map

| Claude Code mod | Pi |
| --- | --- |
| Arms after each main-thread `turn.complete` | `agent_settled`, which Pi fires once a run has fully finished (retries, compaction and queued messages included). Subagents don't run in a Pi session, so there is nothing to filter. |
| `prompt.submit` cancels the pending ping | `agent_start` cancels it, and aborts a ping in flight. |
| Ping: `$.model.fork({prompt: "Reply with the single word: ok"})`, a tool-less fork over the session's prefix | Replays the last request, captured from `context_with_system` (the transcript after every extension's changes), through `ctx.modelRegistry.streamSimple` with `maxTokens: 1`, the session id and thinking level of the original. That is exactly what Pi's built-in cache refresh sends. No prompt is added, so nothing new is written to the cache. |
| `nothing-to-fork` stops it | No captured request (Pi restarted since the last turn, or the conversation changed) stops it with the same note, `nothing to keep warm yet`. |
| Lapsed cache: never re-warmed | Same check, same settings. |
| Ping that finds < 50% from cache: stop, toast | Same, from the replay's `cacheRead / (input + cacheRead + cacheWrite)`. |
| Failed ping: retry in 5 min, stop after 3 | Same. The error is shown under the editor while it retries. |
| Warm window end: compact with the original's instructions, or let cool | Same, through `ctx.compact({customInstructions})`. Pi refusing (`Nothing to compact`, `Already compacted`, cancelled by another extension) is a skip, as `r.skip` was. |
| Daily budget in full-price token equivalents (input 1, cache write 1.25, cache read 0.1, output 5), shared by every session | Same weights. Claude Code's `$.store` becomes `cache-warmer.json` in Pi's agent directory (`~/.pi/agent/`), written atomically; only today's and yesterday's keys are kept. |
| `/warm`, `/warm off` (`pause`), `/warm on` (`resume`), `/warm off all`, `/warm on all`, `/warm now` | Same command, same answers, shown as a notification. Arguments complete with Tab. |
| `/warm off` survives later turns | Same. |
| State in `$.state`, picked up again after a hot reload | The capture is kept across `/reload` (same process), and the state is saved on the session as a `cache-warmer` custom entry when a ping lands and when the session closes, then restored on `/reload` and resume. A new or forked session starts afresh. |
| Status line texts | Kept word for word in `/warm` and `describe()` (view.ts); the footer and widget use the shorter forms above. |
| Toasts | `ctx.ui.notify`. |
| Debug log | `PI_CACHE_WARMER_DEBUG=<file>` logs each ping and its usage. |
| Settings in `pluginConfigs.cache-warmer.options` | `cacheWarmer` in `settings.json`, same names and defaults, except `minCompactContextK`: 100, as this setup configured it in Claude Code. |

### Pi's built-in cache warming

Pi can refresh caches itself (`cacheWarming` in settings.json: `off`,
`streaming` by default, or `idle`), and lets extensions override each
refresh through `cache_warming_decision`. It can't run this schedule:

- Idle refreshes stop 30 minutes after the last request, a hard limit.
- A refresh is sent at 90% of the model's declared cache lifetime. A 1-hour
  cache would be refreshed at 54 minutes, past that limit, so Pi never
  refreshes it while idle. Models from claude-code also declare 5 minutes
  (copied from Pi's Anthropic catalog), while the provider asks for 1 hour.

So this extension does the idle pings itself, with the same request Pi
would send, and answers `stop` to Pi's idle refreshes, so a session is
never pinged twice. Pi keeps its refreshes during a run (`streaming`), which
this mod never touched. Those refreshes count as cache touches for
cache-timer.

### Added in Pi

- A compaction you start, a `/tree` jump, or a model or thinking level
  change stops pending pings: the next request won't extend the one a ping
  would replay.
- `/warm` also says when the warm window ends and whether the session will
  then be compacted or left to cool.
- A model with budget-based thinking (Anthropic models without adaptive
  thinking) isn't pinged, by Pi's own rule: its thinking budget comes from
  `max_tokens`, so a one-token replay would be another request.

### Not exact

- **Compaction doesn't read the cache.** Pi's summarization request
  serializes the conversation to text and turns cache writes off, so
  compacting "while warm" costs a full read of the conversation, as it
  would cold. What stays is the point of compacting before you come back:
  your next message re-sends the summary, not 500k tokens. The note still
  says "while warm", as the original's did.
- **Extensions loaded after this one.** The request is captured in a
  `context_with_system` handler, which Pi runs in load order. An extension
  loaded later that rewrites the transcript there changes the real request
  but not the capture; the ping then misses the cache, pays one full write,
  and the < 50% check stops it. Check the first ping's hit rate with
  `PI_CACHE_WARMER_DEBUG` when adding context-rewriting extensions.
- **No ping after a restart.** The request is captured in memory. After
  Pi restarts, nothing is pinged until the next run.
- **The budget is a file, not a store.** Two sessions writing at the same
  instant can lose one ping's worth of spend.
- **Ping size.** The original's fork wrote its one-word prompt to the cache;
  the replay writes nothing, so a ping costs a little less than the
  original's.

## Providers

| | claude-code | Pi's own providers (Anthropic API, OpenAI, …) |
| --- | --- | --- |
| Pings (replay with `maxTokens: 1`) | Works: tested, `claude -p` answers with stop reason `length`, 100% from cache. Each ping starts a `claude -p` process and counts against the subscription like any request. | Works, as Pi's own refresh does. |
| Cache usage (`cacheRead`, `cacheWrite`) | Reported on every message, plus `cacheWrite1h`. | Reported. |
| Cache lifetime | 1 hour (the provider sends `ttl: "1h"`); not declared correctly to Pi, see above. Keep `cacheTtlMinutes: 60`. | 5 minutes on Anthropic unless `PI_CACHE_RETENTION=long`: set `cacheTtlMinutes: 5` and `pingIntervalMinutes: 4`. |
| `before_provider_request`, `after_provider_response`, `provider_stream_event` | Never fired: the provider talks to `claude -p`, not to an API Pi sees. This extension doesn't need them. | Fired. |
| Compaction | Through `claude -p`, like any request. | Pi's compaction model. |

## Settings

```json
{
  "cacheWarmer": {
    "pingIntervalMinutes": 50,
    "cacheTtlMinutes": 60,
    "warmHours": 10,
    "minPingContextK": 100,
    "minCompactContextK": 100,
    "dailyBudgetK": 2000
  }
}
```

## The honest cost line

From the original: a ping reads the whole context from cache, about a tenth
of a cold re-send. Twelve pings on a 500k session cost roughly 1.2 cold
returns at the base rate. The win is every time you return inside the
window; overnight is roughly break-even, and `warmHours` is where you tune
it. On claude-code these are subscription limits, not dollars.

## Files

- `index.ts`: the Pi wiring (capture, replay, compaction, UI, events)
- `warmer.ts`: the schedule, ported from `hooks/register.ts`, without Pi imports
- `view.ts`: what the footer, the widget and `/warm` say
- `store.ts`: the cross-session budget and `/warm off all`
- `*.test.ts`: the original's tests plus Pi's:
  `node --test 'modules/home/programs/pi/extensions/cache-warmer/*.test.ts'`
