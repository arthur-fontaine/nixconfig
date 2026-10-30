# auto-compact for Pi

A port of the Claude Code mod
[cc-mod-auto-compact](https://github.com/arthur-fontaine/cc-mod-auto-compact) (0.2.0): it
notices when a prompt starts a new task and offers to compact or clear the context before the
prompt is sent. A decision model reads a summary of the session and the new prompt and puts the
prompt in one of five categories: it continues the current task, follows up on it, starts a
related task, starts an unrelated one, or returns to an earlier one. A follow-up keeps
everything; a related task is worth a compaction that keeps the general picture; an unrelated
one is worth a clear.

The decision model is **Spisev** (spisev-alpha), run locally by llama.cpp, or any System One
endpoint (Mammoth, Jev).

## Setup

Until a provider is chosen the extension does nothing. Either:

- set `AUTO_COMPACT_PROVIDER=spisev` in the environment Pi starts in (Pi's settings have no
  `env` block like Claude Code's, so put it in the shell environment), or
- run `/auto-compact setup`, which saves the choice in `~/.pi/agent/auto-compact/config.json`.

With Spisev, the extension uses a `llama-server` already serving `spisev-alpha` on
`127.0.0.1:8766` (as Claude Code's mod leaves one running), or starts one itself with
`-hf arthur-fontaine/spisev-alpha-GGUF:Q8_0` (about 1.9 GB on first start; setup asks first). It
needs llama.cpp build 11361 or later (`llama-server` or `llama` on the PATH, or
`AUTO_COMPACT_LLAMA_SERVER`).

## Commands

- `/auto-compact`: the provider, the mode, the state of the summary tree and the last decision.
- `/auto-compact setup`: choose a provider.
- `/auto-compact mode off|suggest|auto`: saved for later sessions.
- `/auto-compact debug`: toggles the debug view below the editor: the last prompt looked at,
  the memory lines sent with it (each marked `raw`, `joined` or `summary`, with its size and
  the room left before the 128-byte limit; a summary has what it was made from dimmed under
  it), and the decision (each category's probability, the action and what came of it).

In **suggest** mode (the default), a prompt that looks like a related, returning or unrelated
task opens a dialog first: compact (or clear) first, or send as is. It asks only at a confidence
of `AUTO_COMPACT_SUGGEST_CONFIDENCE` (0.6) or more. In **auto** mode it acts at
`AUTO_COMPACT_MIN_CONFIDENCE` (0.85) or more. `continuation` and `follow_up` never act. It never
acts on a timeout or an error, without a provider, or while the previous turn's summaries are
still being built.

## What it shows, and where

Claude Code's mod could only add a footer label, transient status text, a question and a
docked pane. Pi gives more room, so this port shows more, in four places chosen to be visible
without being noisy:

- **One footer segment** (`ctx.ui.setStatus`, key `auto-compact`), always there:
  `context kept · 92% · ctx 41/92%`. The first part is the last decision, colored by action
  (green keep, yellow compact, red clear), with the mod's own labels (`context kept · 92%`,
  `compact? related · 71%`, `cleared · independent · 91%`). While something is under way it
  says so instead: `Spisev downloading · 45%`, `auto-compact: summaries catching up`,
  `compacting · related · 90%…`, `auto-compact off`, or what setup is missing. The second part
  is how full the context is against where **Pi itself** compacts (`contextWindow -
  reserveTokens`, per-model overrides included): `ctx 41/92%` means 41% full, Pi compacts at
  92%; it turns yellow within 10 points of that. Pi joins every extension's status on one line
  and cuts what overflows, so the segment stays short and does not replace the footer (a custom
  footer would hide the other extensions' statuses, such as auto-effort's or the cache
  timer's).
- **A notification** when something happened or went wrong, once: `auto-compact: compacted
  the context (related · 90%): 48.2k → 3.1k tokens. Your prompt goes on.`, a compaction Pi
  refused, a failing decision model, paused summaries, a llama-server that did not start. A
  repeated problem (the same provider error on every prompt) is notified once per session; the
  footer and `/auto-compact` keep showing it.
- **A dialog** (`ctx.ui.select`) for suggest mode, which also says how big the context is.
- **The debug view**, a widget below the editor, only when asked for: it is too tall to stay.

While a compaction runs, Pi shows its own compaction indicator (Escape cancels it) and the
footer says which one it is.

## Environment variables

| Variable | Default | |
| :- | :- | :- |
| `AUTO_COMPACT_PROVIDER` | none | `spisev`, or `systemone` (implied by an endpoint) |
| `AUTO_COMPACT_ENDPOINT` | Spisev: `http://127.0.0.1:8766/v1/systemone` | a System One endpoint |
| `AUTO_COMPACT_MODEL` | Spisev: `arthur-fontaine/spisev-alpha-GGUF:Q8_0` | the endpoint's model, or a GGUF for llama-server |
| `AUTO_COMPACT_AUTH` | `Bearer` | `Api-Key` for Baseten |
| `AUTO_COMPACT_API_KEY` | | the cloud provider's key, never stored |
| `AUTO_COMPACT_MODE` | `suggest` | overrides the saved mode |
| `AUTO_COMPACT_MIN_CONFIDENCE` | `0.85` | auto mode's threshold |
| `AUTO_COMPACT_SUGGEST_CONFIDENCE` | `0.6` | suggest mode's threshold |
| `AUTO_COMPACT_TIMEOUT_MS` | `4000` | a slower answer keeps the context |
| `AUTO_COMPACT_SUMMARIZER_MODEL` | `claude-haiku-5-5` | a model id, or `provider/id` for any Pi model |
| `AUTO_COMPACT_DATA_DIR` | `~/.pi/agent/auto-compact` | where each session's summary tree is saved |
| `AUTO_COMPACT_LLAMA_SERVER` | `llama-server`, then `llama` | |
| `AUTO_COMPACT_DEBUG_LOG` | none | a file for the debug log (`[auto-compact] <category> · <confidence> → <action>`) |

`~/.pi/agent` follows `PI_CODING_AGENT_DIR`.

## Feature by feature

**Exact** means the same behavior, and for the decision path the same bytes: the pure modules
(`text.ts`, `tree.ts`, `task.ts`, `policy.ts`, `summarizer.ts`, `llama.ts`, `prompt.ts`) are
line-for-line ports, checked against the mod's Python-generated fixture
(`tests/fixtures/parity.js`, copied verbatim).

| Feature (Claude Code mod) | In Pi | |
| :- | :- | :- |
| Five categories, System One v2 request (memory, agent's last reply up to 1.5 KB cut in the middle, prompt up to 512 tokens), same question | same code | exact |
| Category → action table, `continuation`/`follow_up` never act | same code | exact |
| Modes off / suggest / auto, saved across sessions, env wins | saved in `~/.pi/agent/auto-compact/config.json` instead of `$.store` | exact |
| Thresholds 0.85 (auto) and 0.6 (suggest), 4 s timeout → keep | same | exact |
| No default provider; says once that setup is needed | footer segment | exact |
| Spisev: llama-server on 127.0.0.1 with `-hf` (or `-m` for a `.gguf`), `--alias spisev-alpha -c 16384 -np 1`, `llama serve` for the unified CLI, build ≥ 11361, asks before downloading, reuses a server already serving it, waits up to 10 s for a starting one, never for a download, download progress shown | `node:child_process`, progress in the footer | exact |
| llama-server stopped with the session, kept across `/clear` | kept across `/new`, `/resume`, `/fork`, `/reload`; stopped when Pi quits; a server it did not start is never stopped | exact in effect |
| Mammoth (Baseten) and Jev (OpenCode Zen) presets, key from `AUTO_COMPACT_API_KEY` only, `Api-Key` or `Bearer` | same; the setup dialog lists an "Other" entry (Pi's select has no free text) that points to the env variables | exact |
| Summary tree: OptChat leaves and merges, 128-byte lines, UniiChat sawtooth 16 → 10, "too long" retries (≤ 5, shortest kept), cached by request hash, saved per session id, format version 2 | same code; files under `AUTO_COMPACT_DATA_DIR/trees/` | exact |
| Summaries by the pinned `claude-haiku-5-5`, effort low, 4096 tokens, system prompt `compact-v2.md`, through the user's own Claude session (`$.model.complete`) | Pi's model registry (`streamSimple`, `reasoning: "low"`): the id is looked up in the session's provider, then `claude-code` (Claude subscription), and nowhere else, so summaries never switch provider (and billing) by themselves; `provider/id` picks one | **not exact**: Pi has no "the session's own Claude"; see Gaps |
| Summaries built after each turn (`turn.complete`), 4 at a time, awaited (≤ 120 s) so `-p` saves the tree | `agent_settled` (once per prompt, after retries and continuations); awaited only in `-p`/json mode | **not exact**: interactively Pi would hold the next prompt until this handler returns, so the build runs in the background, and a prompt waits for it at most 2 s, as in the mod |
| Prefill: once a turn ends, Spisev reads everything but the next message into its prompt cache; never for a cloud provider | same | exact |
| Usage limit while summarizing pauses the summaries and says so | detected from Pi's error text (429, rate limit, usage limit), since Pi gives no status code | exact in effect |
| Skip deliveries into a running turn, slash commands, empty prompts | `input` with `streamingBehavior` set, text starting with `/` (skills, templates; extension and built-in commands never reach `input`) | exact |
| Prompts from Remote Control (the apps) count as the user's | they come as `source: "extension"` (the remote-control extension) and are looked at | exact |
| Never act on subagents | Pi has no in-process subagents | **n/a**: a subagent that runs another `pi` process loads this extension too; start it with `AUTO_COMPACT_MODE=off` |
| Never act while the previous turn's summaries are missing: `auto-compact: summaries catching up` | same | exact |
| Acting holds the prompt back, compacts (`$.session.compact` with the memory lines as what to keep) or runs `/clear`, then sends the same prompt again as the user and empties the prompt box | Pi can compact under the `input` hook, so the prompt just waits and goes on unchanged | **not exact, better**: nothing is dropped and resent, so there is no draft to clear |
| A prompt with attachments is never held back | nothing is held back, so images go with the prompt after compacting | **not exact, better** |
| Compact: Claude Code's `/compact` with the instructions, summarizing everything | `ctx.compact()`; this extension answers its own `session_before_compact` with a summary from Pi's own summarizer (`generateSummaryWithUsage`, the session's model) over the whole context with the same instructions, and keeps nothing verbatim | **not exact**: Pi's default compaction keeps the last `keepRecentTokens` (20k) verbatim, which would keep exactly the details a related task should drop, so the extension writes the compaction itself |
| Clear: Claude Code's `/clear` (a new session) | a compaction that keeps nothing, with a one-line summary saying the conversation was cleared | **not exact**: Pi's `/new` is only available to commands (`newSession()`), and calling it from the prompt hook would replace the runtime under the prompt being sent. The context is emptied the same way, but the session file and id stay (the earlier messages remain reachable in `/tree`) |
| Compaction refused → keep the context, say why in `/auto-compact` | same | **not exact**: Pi refuses to compact a context that fits in `compaction.keepRecentTokens` (20k by default): "Nothing to compact (session too small)". Claude Code would compact or clear even then |
| Footer labels `context kept · 92%`, `compact? related · 71%`, `cleared · independent · 91%` | the same labels, in the footer segment, plus the context fill | exact, extended |
| Question with buttons in suggest mode; with no one to ask (`-p`), nothing happens | `ctx.ui.select`; `ctx.hasUI` false in `-p` | exact, extended with the context size |
| Debug log line `[auto-compact] <category> · <confidence> → <action>` | appended to `AUTO_COMPACT_DEBUG_LOG` (Pi has no debug log for extensions) | exact format |
| `/auto-compact` status text | same lines | exact |
| `/auto-compact debug` pane, on every surface | a widget below the editor, toggled; in RPC mode a plain-text widget (Pi caps those at 10 lines) | exact content |

## Gaps

- **Summarizer model.** `claude-haiku-5-5` is used only if a Pi provider with credentials
  lists it. Through `pi-claude-code`, that depends on Claude Code's model discovery (the
  package's fallback catalog lists only `claude-haiku-4-5-20251001`). If none does, summaries
  fail, every prompt keeps the context, and the footer, a notification and `/auto-compact` say
  why; set `AUTO_COMPACT_SUMMARIZER_MODEL` to a model that exists, ideally the same
  `claude-haiku-5-5` so the lines match what Spisev was trained on.
- **Clear is not `/new`**, and **small sessions cannot be compacted** (see the table).
- **Subagents**: not detectable; see the table.

## Development

```sh
node --test 'tests/*.test.ts'   # Node 24 (tested) runs the TypeScript directly; no Pi install needed
```

`index.ts` only passes Pi's summarizer to `extension.ts`, so the tests load the extension
against a stand-in for Pi. `tests/parity.test.ts` and `tests/policy.test.ts` are the mod's own
tests; `tests/extension.test.ts` ports its integration tests to Pi's events.
