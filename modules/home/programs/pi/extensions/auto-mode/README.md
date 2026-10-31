# auto-mode

Claude Code's auto permission mode (`permissions.defaultMode: "auto"`) for Pi.
Pi runs every tool call without asking. With this extension, plainly safe calls
still run directly, and every other call is first judged by a classifier model
(Claude Sonnet 5, through the Claude subscription) that reads the conversation
and the call against Claude Code's own security rules. A risky call is blocked
and the model is told why. After 3 blocks in a row, or 20 in a session, you are
asked instead.

The footer shows `auto mode` (`auto mode: checking` while the classifier
runs, `auto mode off` when off). `/auto-mode` toggles it, `/auto-mode on|off`
sets it. It starts on. A call the classifier allowed ends its row with
`Allowed by auto mode`, beside bash's `Took 0.1s`.

[SPEC.md](SPEC.md) is what Claude Code 2.1.314 does, read from its bundled
JavaScript (Claude Code is not open source). `prompts/system.md` and
`prompts/permissions.md` are its classifier prompts, verbatim.

## Setup

Wire the directory in like the other extensions:
`".pi/agent/extensions/auto-mode".source = ./extensions/auto-mode;`.
It needs the `claude-code` provider (pi-claude-code) with `claude-sonnet-5`;
it never uses another provider.

Optional, in Pi's own `settings.json` (`~/.pi/agent/settings.json`, not a
project's, as Claude Code reads these only from user, flag and managed
settings):

```json
{
  "autoMode": {
    "environment": ["$defaults", "Trusted repo: github.com/arthur-fontaine/*"],
    "allow": ["$defaults", "Running `nix flake check` in this repo"],
    "soft_deny": [],
    "hard_deny": []
  }
}
```

A list replaces Claude Code's default rules for that category; `"$defaults"`
keeps them in place. Absent or empty keeps the defaults.

Environment: `CLAUDE_CODE_AUTO_MODE_MODEL` picks another `claude-code` model
(same variable as Claude Code); `PI_AUTO_MODE_DEBUG=/path/file.jsonl` logs
every fast path and verdict (stage, severity, timing, raw API error).

## Features: Claude Code → Pi

"Verbatim" means copied from the bundle; "read" means the logic was read in
the bundle and reimplemented; "inferred" means reconstructed without seeing
every piece.

