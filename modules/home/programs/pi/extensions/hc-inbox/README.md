# hc inbox

`hc send <t> "…"` types into the target terminal: a bracketed paste of the
message, then Enter about 200 ms later as separate input. In Pi that lands in
whatever the user is drafting and submits it along with the draft.

This extension takes both from the terminal input (`ctx.ui.onTerminalInput`)
before the editor sees them, and sends the message with `pi.sendUserMessage`:
right away when Pi is idle, as a steer during a run (what Enter does then).
The draft keeps its text and cursor.

## What counts as hc's

Measured with `hc run --bg` and a raw-mode capture of stdin:

- A terminal that reports agent status (OSC 7501, as Pi does) gets
  `ESC[200~<hc from="t4q name">text</hc>ESC[201~`, then `\r` on its own.
  `reach="…"` follows `from` when hc asks for a report.
- Only a paste that is exactly one such tag is taken; a paste with other text
  around it, or an untagged one, is the user's.
- Only the first Enter within 1 s of that paste is taken. Keys typed in
  between still reach the editor.
- With `notes = false` in hc's config, messages are untagged and can't be told
  apart from a paste, so they go to the editor as before.

The extension only loads when `HC_TERMINAL_ID` is set, i.e. in terminals
hc runs. During a compaction Pi refuses prompts, so messages wait for it to end.

## Tests

```sh
node --test 'modules/home/programs/pi/extensions/hc-inbox/tests/*.test.ts'
```
