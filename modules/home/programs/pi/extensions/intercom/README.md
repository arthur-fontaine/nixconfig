# Intercom for Pi

Talk to another running Pi session by mentioning it:

```
@api-worker the tests pass on main now, rebase and retry
```

The message goes straight to that session through
[pi-intercom](https://github.com/nicobailon/pi-intercom), which shows it there
and starts a turn. This session's agent doesn't run. It gets a note of what was
sent, so it understands the reply when one comes back.

- Typing `@` completes the running sessions by name, next to Pi's file completions.
- Mentions at the start are only the address and aren't sent. Mentions inside
  the sentence (`ask @research about it`) stay in the text, which still goes to
  every mentioned session.
- Sessions are known by their Pi session name. The session-name extension
  names them, so the names follow the task.
- A name that doesn't match a running session, or that is also a file or folder
  in the working directory, is left to Pi: the message goes to this session's
  agent as usual.
- Only text is sent. Attached images stay behind, with a warning.
- When delivery fails, the error shows and the message returns to the editor.

The agents themselves still use pi-intercom's `intercom` tool to reply, ask
and list sessions.

## Setup

Pi installs `pi-intercom` (settings.json) with its own extension turned off.
This extension loads it from Pi's npm directory without its `/intercom`,
`/intercom-id`, `/intercom-pool`, `/alias` and `/handover` commands or the
Alt+M overlay, then adds the mentions. Sending goes through the package's
public outbox events (`intercom:outbox-request`/`intercom:outbox-result`);
the session list comes from its extension channel (`intercom:extension-register`).

`PI_INTERCOM_MENTIONS_DEBUG=<file>` logs the sessions the mentions see.
