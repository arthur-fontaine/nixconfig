# browser

Browser use for Pi through the Claude in Chrome extension, the way Claude Code's
`--chrome` does it: Claude Code's own 20 browser tools, run by the extension in
Some Browser (any Chromium browser with the extension), with the tab's screen
live in the tool's row.

- **Tools.** `mcp__claude-in-chrome__navigate`, `…__computer`, `…__read_page`,
  `…__find`, `…__form_input`, `…__tabs_context_mcp`, `…__tabs_create_mcp`,
  `…__tabs_close_mcp`, `…__browser_batch` and the others: the names Claude
  Code's model sees, with Claude Code's descriptions and input schemas
  ([claude-tools.json](claude-tools.json), the `tools/list` of
  `claude --claude-in-chrome-mcp` 2.1.322). They are `deferred`: `tool_search`
  loads them, as Claude Code's ToolSearch does. A short guidance section goes in
  the system prompt.
- **Permissions.** No prompt of ours. Pi's auto-mode classifies each call like any
  tool's; a call its classifier lets through has the extension's site checks
  lifted for that call, as Claude Code does (see [Permissions](#permissions)).
- **Transport.** Anthropic's Claude in Chrome bridge, signed in with Claude Code's
  login, as Claude Code does (see [How it reaches the extension](#how-it-reaches-the-extension)).
- **Live view.** While a tool acts on a tab, the tab is screenshotted at up to
  3 fps (fewer when screenshots are slow: at most half the time is spent
  capturing), and the frame is drawn across the row with Kitty Unicode
  placed directly as Pi's own images are (image-view's `kitty.ts`): Unicode
  placeholders showed Herdr's line gaps as stripes. An unchanged screen is not redrawn.
  When the tool ends, one more screenshot is kept as a still, saved under
  `$TMPDIR/pi-browser-frames/` so a resumed session shows it too. Without Kitty
  graphics, the row gets a line of text instead, and no screenshots are taken.
- **Each session its own tabs.** Calls carry `session_scope: {sessionId}` (Pi's
  session id), so each Pi session gets its own tab group, as Claude Code sessions do.

## How it reaches the extension

Like Claude Code 2.1.322: through Anthropic's Claude in Chrome bridge
(`bridge.ts`). Claude Code's Chrome setup (`createChromeContext`) configures the
bridge and no local pairing. The extension honours the client's permission
settings only on bridge calls (source `bridge`) or on paired native calls; a
clear-text call on the native socket gets the extension's own popup, which
refused at once here.

**Sign-in.** Claude Code's OAuth access token, read read-only by
remote-control's `loadCredentials` (keychain item `Claude Code-credentials`, else
`~/.claude/.credentials.json`), never logged, written or refreshed: an expired
login fails with "Start `claude` once to refresh it". The claude.ai account uuid
comes from Claude Code's `~/.claude.json` (`oauthAccount.accountUuid`).

**Connection.** A WebSocket to
`wss://bridge.claudeusercontent.com/chrome/<account uuid>`. Every frame is one
JSON text message. The client opens with
`{"type":"connect","client_type":"claude-code","oauth_token":"…"}`, and the
bridge answers `paired` (an extension is online for the account) or `waiting`.
`ping`/`pong` both ways every 30 s; no pong for 90 s means a dead link.

**Choosing the browser.** `{"type":"list_extensions"}` →
`{"type":"extensions_list","extensions":[{deviceId,name,osPlatform,connectedAt}]}`;
`peer_connected` / `peer_disconnected` follow changes. One extension is taken
as is. With several, this Mac's (macOS), most recently connected, unless
`select_browser` chose one.

**A call.**

```json
{"type": "tool_call", "tool_use_id": "<uuid>", "client_type": "claude-code",
 "tool": "navigate", "args": {"url": "http://127.0.0.1:8917/", "tabId": 373894578},
 "supports_tool_result_notices": true, "supports_tool_result_error_code": true,
 "target_device_id": "<deviceId>", "permission_mode": "ask",
 "handle_permission_prompts": true, "session_scope": {"sessionId": "<Pi session id>", "tabGroupId": 636092276}}
```

The bridge acknowledges with `{"type":"routing_ack","tool_use_id"}`. The
extension may then ask:
`{"type":"permission_request","tool_use_id","request_id","tool_type":"navigate","url":…}`,
answered with
`{"type":"permission_response","request_id","allowed":true,"target_device_id"}`.
The result is `{"type":"tool_result","tool_use_id","content":[…],"is_error"?}`
(or `result`/`error` objects). Content is MCP's: text, and image blocks for
screenshots. A prompt or result for another `tool_use_id` (Claude Code's,
another Pi session's) is ignored, so they all share the bridge.

## The native host socket

`client.ts` and `protocol.ts` also speak to the native messaging host that Claude
Code installs (`claude --chrome-native-host`); they're kept for reference and
tests, but tools go through the bridge. The host listens on
`/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` (0700 folder, 0600 socket).
Frames are a 4-byte little-endian length then UTF-8 JSON.
`{"method":"execute_tool","params":{client_id,tool,args,tool_use_id,session_scope?,permission_mode?,handle_permission_prompts?}}`
goes to the extension, and every reply
(`{tool_use_id,result|error}`) and notification (`{method,params}`) goes to every
connected client, routed by `tool_use_id`. The extension refuses site actions
from such clear-text calls unless the socket is paired (`local_pairing`: an ES256
assertion from `api.anthropic.com/api/oauth/local_pairing/attest`, ECDH, then
AES-GCM-sealed frames), and it pairs only with Claude Desktop (`client_kind`
`desktop`).

## Permissions

Pi's auto-mode is the only permission system, as Claude Code's is in Arthur's
setup. Each call's permission mode is chosen as Claude Code 2.1.322 chooses it
(`permissions.ts`, its Chrome tools' `call`), from the page the call acts on:
the navigate URL, a batch's own navigate, else the tab's current URL (looked up
with `tabs_context_mcp` in `ask` mode).

- **The classifier let the call through, its host is known, no deny rule:**
  `permission_mode: "skip_all_permission_checks"` for that call only. A fast-path
  allow doesn't count: auto-mode tells the extension through
  `Symbol.for("pi-auto-mode.classifier-allowed")`.
- **A known host otherwise:** `follow_a_plan` with `allowed_domains` (that host and
  those of earlier calls), and the extension's prompts answered `allowed: true`.
- **No host:** `follow_a_plan` with the hosts allowed so far, or `ask`.

Nothing is session-wide: every call carries its own mode, and the live view's
screenshots carry their call's.

Arthur's decisions of 2026-11-13:

- **B′, this per-call choice, replaces decision A as the primary path.** A only
  answered the extension's `permission_request`s. But a step inside
  `browser_batch` never raises one: the extension stops the batch with
  "permission_required … call computer standalone (not in browser_batch) so the
  user is prompted". A batch that clicked then zoomed failed that way. Claude Code
  avoids it by lifting the site checks for the calls its auto mode classified.
- **A, still the fallback:** for calls not lifted, a prompt for a call Pi let
  through is answered `allowed: true`. A call auto-mode denies never reaches the
  extension, and Pi adds no dialog of its own.
- **Bridge.** Pi reaches the extension as Claude Code does, through the bridge
  with his Claude Code OAuth token (read-only, never printed, logged or written),
  rather than spawning Claude Code or pairing locally.

## Browser closed

With no extension on the bridge for the account, a call waits up to 10 s for one
to come online, then fails with a clear message: open Some Browser (signed in to
the same claude.ai account) and retry. A connection lost mid-call fails the call;
the next call connects again.

## Files

- `bridge.ts`: the bridge client: sign-in, browser choice, calls by id, permission prompts, keepalive.
- `protocol.ts`, `client.ts`: the native host socket's framing and client (not used for calls).
- `calls.ts`: what Claude Code does around a call:
  - `navigate` without a `tabId` makes or finds the session's tab;
  - `file_upload` reads `paths` into `files`;
  - `save_to_disk` keeps the screenshot in a file;
  - the three browser-choice tools are answered here;
  - results become Pi content.
- `permissions.ts`: each call's permission mode, as Claude Code chooses it.
- `tools.ts`: the tool definitions from `claude-tools.json`.
- `liveview.ts`: the frame pump and the Kitty view.
- `index.ts`: the Pi wiring.

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly
```

- `bridge.test.ts`: a fake bridge: connect frame and URL, tool_call fields, a
  permission prompt answered for our call only, errors, ping, browser choice,
  no extension, no login.
- `protocol.test.ts`: framing (cut at any byte), requests, a fake host relaying
  to two clients, a permission prompt answered, no socket.
- `permissions.test.ts`: each branch of the choice, a batch that clicks then
  zooms on one host, and how the target page is found.
- `tools.test.ts`: the 20 tools as Pi declares them. It also checks the snapshot
  against the installed Claude Code's `tools/list`; when that fails, refresh
  `claude-tools.json`.
- `liveview.test.ts`: the pump's rate and CPU budget, unchanged frames skipped,
  sizing, and the Kitty uploads, deletes and text fallback.
