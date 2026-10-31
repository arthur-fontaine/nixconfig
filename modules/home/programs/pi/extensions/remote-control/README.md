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
4. `POST /v1/code/sessions/{id}/archive` when Pi exits, unless
   `"remoteControlArchiveOnQuit": false` is in `settings.json`. `/remote-control`
   off always archives.

A session left open that way is saved in the Pi session (a `remote-control`
entry: its id, the last controller event read, the last Pi entry posted).
Resuming the Pi session reattaches to it through `/bridge` and posts only what
came after; after `/tree` to another branch, or when the remote session is
gone, it starts a new one.

Attachments come as `file_attachments[].file_uuid`, downloaded from
`GET /api/oauth/files/{uuid}/content`.

### Prompts that wait on the person

From Claude Code 2.1.314's REPL bridge (`f$o`, the racer `Jo`, the remote bridge's
`sendControlRequest`), and its SDK schema for the fields the REPL path leaves out:

- A permission prompt is a `control_request` with `request: {subtype: "can_use_tool",
  tool_name, display_name, input, tool_use_id, description, permission_suggestions?,
  blocked_path?, requires_user_interaction?, tool_kind?}`. `display_name` is the tool name
  with its `mcp__…__` prefix dropped and words capitalized. The SDK path adds
  `decision_reason` (the escalation's text), `decision_reason_type` (`classifier`, `rule`,
  …), `decision_reason_code` (`classifier_transcript_too_long`, …), `title`, `agent_id`;
  for a classifier's escalation its `description` is the call's summary, then the reason.
  AskUserQuestion and ExitPlanMode are such prompts too.
- The apps answer with a `control_response` whose `response` is `{subtype: "success",
  request_id, response: {behavior: "allow", updatedInput?, updatedPermissions?} |
  {behavior: "deny", message, interrupt?}}`. `updatedPermissions` are the "always allow"
  choices, taken from the `permission_suggestions` offered (`{type: "addRules", rules,
  behavior, destination}`). A deny's message, other than "User denied permission", reaches
  the model as the person's feedback.
- While a prompt waits, `PUT /worker` reports `worker_status: "requires_action"`. Behind the
  `tengu_bridge_requires_action_details` flag (off by default, set by the server) it adds
  `requires_action_details: {tool_name, display_tool_name, action_description,
  raw_command?, tool_use_id, request_id, input}`, and `external_metadata.pending_action`
  (the same details) and `pending_actions` (the latest first). A Bash command's
  description is its first 120 characters. AskUserQuestion's card is `display_tool_name:
  "Question"`, its header (`+N more`), with `request_id: ""` and the id in
  `suppressed_request_id`. Once none is left: `running` (or `idle`),
  `requires_action_details: null`, the metadata `null`.
- Answered at the terminal, Claude Code sends the apps that answer as a `control_response`
  (`allow` with `updatedInput` and `updatedPermissions: []`, or `deny` with "User denied
  permission", "User aborted" on Esc), then `control_cancel_request {request_id}`.
- The apps' `initialize` gets the waiting prompts in `pending_permission_requests`.
- Its other dialog type, `request_user_dialog {dialog_kind, payload, tool_use_id?}`, goes
  over Remote Control only for `refusal_fallback_prompt` and `fable_overage_consent_prompt`,
  and only to an app that declared the kind in `initialize.supportedDialogKinds`;
  `enum_prompt` (its generic choice), `auto_mode_server_fallback` and MCP `elicitation` go to
  SDK hosts only. So a generic choice goes as an AskUserQuestion prompt.
- Claude Code keeps some prompts at the terminal: its newer timed or blocking denial-limit
  dialog for auto mode (`denialLimitFallback`), auto-deny windows and one-time-only answers.

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
- Auto mode's prompts (after too many blocked calls, or when the conversation is too long
  for its check) show as Claude Code's permission sheet for that call, with the reason (as
  `decision_reason`, and on the line after the call in `description`).
  Allow or Deny there answers it; a reason typed with Deny reaches the model. The sheet
  can't edit the call: an edited call is refused, saying so.
- auto-compact's offer shows as a one-question AskUserQuestion sheet. Picking an option
  answers it; dismissing it, or typing an answer that is no option, sends the prompt as is,
  like Esc. This also lets a prompt sent from the phone go on.
- For both, whichever side answers first wins: the terminal dialog closes when the apps
  answer, and an answer in the terminal is sent to the apps and the sheet withdrawn. Stop
  in the apps dismisses both (for the offer, before the turn starts, the prompt is then sent
  as is); stopping Remote Control withdraws the sheet and leaves the terminal to decide.
  (These three were checked against a local fake of the service, not yet on the phone.)

## Dialogs from other extensions

An extension that asks the person something mid-turn can have it asked in the apps too,
through `pi.events` (`dialogs.ts` has the types):

```ts
const dialog = { request, signal };
pi.events.emit("remote-control:dialog", dialog);
const answer = dialog.run ? await dialog.run(local) : await local(signal ?? new AbortController().signal);
```

- `request` is `{kind: "permission", toolName, toolCallId, input, reason, reasonCode?}`
  (Pi's tool name and input; the answer is `{allow, message?}`), or `{kind: "choice",
  question, header?, options}` with 2 to 4 options (the answer is the option, or
  `undefined` when dismissed).
- `local(signal)` opens the terminal dialog and must close it when `signal` aborts (Pi's
  `ctx.ui.select/confirm/input` take it as `{signal}`).
- With Remote Control on, remote-control sets `run` before `emit` returns; otherwise nothing
  does, and the terminal dialog alone is asked, as before.

It is opt-in rather than a wrapper of `ctx.ui.select`: Pi's `ui_prompt_start` event carries
only the dialog's kind and title, not its options, and can't answer it, so remote-control
can't mirror a dialog it isn't handed. Each extension ships alone, so the contract is
events, not a shared module.

## Limits

- No live streaming of the reply: messages appear once complete.
- Pi has no permission modes of its own, so the session reports `bypassPermissions` and refuses
  other modes; only auto mode's prompts ask (see above).
- Other control requests (side questions, MCP servers the app pushes, …) get an error.
- A Pi killed without its normal shutdown leaves its session open until it times out.
- `PI_REMOTE_CONTROL_DEBUG=<file>` logs the bridge's lifecycle. `PI_REMOTE_CONTROL_API=<url>`
  sends everything to a local fake of the service instead, without reading the login.
