# Session Name for Pi

Names Pi sessions like Claude Code's `/rename`, and keeps the name in step with
the task. The names are the addresses [pi-intercom](https://github.com/nicobailon/pi-intercom)
uses (`@fix-login-bug message`), so they are short kebab-case, unique among
the live sessions, and stable.

- `/rename <name>` sets the name by hand. It becomes an address: `/rename My
  Feature` names the session `my-feature`. A name given by hand is never
  changed automatically.
- `/rename` with no argument generates a name from the conversation and puts
  the session back under automatic naming.
- An unnamed session is named after its first completed run.
- While the session is under automatic naming, a quiet re-check after later
  runs renames it when the task has clearly changed.
- A name set any other way (Pi's `/name`, `pi --name`, intercom's `/alias`)
  counts as given by hand.

The mode (automatic or by hand) is saved in the session with
`pi.appendEntry("session-name", {mode, name})`, so it holds after a resume.
Names come from Claude Haiku 5.5 through the `claude-code` provider only,
never the built-in `anthropic` one. Without that model, automatic naming
skips silently and `/rename` says why.

## From Claude Code

Read from Claude Code 2.1.314 (module `chunk-xtsj4e07.js` of the binary):

- `/rename [name]`, alias `name`, "Rename the current conversation". With no
  argument it generates a name, or answers "Could not generate a name: no
  conversation context yet. Usage: /rename <name>".
- The generator's prompt, copied in `prompts.ts`, asks for a kebab-case name of
  2-4 words as JSON. It runs on the small fast model (Haiku), thinking off,
  over the user and assistant text of the conversation (its last 1000
  characters).
- A typed name keeps its case and spaces; it is only cleaned of control and
  format characters and cut at 200 characters. A name another live session
  holds gets a random suffix (`-calm-otter`).
- The title in `/resume` is a different thing: the `ai-title`, a 2-5 word
  sentence-case phrase made once from the first prompt and never redone. It
  isn't used here, because it has spaces and capitals. The name given by
  `/rename` (`custom-title`) is never redone either, which is why Claude Code's
  names fall behind when the task changes.

What differs here: names are always kebab-case and at most 40 characters, a
collision adds `-2`, `-3`, … (easier to type after `@`), and names follow the
task.

## The re-check

After a run settles in a session under automatic naming:

1. It waits 20 s of quiet; a new prompt cancels the wait.
2. It skips unless, since the last check, there is a new prompt, at least 800
   characters of new conversation (each message clipped to 600), and the
   interval has passed: 2 minutes, doubled after each "keep" in a row, up to 30
   minutes.
3. It skips while intercom traffic shows in the last 10 minutes of the
   transcript (a message from a peer, or a call to the `intercom` tool), as a
   peer may be about to use the name.
4. Haiku gets the current name and the last 3000 characters of the
   conversation, and answers `{"action": "keep"}` or `{"action": "rename",
   "name": …}`. The prompt keeps the name for follow-ups, sub-steps and fixes
   of the same task.
5. A new name that only adds, drops or reorders words of the current one is a
   keep. A rename that arrives after the person started another prompt is
   dropped and judged again after that run.

Uniqueness: the extension registers with intercom's extension bus (namespace
`session-name`) and checks `listSessions()` before setting a name. Without
intercom, or while it is disconnected, names aren't checked.

## Limits

- An exchange with no trace in the transcript yet (a peer about to send to
  this session) can't be seen; a rename then makes the peer's `@old-name` miss.
- Uniqueness is checked when a name is set; a session that later takes the
  same name isn't renamed.
- Only sessions with a UI (TUI, RPC) are named automatically; `pi -p` runs aren't.
- `PI_SESSION_NAME_DEBUG=<file>` logs each decision.

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly; no Pi or network needed
```
