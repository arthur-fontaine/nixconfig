# You should know for Pi

A side agent watches the session while Pi works and, when it finds the one
thing you should know but might miss, flags it above the editor. A port of
Claude Code 2.1.314's built-in plugin `cc-plugin-you-should-know`;
[SPEC.md](SPEC.md) describes the original, read from its minified bundle.

```
✦ Heads up · Storing passwords as plain MD5 hashes is unsafe, and attackers can crack them quickly.
  1: Learn more   2: Knew this already   3: What is this   4: Disable   0: Dismiss
```

## Use

- Every 6th model request of a long run (6, 12, 18…, while tools keep the
  agent going) it forks the conversation and asks the current model whether
  anything clears a very high bar. Most of the time nothing shows.
- `alt+k` moves the keyboard to the band (the terminal must send Option as
  Meta, as for Pi's own `alt+enter`). Then press a digit, or move with
  `tab`/`→`/`shift+tab`/`←` and press with `enter`/`space`; `esc` (or typing)
  goes back to the editor.
- `/you-should-know` alone opens the same choices in a list.
  `/you-should-know off` turns it off on this machine (that's what
  "Disable" puts in the editor), `on` back on, `status` shows the counts and
  the state file, `check` asks the side agent right now.
- "Learn more" shows the explanation the side agent already wrote (no extra
  request); only when it didn't write one is the model asked again. "Chat in
  main session" puts the note in the editor for you to send.
- `PI_YOU_SHOULD_KNOW_DEBUG=1` shows the last three checks above the band.

The side requests use Pi's current model through
`ctx.modelRegistry.streamSimple`, with the session's own context (system
prompt, tools, messages) and the prompt appended, so they work with the
`claude-code` provider and count against the same subscription. Each one is
a separate Claude Code process that replays the conversation.

## State

- Across sessions: `<agent dir>/you-should-know/state.json` (`~/.pi/agent/…`,
  or under `PI_CODING_AGENT_DIR`): the last 50 lines offered, the last 50 you
  said you knew, the backoff counters, and `enabled`.
- Per session: a `you-should-know` custom entry (`pi.appendEntry`) each time
  the band changes, so `/reload` and `/resume` bring an open suggestion back.
  Quitting or switching sessions clears it, as Claude Code does at session
  end.

## What is exact, and what isn't

Read verbatim from the bundle and kept identical (checked against the
bundle's own code with a differential script during the port):

- all prompts (`prompts.ts`): the proposal prompt, the explanation prompt,
  the "in simpler words" / "with less detail" / "in more detail" rewrites and
  their length rules ("At most 100 words…", "At most 45 words.", "At most 160
  words…"). One word differs: the side-request frame says "via Pi's" where
  Claude Code says "via Claude Code's";
- reply parsing, the dedupe key, the 240-character line limit, card limits,
  the almost-literal Markdown of the explanation, and the "Chat in main
  session" note (`parse.ts`);
- the trigger (every 6th step, one offer per turn, nothing while a row
  shows, one check at a time), the backoff (free twice, then skip 1, 2, 4, 8,
  16 checks), an offer surviving one prompt and clearing on the second, the
  20-second "Dismissed." row, what each choice does and the labels.

Inferred or adapted:

- **Rewrites**: Claude Code 2.1.314 has the three rewrite prompts but no
  button that calls them. The port wires them as `3: Simpler words`,
  `4: Less detail`, `5: More detail` on the explanation; labels and hotkeys
  are mine.
- **Keys**: Claude Code focuses its band with `ctrl+x tab`, which Pi already
  uses (`ctrl+x` copies). The port uses `alt+k`, adds a dim
  "(alt+k to choose)" hint Claude Code doesn't show, keeps the focus after
  "What is this" and the first "Disable" press, and returns to the editor
  after any other choice.
- **Turn and step**: a Claude Code turn is a Pi agent run (`agent_start`),
  a step a Pi turn. The check runs at `turn_end` of the 6th, 12th… turn when
  it has tool results, i.e. when Claude Code's step 6 would start.
- **Remote prompts**: Claude Code skips checks when the last prompt came
  over Remote Control. The port treats any prompt from another extension
  (`input` source `extension`, which is how the remote-control extension
  sends) the same way.
- **Turning off**: Claude Code fills the prompt with `/plugin disable
  cc-plugin-you-should-know@builtin` and disables the plugin; the port fills
  `/you-should-know off`, which sets `enabled: false` in the state file. The
  about copy names that command, and says "while Pi works".
- **Per-session row**: Claude Code keeps it in its store (32 sessions, 3-day
  eviction); the port appends it to the session, so there is nothing to
  evict. An "explaining" or "Dismissed." row is dropped when a session is
  resumed, since its request or timer died with the old process.
- `check` and `status` subcommands, and the explanation being drawn with
  Pi's own Markdown renderer.

Not ported, and why:

- **Learn page** (a private claude.ai Artifact): dead code in 2.1.314
  (nothing sets it, no button offers it) and the page prompt isn't in the
  bundle. Pi has no Artifacts; the closest equivalent would be an HTML file
  under the state directory opened in the browser (SPEC.md §10).
- **Telemetry**: no events or health marks.
- **Availability gates**: the growth flag, org restrictions and the opt-in
  default. Installing the extension turns it on; `off` turns it off.
- **`USER_TYPE`**: Claude Code hides "What is this" and "Disable" from
  external users; the port shows the full set.
- **Other surfaces**: desktop, mobile and VS Code layouts, the about card's
  row budget, survey hiding, and the "no prompt box" fallback of "Chat in main
  session". Pi draws only in its terminal UI; in RPC, JSON and print modes the
  extension stays idle.
- The spinner tip advertising the plugin.

## Tests

`node --test tests/*.test.ts` (Node 24 runs the TypeScript directly).
