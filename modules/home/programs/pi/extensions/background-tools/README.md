# Background tools for Pi

A rewrite of pi-harness's `pi-background-tools` plugin on Pi 1.4's public
extension API alone. A running `bash` call can be detached from its turn:
the command keeps running, the model gets a placeholder result and carries
on, and when the command ends its final output takes the placeholder's place
and the model is woken up to read it.

- **Ctrl+B** while bash runs moves it to the background.
- `bash` takes `background: true` to start detached.
- `bash_output { id, lines? }` shows what a detached call has printed so far,
  or its final output.
- `bash_kill { id }` stops one and returns its last 20 lines.

```
 $ npm run dev
 > vite
 Elapsed 1m 12s
 ◌ running in the background · toolu_01F3uru2uPAuHEfEbZvJfffN
```

## From the plugin to Pi

| pi-background-tools | In Pi | Same? |
|---|---|---|
| Ctrl+B detaches every eligible running call: top-level, model-issued, in the TUI | Ctrl+B (raw terminal input, `ctx.ui.onTerminalInput`) detaches the running top-level `bash` calls. The key is only taken when something was detached; otherwise it stays the editor's cursor-left | bash only: the plugin wrapped every tool's `execute` in Pi's registry, and an extension can only wrap a tool by overriding it (see [Limits](#limits)) |
| `bash` gains `background: boolean`, added by an outermost decorator and stripped before the real bash runs | This extension overrides `bash` (`registerTool` with the same name) with the built-in definition, rebuilt with the same `shellCommandPrefix` and `shellPath` settings, plus `background` in its schema. The flag is stripped before the built-in `execute` runs. Description, prompt snippet, `outputSchema`, renderers and execution mode are the built-in's; one prompt guideline is added | Yes |
| `background: true` detaches as soon as the call starts, through the same path as Ctrl+B; nested calls and non-TUI modes run in the foreground | Same: only calls whose `tool_call` has no `parentToolCallId`, in the TUI, can detach | Yes |
| The placeholder result names the call ID | Same, with `details: { background: { startedAt } }` so it can be recognized later. Bash's own `details` fields are simply absent | Yes |
| `bash_output { id, lines? }`: latest partial output (bash's rolling tail, naming the full-output temp file once truncated) or the final one, with state and elapsed time | Same. It also answers for calls that ended before a reload, from their saved result | Yes |
| `bash_kill { id }`: aborts, waits for the outcome, returns the last 20 lines; the result is still saved; no follow-up turn | Same. Killing a call that already ended says how it ended | Yes |
| Foreground behavior, Escape, timeouts | Until it is detached the call is the built-in's own execution: same updates, abort and result or error. Once detached, Escape no longer reaches it, its `timeout` still does | Yes |
| Final result passed through Pi's `afterToolCall` (other extensions' `tool_result` handlers, image normalization) | Not possible from an extension: Pi runs `tool_call` and `tool_result` handlers once, on the placeholder. The final result goes out on the `background-tools` event channel instead | No |
| Final result saved as a `background.tools.completion.v1` custom entry and laid over the original tool result by a patched session projection, so later context edits still apply | Saved as a `background-tools.result` custom entry (`pi.appendEntry`). A `context` handler lays it over the placeholder in each model request, and at the next `turn_end` or `agent_before_settle` a `context_edit` writes its content into the session, so compaction and sessions opened without this extension see it too. A placeholder another extension has already edited or omitted is left alone | Content: yes, and durable without the extension once the edit landed. The raw entry keeps the placeholder's `details` and error flag; the `context` handler sets the flag in requests |
| A hidden follow-up message wakes the model when a call ends on its own | Same (`pi.sendMessage`, `deliverAs: "followUp"`, `triggerTurn: true`, `display: false`). Not sent for a killed call, nor when the session moved to another branch (`/tree`) since the call was detached | Yes |
| The tool's row: status footer replaced by `◌ background`, `✓ completed in background` or `× failed in background` with the elapsed time, header recolored, repainted on the shared clock; rebuilt from the session on reload | Through `registerToolRenderer`, chaining on `next()`: bash's own renderer (and whatever chained onto it, such as syntax highlighting) draws the live or final output instead of the placeholder, with its own `Elapsed`/`Took` timer, and one line is added under it. Repainted on each update. Rebuilt from the saved results on reload | The row's background stays Pi's "finished" color while the call runs, and isn't red when it fails: the shell is drawn by Pi from the placeholder. The header keeps its color |
| Footer status `bg tools: N` | `N commands in background` (`1 command in background`) | Wording |
| Events on `pi.events` (`pi-harness:background-tool`): `update`, `end` with `isError` and `stopped` | Channel `background-tools`: `detach`, `update`, `end` (same fields). Typed as `BackgroundToolEvent` in `index.ts` | Channel name; `detach` added |
| Shutdown, session replacement and reload abort detached calls; their results become explicit "interrupted" results; nothing is resumed | Same: `session_shutdown` aborts them (the process tree is killed), and the next `session_start` (or `/tree`) saves an `interrupted` result for any placeholder on the branch that has none | Yes |
| `./api`: `getBackgroundTools()` with `runningCalls()`, `requestBackground()`, `registeredTool()` | — | Not ported: Pi extensions don't import each other. The event channel covers observation |
| Message renderer for the follow-up | — | The follow-up is hidden, so nothing renders it |

## With other extensions

This is the only extension that overrides `bash`. The others keep working on
it through Pi's events:

- `tool_call` handlers see the model's input, `background` included (it's
  stripped only before the built-in runs), and can still block or edit it.
- `tool_result` handlers see the placeholder of a detached call, at the time
  it detached, not its final result. bash-changes, which snapshots git around
  a call, so misses what a detached command changes afterwards; the `end`
  event on `background-tools` is the place to catch it.
- Renderers chained with `registerToolRenderer` keep drawing bash; a
  detached row is fed the live or final result, not the placeholder. One
  that replaces bash's `renderResult` without calling through to `next()`
  hides the detached output.

## Limits

- Only `bash` can be detached. Wrapping another tool means overriding it,
  which would clash with other extensions that override it.
- Replacing an earlier tool result changes the prompt's prefix from there on,
  so the next request misses the prompt cache past that point, as with the
  plugin.
- `/tree` doesn't stop detached calls. One that ends after the session moved
  to another branch saves its result there, where it applies to nothing; its
  own branch gets an `interrupted` result on the next `/tree` back to it.
- HTML exports show a detached row's placeholder text: Pi draws `bash` in
  exports with its own template, not with the tool's renderers.

## Files

- `index.ts`: the `bash` override, `bash_output`, `bash_kill`, Ctrl+B, the
  session hooks and the footer status.
- `call.ts`: one detachable execution.
- `records.ts`: the placeholder, the saved results and how they're laid over
  the placeholder (no Pi imports).
- `render.ts`: the row of a detached call.

## Tests

```sh
node --test 'modules/home/programs/pi/extensions/background-tools/tests/*.test.ts'
```

They cover the saved results, their projection into requests and context
edits, and detaching, stopping and closing a call. The rest was checked by
hand in Pi 1.4.0's TUI with claude-haiku-4.5: `background: true`, Ctrl+B on
a foreground call, `bash_output` while running and after, `bash_kill` with no
follow-up turn, the final output reaching the next request, the context edit
landing, a call ending before Pi saved its placeholder (one follow-up, the
session stays linear), quitting with a call running (no process left,
`interrupted` on resume), the rows rebuilt on resume, and alongside
bash-changes; and in print mode, where `background: true` runs in the
foreground.
