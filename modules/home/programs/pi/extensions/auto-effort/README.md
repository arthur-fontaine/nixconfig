# auto-effort for Pi

Picks the thinking level of each prompt with a System One decision model, like
the Claude Code mod [cc-mod-auto-effort](https://github.com/arthur-fontaine/cc-mod-auto-effort)
does for effort. It raises the level for work that needs it, lowers it for quick
edits, and otherwise leaves the session's level alone. Effort levels map 1:1 to
Pi thinking levels (`low`, `medium`, `high`, `xhigh`, `max`).

The decision model is either:

- **Nisev**, the mod's own Qwen3-1.7B fine-tune, served on this machine by
  llama.cpp (`llama-server`, or `llama serve`, build 11361 or later) at
  `127.0.0.1:8765`. If it already answers there (for example started by the
  Claude Code mod), that server is used; otherwise the extension starts one and
  stops it when Pi quits.
- **Jev, Clef or any System One endpoint** in the cloud (OpenCode Zen and
  TypeSafe presets, or any URL), with its key in `AUTO_EFFORT_API_KEY`.

There is no default provider: nothing is called until `/auto-effort setup` or
the environment picks one.

## Configure

`AUTO_EFFORT_*` variables are read from the environment Pi starts in, on each
prompt, and win over what setup saved. They are the same as the mod's:
`AUTO_EFFORT_PROVIDER` (`nisev` or `jev`), `AUTO_EFFORT_ENDPOINT`,
`AUTO_EFFORT_MODEL`, `AUTO_EFFORT_API_KEY` (only ever read from the
environment), `AUTO_EFFORT_LLAMA_SERVER`, `AUTO_EFFORT_MIN_CONFIDENCE` (0.5),
`AUTO_EFFORT_TIMEOUT_MS` (4000), `AUTO_EFFORT_MIN_EFFORT` / `_MAX_EFFORT`
(`low` / `xhigh`) and `AUTO_EFFORT_INCLUDE_CONTEXT` (`true`). See the mod's
README for each one.

Pi settings have no `env` block, so Claude Code's `env.AUTO_EFFORT_PROVIDER`
doesn't reach Pi. Either export the variable for Pi, or let setup save the
choice: `/auto-effort setup` and `/auto-effort on|off` write
`~/.pi/agent/auto-effort.json` (under `PI_CODING_AGENT_DIR` when set), which can
also be written ahead of time:

```json
{ "config": { "provider": "nisev" }, "enabled": true }
```

## Commands

| Command | What it does |
| :- | :- |
| `/auto-effort` or `/auto-effort status` | Provider, what's missing, Nisev's state (with the download's progress), the range, the last decision (the level it set or kept, its kind of work and how long it took), the session's thinking level, and the last problem. |
| `/auto-effort setup` | Chooses the provider: Nisev (checks llama.cpp's build, asks before the 1.9 GB download), a preset, or **Other…** to type an endpoint and model. |
| `/auto-effort off` / `on` | Stops or resumes the overrides, saved across sessions. Turning it off mid-run gives the session its level back at once. |

## What it shows

A short line in the chat, right under the prompt it applies to, as a Pi notice
(`ctx.ui.notify`, the same dim line as `Session named: …`). Nothing goes in the
footer.

| Line | When |
| :- | :- |
| `Thinking for this prompt: high, for multi-step work` | The decision changed the thinking level for this prompt. The words say why: a quick request, a small change, a typical task, multi-step work, a hard task, an exhaustive task (for a Jev answer, the kind of work its level stands for). |
| `Thinking for this prompt: xhigh, the highest allowed, for an exhaustive task` | It picked `max`, above `AUTO_EFFORT_MAX_EFFORT` (or what the model supports). `the lowest allowed` for the other end. |
| `Nisev starting: thinking stays at high until it is ready`, `Nisev downloading its model: …` | The server this extension started isn't ready yet. |
| `Warning: The effort classifier did not answer, so thinking stays at high. See /auto-effort.` | A fallback: the decision model failed or timed out (`Nisev did not answer`, `Nisev is not running`, or `gave no usable answer` for the other cases). |

Why so:

- The classifier's pick runs even when it is the model's own default (medium
  for Opus 5.5), so a session set to high runs ordinary work at medium. When
  the session's level stands (the pick equals it, the classifier wasn't sure,
  thinking is off, the model doesn't reason), nothing is posted:
  Pi's footer already shows that level, and it is the right one.
- A problem is posted once. The same problem on the next prompts stays silent
  until a prompt is decided again; `/auto-effort` keeps the details.
- The line goes under its prompt, not above it: Pi draws the user message after
  the extensions' `message_start` handlers, so the extension posts on that
  message's `message_end`. A follow-up queued during a run gets its line when
  Pi delivers it, not when you send it.
- Notifications are a Pi notice, not a session entry: they don't come back
  when the session is resumed, and they never reach the model or Remote Control.
- Pi replaces a dim notice that is still the last line of the chat with the
  next one. auto-compact posts its compaction line above the prompt, under
  Pi's compaction block, so both stay; its `Context kept` line goes under the
  prompt, where this one replaces it. A warning is never replaced.
- Notifications that need action still come once per session: no provider set
  up, settings that don't fit Nisev, llama-server failing to start. Nisev's
  download progress is in `/auto-effort`.

## How it maps from the mod

| Mod feature | In Pi | Same? |
| :- | :- | :- |
| Classify each prompt with the System One request (prompt clipped to 6,000/3,000 characters, previous reply to 1,500/800, model name) | `input` handler; previous reply from the session branch; model from `ctx.model.id` | Yes |
| Jev question with `default`; Nisev category question mapped through per-model tables (Opus 5.5 defaults to `medium`) | `policy.ts`, ported as is | Yes |
| Keep the session's effort on `default`, low confidence, timeout, errors, Nisev starting, no provider | `default` applies the model's own level instead (it kept a session set to high at high for work judged medium); the rest the same | No |
| Clamp to `AUTO_EFFORT_MIN_EFFORT`–`MAX_EFFORT` | Same, then Pi clamps to what the model supports | Yes |
| Cloudflare `result` wrapper, cloud settings left in the environment reported for Nisev | Same | Yes |
| Override the effort of one turn only | Sets the thinking level when the prompt's run starts, puts the session's back when it settles | Not exactly, see below |
| A level set with `/effort` stands | A level chosen by hand (or by a model switch) during the run stands, and the session's level between prompts is always yours | Yes |
| Messages delivered into a running turn aren't classified; prompts queued during a turn get their own decision | Steers join the running work and keep its decision; follow-ups are classified and applied when Pi delivers them | Not exactly, see below |
| A prompt another hook dropped passes no decision on | Every idle input replaces the pending decision; follow-ups not delivered are dropped when the run settles | Yes |
| Subagents keep their own effort | No equivalent | No, see below |
| Models without effort; a numeric budget left alone | Models without reasoning; thinking `off` or `minimal` left alone | Equivalent |
| Start llama-server at session start, report download and readiness, reuse a server already running, stop it with the session | Same; one server per Pi process, shared across `/new`, `/resume` and `/reload`, stopped when Pi quits | Equivalent |
| `/auto-effort [setup\|on\|off\|status]`, setup wizard | Pi command with completions; `ctx.ui.select`, `input`, `confirm` | Yes |
| Settings saved by setup and on/off, across sessions | `~/.pi/agent/auto-effort.json` | Yes |
| Footer label with the decision | A line under the prompt when the level changes, or once for a problem | Different, see above |
| Status line for what needs action | `ctx.ui.notify`, once | Equivalent |
| Debug log (`claude --debug-file`) of overrides and llama-server output | `PI_AUTO_EFFORT_DEBUG=<file>` | Equivalent |
| `pnpm test` | `node --test 'tests/*.test.ts'` (Node 23.6+), stubbed fetch and processes | Yes |
| `pnpm validate`, `pnpm eval`, the training pipeline | Not ported: plugin packaging and development tools of the mod's repo | No |

### What isn't exact, and why

- **Per-turn effort.** Claude Code lets a mod change the effort of each model
  request without touching the session. Pi has no per-request thinking hook for
  extensions (only virtual models, which would replace the model you picked),
  so the extension changes the session's thinking level for the run and
  restores it. Visible effects: Pi's footer shows the run's level while it
  runs, the session file gets two `thinking_level_change` entries per
  overridden prompt, and `thinking_level_select` fires for other extensions
  (Remote Control reports it to the apps). If Pi is killed mid-run without its
  normal shutdown, the session keeps the run's level.
- **Prompts typed during a run.** Claude Code queues them as turns of their
  own. Pi offers two kinds: a steer (Enter) joins the running work, which is
  what Claude Code calls a delivery into the running turn, so it keeps the
  run's decision; a follow-up (Alt+Enter) gets its own decision from its
  delivery on. Several follow-ups delivered together run at the last one's
  level. A follow-up a prompt template or skill expanded is matched in order
  rather than by text; one another extension rewrote counts as a steer.
- **Subagents.** Pi has no built-in subagents. A subagent extension runs a
  separate `pi` process, which loads this extension too and classifies its own
  prompts, so there is no parent agent's effort to keep.
- **The server's lifetime** is Pi's process, not a session: `/new` and
  `/reload` keep the same llama-server.

## Develop

```sh
node --test 'tests/*.test.ts'
```

`tests/policy.test.ts` is the mod's policy suite; `tests/auto-effort.test.ts`
drives the handlers in the order Pi fires them, against a fake Pi, with fetch,
llama.cpp and the store stubbed. `tests/notes.test.ts` checks the wording of the lines.
