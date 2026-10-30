# input-autocomplete for Pi

Ghost text in Pi's editor. When the draft is empty, it shows five guesses at
your next message. When the draft is unfinished, it shows five ways to go on.
It also keeps the up-arrow history complete for the session branch.

```
Thanks. Run the tests and show me the output      <- "Run …" is the dim suggestion
```

- **Tab** or **Right** accepts the selected suggestion. The whole
  continuation is inserted, even when only its first line was shown.
- **Down** shows the next suggestion and wraps around. **Up** goes back,
  and on the first one it goes to the prompt history as usual.
- Native autocomplete comes first. While a popup is open (slash commands,
  `@` files, or anything another extension stacks), the suggestion is hidden
  and Tab, Up and Down go to the popup.

The editor is Pi's own `CustomEditor`, built with the same options as the
default editor, working status in the top border included. Pi copies the
padding, border color, popup size and autocomplete provider onto it. The
only thing it adds on screen is the suggestion, drawn with the theme's `dim`
token and with the cursor on its first character, where Tab inserts it.

Port of the pi-harness plugin `pi-input-autocomplete`. It uses only Pi's
public extension API: no pi-runtime, no patched internals.

## Model and billing

Suggestions come from **Claude Haiku 5.5 through the `claude-code` provider**
(your Claude subscription, via the pi-claude-code package):
`ctx.modelRegistry.find("claude-code", "claude-haiku-5-5")`, checked with
`hasConfiguredAuth`, then called with `ctx.modelRegistry.streamSimple`. If
that model is missing or has no credentials, nothing is suggested. It never
falls back to another provider, because that would move the cost to
another bill. `/autocomplete-context` tells you whether the model is
`ready`, `not found` or has `no credentials`.

The recent conversation and the draft are sent with each request.

## Cost: debounce and caching

Every request spawns a `claude -p` process and uses subscription quota. In
testing, a request took about 2 to 3 s from start to suggestion. The
original used a local model and could afford to ask on every pause. Here the
settings are:

| Setting | Original (LM Studio) | Here | Why |
| --- | --- | --- | --- |
| Debounce | 300 ms | **1,200 ms** | A typist's pauses at word boundaries are mostly under a second. At 300 ms, almost every space in a sentence would cost a request. At 1.2 s you get a request when you stop to think, which is when a suggestion helps. |
| Time budget | 6 s for both attempts | **15 s** for both attempts | `claude -p` start-up eats most of 6 s. A request cut short has already been paid for, so the budget leaves room for one retry instead of throwing paid work away. |
| Max tokens | 128 | **512** | Five strings of up to 240 characters do not fit in 128 tokens, and a cut-off JSON reply is a paid failure plus a retry. Tokens that aren't generated cost nothing, so a higher ceiling is free. |
| Cache | 100-entry LRU keyed by conversation + draft, cleared when the agent starts | Same | |
| Typing into a suggestion | New request at the next boundary | **No request**: if the new draft is the old draft plus the start of a shown suggestion, the rest of that suggestion is shown again | The most common case after a suggestion appears is that you start typing it. |
| Empty session, empty draft | Requested | **Not requested** | With no conversation and no draft, a guess has nothing to go on. |
| Popup open when the debounce fires | Requested | **Not requested** | The ghost would be hidden behind the popup anyway. |

The minimum cost is about one request each time the agent settles (the
empty-draft guess for your next message), plus one per pause at a word
boundary while you type. An accepted suggestion doesn't trigger another
request until you type again.

## Features and how they map

