# Remote Control for Pi

Shows a Pi session in claude.ai/code and the Claude apps, like
`claude --remote-control` does, so it can be followed and steered from there.

- `/remote-control` toggles it for the current session.
- `"remoteControlAtStartup": true` in `settings.json` (Claude Code's setting)
  starts it with every interactive session.
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

Attachments come as `file_attachments[].file_uuid`, downloaded from
`GET /api/oauth/files/{uuid}/content`.

## From the apps

Tested from the Claude iOS app:

- The session shows the conversation so far, including when started mid-way.
- Messages run in Pi; tool calls show with their input and output.
- A message sent while Pi works joins the running turn (Pi's steer), as in
  Claude Code. One the app marks `later` waits for the turn to end.
- Stop interrupts the turn.
- The model and effort pickers switch Pi's model (within its current
  provider) and thinking level.
- Photos reach the model; other files are saved under the system temp
  directory and their path is given to Pi.
- The session is titled with Pi's session name, and renamed with it (`/rename`,
  automatic names), through `PUT /v1/code/sessions/{id}` as Claude Code's
  `/rename` does.
- `/compact` compacts Pi's conversation. Other slash commands get a notice.
- Pi's tools show as Claude Code's (`read` as Read, `edit` as Edit with its
  diff, `find` as Glob, …), with the structured output the apps render, so a
  read image appears under its Read like in Claude Code.
- `send_user_file` is Claude Code's SendUserFile, offered while Remote Control
  is on: it uploads files to `POST /api/oauth/file_upload` (30 MiB each) and
  the apps show a card for each, opened from its `file_uuid`.
- Questionnaires from `ask_user_question`
  ([@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question))
  show as Claude Code's AskUserQuestion prompt, through the package's
  `rpiv:ask-user:*` events. Options, multi-select and typed answers all come
  back. Whichever answers first wins: answering in the terminal withdraws the
  prompt from the apps, and dismissing it in the apps declines it. This needs
  Pi's terminal UI: in RPC mode the package uses Pi's own dialogs, which
  can't be answered from outside.

## Limits

- No live streaming of the reply: messages appear once complete.
- Pi asks no permissions, so the session reports `bypassPermissions` and refuses other modes.
- Other control requests (side questions, MCP servers the app pushes, …) get an error.
- A Pi killed without its normal shutdown leaves its session open until it times out.
- `PI_REMOTE_CONTROL_DEBUG=<file>` logs the bridge's lifecycle.
