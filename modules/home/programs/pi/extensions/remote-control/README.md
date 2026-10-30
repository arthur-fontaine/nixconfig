# Remote Control for Pi

Shows a Pi session in claude.ai/code and the Claude apps, like
`claude --remote-control` does, so it can be followed and steered from there.

- `/remote-control` toggles it for the current session.
- `pi --remote-control` starts it with the session. Pi reads the word after
  an extension flag as its value, so don't put a prompt right after it:
  `pi --remote-control -p "…"`, not `pi -p --remote-control "…"`.

It signs in with Claude Code's login (macOS Keychain item
`Claude Code-credentials`, else `~/.claude/.credentials.json`), including the
Trusted Devices token orgs that enforce it need. It never refreshes that
login: when it has expired, start `claude` once.

## Protocol

Private and undocumented, reverse-engineered from Claude Code 2.1.314. The
controller side is documented in
[claude-rc-api](https://github.com/ThatCrispyToast/claude-rc-api/blob/main/API_REFERENCE.md);
this extension plays the worker side:

1. `POST /v1/code/sessions {title, bridge: {}, config}` creates a `cse_…` session (OAuth).
2. `POST /v1/code/sessions/{id}/bridge {}` returns `worker_jwt`, `worker_epoch` and `expires_in`.
3. With the worker JWT, under `/v1/code/sessions/{id}`:
   - `PUT /worker` sets `worker_status` and `external_metadata`
   - `POST /worker/heartbeat` every 20 s
   - `POST /worker/events` posts Claude Code stream-json (`system/init`, `user`, `assistant`, `result`, `control_response`)
   - `GET /worker/events/stream` (SSE, `client_event` frames) brings the controllers' messages and `control_request`s
   - `POST /worker/events/delivery` acknowledges them
4. `POST /v1/code/sessions/{id}/archive` when Pi exits.

## Limits

- No live streaming of the reply: messages appear once complete.
- Pi asks no permissions, so the session reports `bypassPermissions` and refuses other modes.
- Answers `initialize`, `interrupt`, `set_model`, `apply_flag_settings` (effort), `get_context_usage` and `mcp_status`; other control requests get an error.
- A Pi killed without its normal shutdown leaves its session open until it times out.