| pi-harness plugin | Pi 1.4.0 | |
| --- | --- | --- |
| Five predictions of the next user input, or continuations of the unfinished draft | Same request: system prompt plus one user message holding `{"conversation", "draft"}` as JSON. When there is a draft, the system prompt quotes it exactly. The prompt text is new. | not exact: model, see below |
| Structured output: JSON-schema array of five distinct strings | `streamSimple` through `claude -p` has no schema option (pi-claude-code forwards only `maxTokens` and `reasoning`). The prompt asks for the array, and the reply must parse to exactly five distinct strings or the attempt counts as failed, like an off-schema reply did. | not exact |
| Temperature 0.25, reasoning off | Thinking off (no `reasoning` option, so pi-claude-code disables thinking). There is no temperature: pi-claude-code doesn't forward one. | not exact |
| Two attempts on an unsuccessful response, one shared budget | Same. An error reply or a reply without exactly five suggestions is retried. Cancellation and timeout are not. | |
| Ghost text after the cursor, first line only (`↵` marks more), complete continuation on accept | Same. The cursor cell shows the suggestion's first character. | |
| `[i/n]` position hint after the suggestion | Dropped, so the editor adds nothing but the suggestion. Down and Up still cycle. | changed |
| `…` while a request is in flight | Same, dim | |
| Tab / Right accept, Down cycles, Up moves back | Same, through Pi's keybindings (`tui.input.tab`, `tui.editor.cursorRight/Down/Up`). This means `ctrl+f`, which is bound to cursor-right by default, also accepts. | |
| Native autocomplete menus and cursor movement keep priority | Same: hidden and inactive while `isShowingAutocomplete()`. Any other key clears the suggestion. Shown only with the cursor at the end of the draft. | |
| Predict at the draft's end, when empty or after whitespace or `.!?,;:)]}` | Same | |
| Context: 10,000 conversation characters, 2,000 per message (each message keeps its end), 240 per continuation | Same limits. The conversation comes from `sessionManager.buildSessionProjection()`, so context edits and compaction summaries count. Tool calls appear as `[called name]`, and `!` shell commands are left out. | |
| Continuation clean-up | Strips code fences, `continuation:` labels, a repeated draft and wrapping quotes. Also strips terminal escape sequences and stray control characters, and drops the leading space of a continuation when the draft already ends with one. | |
| LRU cache of 100, cleared when the agent starts | Same (`agent_start`) | |
| Paused while the agent runs, resumed when it settles | `agent_start` pauses. `agent_settled` resumes when `ctx.isIdle()`, after the debounce rather than at once, so typing straight away costs nothing. | |
| Branch navigation clears pending work, cache and diagnostics | `session_tree` resets the predictor and installs a fresh editor (see history) | |
| Shutdown or reload retires the old editor | `session_shutdown` disposes it. Pi itself drops extension editors on reload, and `session_start` installs a new one. | |
| `/autocomplete-context [draft]` shows the last request's exact context, or a preview for a draft, in a read-only viewer | Same (`ctx.ui.editor`; edits are discarded). Also shows whether the model is ready. | |
| Sub-agent screens (`currentScreen`) | Plain Pi shows only the main session, so it reads `ctx` | not applicable |
| Full prompt history | See below | not exact (100 entries) |

## Prompt history

Pi fills the up-arrow history only with prompts still in the model's
context, and only into the editor that exists when it draws the session.
So after a compaction, older prompts disappear once you restart or resume,
and an extension's editor would start with an empty history.

Each new editor is given every user prompt on the current branch, oldest
first, with Pi's own `addToHistory`. Compacted prompts are included. In some
paths, Pi then replays the in-context prompts into the editor: at startup
and after `/tree`. In others it doesn't: `/reload`, and `/resume`, `/new`
and `/fork`, which draw the session before `session_start`. The editor
skips a replay only if it matches the in-context prompts exactly and in
order, and only until the first key press. So prompts don't appear twice,
and nothing you submit is dropped. History keeps Pi's own behavior:
navigation, draft restore, consecutive-duplicate filtering, and slash
commands and `!` commands you submit.

After `/tree` the extension installs a fresh editor, because Pi's history
can only be added to. The new editor holds the new branch's prompts. Pi
keeps the draft text, but the editor's undo stack starts over.

**Not exact:** Pi's `Editor.addToHistory` keeps only the newest 100
entries. The original raised that limit by replacing private storage, which
this port doesn't do. Older prompts on very long branches don't reach the
up arrow.

## Composing with other extensions

- **Editor.** Only one extension can own the editor
  (`ctx.ui.setEditorComponent`). None of the other extensions in this
  directory replaces it.
- **Autocomplete.** Providers stacked with
  `ctx.ui.addAutocompleteProvider(factory)` keep working, whether they are
  added before or after this editor is installed. Pi applies the stacked
  provider to the current editor in both cases, and copies it to each new
  one. Their popup takes precedence over the ghost text as described above.
  No extra hook is needed, so this extension doesn't define a `pi.events`
  API.

## Settings and files

There are no settings. The model, debounce and limits are constants at the
top of `predictor.ts`, `editor.ts` and `prediction.ts`.

- `index.ts`: Pi wiring (events, editor factory, `/autocomplete-context`)
- `editor.ts`: the `CustomEditor` subclass (ghost text, keys, history seeding)
- `predictor.ts`: model lookup, requests, retries, cache, last-request snapshot
- `prediction.ts`: prompt, boundary rule, reply parsing, typed-ahead reuse, LRU. No Pi imports.
- `context.ts`: conversation payload and branch prompts from session data
- `history.ts`: skips Pi's replay of in-context prompts
- `tests/`: `node --test 'modules/home/programs/pi/extensions/input-autocomplete/tests/*.test.ts'`

## Editor additions

- A slash command Pi knows is drawn in the theme's accent color as you type it.
- The slash and `@` popup floats over the chat, just above the editor, instead
  of pushing the input line and the chat up (fullscreen mode).
- Edits Pi doesn't refresh the popup after, such as Cmd+Delete (to the start of
  the line), refresh it.
- With the session-name extension loaded, `/rename` replaces Pi's `/name`:
  typing `/name …` runs `/rename …`, and only `/rename` is offered.
