# cache-timer for Pi

Port of the Claude Code mod `modules/home/programs/claude/mods/cache-timer`.
It warns when the session's prompt cache is about to expire, so you can
send your next message while it is still a cheap cache read.

```
cache expires in 3 min   warning: the last five minutes of the lifetime
```

Nothing shows before that, and nothing once the cache has expired.

## Where it shows, and why

One short entry in Pi's footer status line (`ctx.ui.setStatus`, key
`cache-timer`), next to the other extensions' statuses. The footer is
always visible but never takes room from the conversation, and a warning
needs no more than that. It shows only when there is something to act on,
so the footer stays quiet for most of the hour. In Claude Code the mod
could only append a word to the mode labels, with no color.

The footer extension places it after the context fullness, before
cache-warmer's entry.

## Features and how they map

| Claude Code mod | Pi |
| --- | --- |
| `cache MM:SS` appended to the footer's mode labels | Footer status `cache expires in N min`, in the last five minutes only. |
| `cache cold` once the lifetime has passed | Nothing. |
| Clock restarts on every main-thread request, from when it was **sent** | The last assistant message on the branch with non-zero usage. Its `timestamp` is set when the request starts streaming (claude-code: before `claude -p` is spawned), so it is the send time. A request that failed before the provider read the prompt (zero usage) doesn't count. |
| Clock restarts on cache-warmer's pings (read from its state) | cache-warmer records each ping on the session (a `cache-warmer` custom entry with `lastPingAt`) and emits `cache-warmer:state` on `pi.events`, so the label updates at once. |
| Subagent requests ignored | Nothing to filter: Pi runs no subagents in the session; subagent extensions use their own sessions. |
| Hidden while a turn runs | Hidden between `agent_start` and `agent_settled`, and whenever Pi isn't idle (compaction). |
| Hidden before the first request | Same. |
| Refreshes every second | Same, in the TUI. In RPC mode it updates on events only, so clients don't get a status event every second. |
| Reset by `/clear` (session end) | The label is derived from the current session's entries, so a new session starts blank. |
| `ttlMinutes` option (60 by default) | `cacheTimer.ttlMinutes` in `settings.json`, 60 by default. |

### Added in Pi

- Pi's own cache refreshes (`usage` entries of kind `cache_warm`, from its
  built-in `cacheWarming`) restart the clock too.
- After a compaction or a model switch the label goes away: the next
  request can't reuse the old prefix. Claude Code's label kept counting.
- A resumed session shows the real time left: the label comes from the
  session's entries, not from memory.

### Not exact

- No provider reports a cache's lifetime, so it is still a setting. With
  claude-code it is 1 hour: the provider asks for `ttl: "1h"` and its usage
  shows `cacheWrite1h`. With Pi's own Anthropic provider it is 5 minutes
  unless `PI_CACHE_RETENTION=long`, so set `ttlMinutes: 5` there.
- The clock is the provider's best effort: the cache can be evicted sooner.

## Provider notes

Everything it reads is on the session (message usage and timestamps), so it
works the same with every provider, claude-code included. It doesn't use
`after_provider_response` or `provider_stream_event`: claude-code never
fires them (it talks to `claude -p`, not to an HTTP API Pi sees).

## Settings

```json
{ "cacheTimer": { "ttlMinutes": 60 } }
```

## Files

- `index.ts`: the Pi wiring
- `timer.ts`: what the label says, without Pi imports
- `timer.test.ts`: `node --test 'modules/home/programs/pi/extensions/cache-timer/*.test.ts'`