| Claude Code | Pi | Exact? |
|---|---|---|
| Classifier system prompt (`Q1r`) with the permissions template (`permissions_external.txt.zst`) | `prompts/system.md`, `prompts/permissions.md`, assembled by `prompt.ts` | Verbatim. `system.md` has its build-time `${…}` resolved for this build (host-context bullet, the pasted-content sentence of rule 9 since flag `tengu_virtual_pancake` is on). |
| `<cross_session_messages_rule>` (Slack, email, projects relays) | Empty | Exact for a plain CLI session, which is what Claude Code serves here too. |
| User rules in four slots, `$defaults` splice (`zhr`, `Gg`) | `autoMode` in Pi's agent-dir settings | Read. Same semantics; project settings ignored like Claude Code's. |
| `permissions.deny` → "User Deny Rules" sentence | Not filled | Pi has no permission rules. |
| "Unrequested Artifact Publish" line removed (flag `tengu_umber_sluice`) | Removed, with Claude Code's partial-strip floors | Read. |
| Severity output for Sonnet 5 (`Lkr`), thresholds t1 25 / t2 35 (`severityByModel`) | Same; `<block>` format for models without thresholds | Read (thresholds from the cached server config). |
| Session Context: user identity from `$GITHUB_ACTOR`/`$USER`/`$USERNAME`/git email | Env only | Inferred-equivalent: the git-email fallback is skipped (`$USER` is always set on macOS). |
| CLAUDE.md as a leading user message, with its verbatim framing | Pi's context files (`AGENTS.md`/`CLAUDE.md` it loads), as `Contents of PATH:\n\nTEXT` | Not exact: Claude Code's own memory text and per-file labels differ. |
| Transcript: user turns indented and tag-defanged, tool calls as `{"Tool": input}`, read-only lookups and prose omitted, AskUserQuestion answers, compaction summary label | `transcript.ts`, from Pi's compaction-aware context (`buildContextEntries`) | Read. Pi tool names are shown as Claude Code's (`bash`→`Bash`, `edit`→`Edit`, `write`→`Write`, `find`→`Glob`, `ask_user_question`→`AskUserQuestion`, …) because the rules are written about those. |
| `toAutoClassifierInput` per tool | Bash: command; Write: `path: content`; Edit: `{file_path, adds, removes, removesTruncated}` (3000-char cap); others: the input | Read. Pi's multi-edit `edit` with several edits becomes `{file_path, edits: [...]}`: Claude Code has no exact equivalent. |
| Same-turn earlier calls as context | Earlier calls of the same response are in the history | Read. |
| `{"meta":{"gitStatus":…}}` above `git reset --hard`, `git checkout .`, `git restore .`, `git clean -f`, `rm -r/-f` | Same line, from `git status --porcelain` | Command detection is a regex approximation of Claude Code's parser. |
| `{"meta":{"repoVisibility":…}}`, Chrome navigation lines, outcome lines (off), forwarded turns, host context | Not ported | Need GitHub lookups or Claude-Code-only surfaces. |
| Two stages: stage 1 64 tokens with `</severity>` stop, stage 2 8192 tokens; suffixes verbatim; exact-format rule for a stage-1 allow; stage 2 decides otherwise | `classifier.ts` | Read. pi-claude-code cannot send stop sequences or a temperature, so stage 1 relies on the model stopping (it does: "No other text"); temperature is the API default 1, which is Claude Code's value anyway. |
| API thinking off (`thinking: false`), +2048 tokens only for models that refuse that | Off; when the API refuses "disabled" (Sonnet 5 does today), low-effort adaptive thinking + 2048 tokens, learned once per process (so the first check after each Pi start costs one refused request) | Not exact: pi-claude-code can send `disabled` or adaptive thinking, not the `between_tools` mode the API now asks for. The verdict is read from the text only, as before. |
| Parsing: thinking stripped, exactly one `<severity>N`, known `<category>` → `[Rule Name]` | Same | Read; rule names come from the template like Claude Code's `F_r`. |
| Retries: 4 on transient errors, 4 re-asks on unparseable, no outer retry or fallback model; stage-1 timeout 60 s + 10 s per 50k tokens over 50k (≤ 120 s), stage 2 120 s | Same | Read; the SDK's backoff is approximated (0.5 s doubling, ≤ 8 s). |
| Fail closed: unavailable → denied with retry guidance; unparseable → denied (counts); refusal → denied (does not count); stage-2 error after stage 1 → blocked on stage 1 (counts) | Same, messages verbatim | Read. Errors are recognised from pi-claude-code's error text, not HTTP objects, so the "(rate-limited)"-style hints are best effort and the `retry-after` variant is not used. |
| Transcript too long → the normal prompt (interactive), abort (headless) | `ctx.ui.confirm` / `block` + `terminate` | Read. The gated "compact then retry" variant is not ported. |
| The prompt in the Claude apps over Remote Control: Claude Code's permission sheet, with the reason as `decision_reason` | remote-control's dialog contract; the first answer wins, a stopped turn dismisses both | Read (remote-control/README.md). Claude Code 2.1.314 keeps its newer timed denial-limit dialog at the terminal; Pi sends every one, like its older prompt. |
| Denial limits 3 consecutive / 20 total → prompt with "N consecutive actions were blocked…" + latest reason; allow resets consecutive, the total limit resets both; headless aborts | `denials.ts`, `ctx.ui.confirm`; headless: `block` + `terminate` | Read. |
| Model-facing messages (blocked, unavailable, parse failure, refusal, user rejection) | `messages.ts` | Verbatim. The optional "add a permission rule for TOOL" sentence is left out (no rules in Pi). |
| Checks run one at a time per agent | One queue per session | Read. |
| Fast path: safe allowlist (Read, Grep, Glob, LSP, ToolSearch, MCP resource listing, Todo/Task/plan tools) | `read`, `grep`, `find`, `ls`, `tool_search` | Read. Pi extension tools that are only lookups (todo lists, goals) still go to the classifier: they are not known here. |
| Fast path: acceptEdits simulation — edits inside the working directory except protected paths; Bash `mkdir touch rm rmdir mv cp sed` with targets inside it | `fastpath.ts`: same protected list plus `.pi`; symlinks resolved; the Bash lexer refuses expansions, substitutions, subshells, heredocs, globs on file commands and any redirect; `sed` only for plain `s///` scripts | Approximation: Claude Code uses a tree-sitter bash parser and its full path validator. Anything this lexer cannot see through goes to the classifier, never the other way. |
| Bash's own read-only check (runs before auto mode: `ls`, `cat`, `git status`, …) | A short list of read-only commands and git subcommands, no output redirects except to `/dev/null` | Approximation of a much larger validator; again conservative (unknown → classifier). This is the biggest behavioural difference: some read-only commands Claude Code runs directly cost a classifier call here. |
| `requiresUserInteraction` tools (AskUserQuestion) never classified | `ask_user_question` runs directly | Read. |
| Calls made from a script (Workflow) | Pi `codemode` is classified on its input like any tool; each tool call its script makes is checked again (fast paths, then the classifier with the script call as the last history entry) | Not exact: Claude Code's script calls are handled by its server-side classifier path. Checking each nested call is the fail-safe choice and costs more calls. |
| Permission rules (`allow`/`deny`/`ask`), plan mode, safety checks with `classifierApprovable: false`, sandbox, server-side classifier, Slack/email/projects, Chrome/computer use, sub-agent hand-back review, telemetry | Not ported | No Pi counterpart, or outside a local CLI session (SPEC.md §6). |
| "Checking" notice after 4 s | Footer `auto mode: checking` at once | Simplified. |
| Dim `Allowed by auto mode` line under a successful result the classifier allowed (not fast paths, not a person's answer, not errors, not `Agent`; the no-relevant-input allow included) | Same calls (`render.ts`, `note.ts`): the verdict is kept per call id and as `details.autoMode` on the result; any renderer chain (Pi's, bash-changes, syntax-highlighting, background-tools, image-view) is wrapped and the note goes on bash's `Took Xs` line, two spaces after it, else as the last line after a blank one | Not exact: Claude Code puts it on its own line and forgets it on resume; here it stays on resume because Pi has no separate note line to keep it beside. `details` never reaches the model. A tool registered without a result renderer (some extension tools; not bash, read, edit, write or MCP tools, which have one) gets no note: Pi draws those results with its own fallback, which it doesn't export, and adding a renderer would replace it for every call. |
| Opt-in dialog (`skipAutoPermissionPrompt`) | None: loading the extension is the opt-in | — |

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly; no Pi or network needed
```

They cover prompt assembly (slots, `$defaults`, severity rewrite, artifact
strip, rule names), transcript lines (escaping, projections, history cut at
the call, nested calls, summaries, answers), the two-stage decision table with
a scripted model (retries, refusals, timeouts, stage-2 failures, block
format), the fast paths (allowlist, protected paths, symlinks, lexer, read-only
and file commands), the denial counters, and the row note (details merge,
placement beside `Took`, below it when too narrow, last line otherwise, which
definitions are left as they are).

Checked end to end in a scratch Pi 1.4.0 with pi-claude-code: an
`echo > file` allowed by stage 1 (severity 2) and an upload of a missing file
to a `.invalid` host escalated to stage 2 and allowed there (severity 12,
the user had asked for it); the footer and `/auto-mode off` in the TUI.
A live block was not provoked (it needs a harmful-looking action); the block
path is covered by the tests.

The row note was checked in a scratch Pi 1.4.0 TUI with the classifier
replaced by a scripted `claude-code` provider: on allowed bash and write rows,
not on a blocked one, after a resume, for a call detached with Ctrl+B, and with
auto-mode loaded both before and after bash-changes, syntax-highlighting and
background-tools; on a tool with its own result renderer but not on one
without, whose rows came out byte for byte as without auto-mode.
