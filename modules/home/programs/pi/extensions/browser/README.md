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
  tool's; a call it lets through has the extension's site prompt answered "allow"
  (see [Permissions](#permissions)).
- **Live view.** While a tool acts on a tab, the tab is screenshotted at up to
  3 fps (fewer when screenshots are slow: at most half the time is spent
  capturing), and the frame is drawn across the row with Kitty Unicode
  placeholders (image-view's `kitty.ts`). An unchanged screen is not redrawn.
  When the tool ends, one more screenshot is kept as a still, saved under
  `$TMPDIR/pi-browser-frames/` so a resumed session shows it too. Without Kitty
  graphics, the row gets a line of text instead, and no screenshots are taken.
- **Each session its own tabs.** Calls carry `session_scope: {sessionId}` (Pi's
  session id), so each Pi session gets its own tab group, as Claude Code sessions do.

## The protocol

Claude Code installs a native messaging host for the extension
(`com.anthropic.claude_code_browser_extension`, `~/.claude/chrome/chrome-native-host`
→ `claude --chrome-native-host`). The browser starts it when the extension
connects. It relays between the extension (stdin/stdout, Chrome native messaging)
and a Unix socket that Claude Code (and this extension) dial.

**Socket.** `/tmp/claude-mcp-browser-bridge-<user>/<host pid>.sock`. The folder
is 0700 and the socket 0600, both the user's. Claude Code refuses anything else,
and so does `findSockets`. One host runs per browser profile with the extension.
A socket whose pid is gone is stale. Claude Code lists the folder and dials each socket.

**Framing.** Both ways, and on the native messaging side too: a 4-byte
little-endian length, then that many bytes of UTF-8 JSON. The host drops a
client that sends a length of 0 or one past its maximum.

**Client → host.**

```json
{"method": "execute_tool", "params": {
  "client_id": "claude-code",
  "tool": "navigate",
  "args": {"url": "http://127.0.0.1:8917/", "tabId": 373894482},
  "tool_use_id": "53b6ba83-…",
  "session_scope": {"sessionId": "<session id>", "tabGroupId": 721964087},
  "permission_mode": "ask",
  "handle_permission_prompts": true
}}
```

The host wraps it as `{"type": "tool_request", "method", "params"}` for the
extension. The last three params are optional:
- `session_scope`: a tab group per session.
- `permission_mode`: one of `ask`, `skip_all_permission_checks`, `follow_a_plan`.
- `handle_permission_prompts`: the client answers the site prompts itself.

`{"method": "permission_response", "params": {"request_id", "allowed"}}`
answers a prompt.

**Host → client.** The extension's `tool_response` and `notification` messages
lose their `type` and go to **every** connected client:

- a response: `{"tool_use_id", "result": {"content": [...]}}`, or
  `{"tool_use_id", "error": {"content": "..."}}`. Content is MCP's: text blocks,
  and image blocks for screenshots.
- a notification: `{"method", "params"}`, for example
  `{"method": "permission_request", "params": {"request_id", "tool_use_id", "tool_type", "url", …}}`.

The host also sends `mcp_connected` / `mcp_disconnected` to the extension when
a client comes or goes, and answers the extension's `ping` (`pong`) and
`get_status` (`status_response` with its version and the computer's name) itself.

**Ids.** The host keeps no call table: replies are routed by `tool_use_id`, a UUID
per call, and a client ignores the others. That is what lets Claude Code's own
`--chrome`, several Pi sessions and anything else share one host. Claude Code
keeps one call in flight per connection. This client keeps a map, so calls may
overlap; the live view's screenshots run beside the agent's call.

**Not used here.** Claude Code can also pair with the extension over the socket
(`local_pairing`: an ES256 assertion from claude.ai, ECDH, then AES-GCM-sealed
frames), and can reach browsers on other computers through
`wss://bridge.claudeusercontent.com`. The extension still accepts the clear-text
frames above from a local client, so neither is needed for the browser on this Mac.
`switch_browser`, `list_connected_browsers` and `select_browser` are answered
here from the local host sockets.

## Permissions

The extension asks before acting on a site. A call with no `permission_mode`
and no prompt handler is refused at once ("Permission denied by user").

Claude Code has two cases:
- **Bypass-permissions mode** (`--dangerously-skip-permissions`): it sends
  `permission_mode: "skip_all_permission_checks"` (through
  `CLAUDE_CHROME_PERMISSION_MODE` to its MCP server).
- **Otherwise:** it sets `handle_permission_prompts` and answers each
  `permission_request` through its own permission flow.

Pi's permission flow is auto-mode, which has already classified the call, so
`index.ts` answers `allowed: true` for the call that raised the prompt. Prompts
for other clients' calls are left to them.

## Browser closed

With no live host socket, a call fails with a clear message: open Some Browser
(its extension starts the host) and retry. A host that goes away mid-call fails
the call with "connection closed". The next call dials again, so a browser
restart needs nothing else.

## Files

- `protocol.ts`: framing, request building, socket discovery and checks.
- `client.ts`: the socket client: calls by id, permission prompts, notifications.
- `calls.ts`: what Claude Code does around a call:
  - `navigate` without a `tabId` makes or finds the session's tab;
  - `file_upload` reads `paths` into `files`;
  - `save_to_disk` keeps the screenshot in a file;
  - the three browser-choice tools are answered here;
  - results become Pi content.
- `tools.ts`: the tool definitions from `claude-tools.json`.
- `liveview.ts`: the frame pump and the Kitty view.
- `index.ts`: the Pi wiring.

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly
```

- `protocol.test.ts`: framing (cut at any byte), requests, a fake host relaying
  to two clients, a permission prompt answered, no socket.
- `tools.test.ts`: the 20 tools as Pi declares them. It also checks the snapshot
  against the installed Claude Code's `tools/list`; when that fails, refresh
  `claude-tools.json`.
- `liveview.test.ts`: the pump's rate and CPU budget, unchanged frames skipped,
  sizing, and the Kitty uploads, deletes and text fallback.
