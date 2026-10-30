# rewind for Pi

Claude Code's `/rewind`: go back to before one of your prompts, for the code,
the conversation or both, or summarize part of the conversation. The screens,
wording and options are Claude Code 2.1.314's; [SPEC.md](SPEC.md) describes
the original, read from its bundle. `/restore` is this port's own: the redo
of rewound prompts.

```
Rewind

Restore the code and/or conversation to the point before…

  write a
  a.txt +1 -1

  bash b
  2 files changed +3 -1

❯ (current)

Enter to continue · Esc to cancel
```

```
Rewind

Confirm you want to restore to the point before you sent this message:

│ bash b
│ (11s ago)

This message and everything after it will be removed.
The code will be restored +1 -3 in a.txt and b.txt.

❯ 1. Restore code and conversation
  2. Restore conversation
  3. Restore code
  4. Summarize from here
↓ 5. Summarize up to here

⚠ Restored files go back whole, losing later changes by anyone. Bash changes outside the git repository are not undone.
```

## Use

- `/rewind`, or **Esc twice** (within 800 ms) on an empty prompt while the
  agent is idle. Pick a prompt, then an option (Enter, or its digit). Esc on
  the confirmation goes back to the picker; Esc on the picker closes it.
- `/restore` brings back prompts that a rewind removed, up to a chosen one:
  the mirror of Rewind's screens, "(current)" first, then the rewound prompts
  with their code changes, then "Confirm you want to restore to the point
  after this message:" and "Restore code and conversation" / "Restore
  conversation" / "Restore code" / "Never mind", offered under the same
  conditions as Rewind's.

### Rewind (undo prompts)

| Option | In Pi |
| --- | --- |
| Restore conversation | `navigateTree` to the prompt: the leaf moves to its parent, and Pi puts the prompt back in the editor (when it is empty). The abandoned branch stays in Pi's session tree. |
| Restore code | Every file changed after the prompt goes back to its content before its first change after it, or is deleted if it didn't exist then. |
| Restore code and conversation | The code, then the conversation, as Claude Code. |
| Summarize from here | The prompt and everything after it are summarized by the session's model with Claude Code's request, then `navigateTree` to the prompt with that summary (a `session_before_tree` handler supplies it): Pi records it as a branch summary at the prompt's parent, the earlier messages stay, and the prompt goes back in the editor. |
| Summarize up to here | `ctx.compact()` with a `session_before_compact` handler that summarizes the messages before the prompt with Claude Code's request and returns a compaction keeping the prompt and what follows (`firstKeptEntryId` = the prompt). You stay at the end. |
| Never mind | Back to the picker. |

Both summaries use the session's current model (`ctx.model` through
`ctx.modelRegistry.streamSimple`), and the optional "add context" text goes in
as `User context: …`, as in Claude Code.

### Restore (redo prompts)

Every rewind and restore is recorded in this extension's store with the leaf
it left, the leaf it went to and, for each file it rewrote, the content before
and after. `/restore` lists the prompts on the branches that rewinds left
(several branches are headed "rewound 5m ago"), and the prompts whose code
alone was rewound.

- **Conversation**: `navigateTree` to the last entry of the chosen prompt's
  turn on the kept branch. If you sent other prompts since, that is a branch
  switch, and those prompts become restorable in turn. The prompt the rewind
  left in the editor is cleared when it comes back.
- **Code**: files changed on the current branch since the branch point go back
  to their content there, and files changed on the kept branch up to the
  chosen prompt take their content after its turn (from the store, or
  bash-changes' after-trees, or what the rewind found in them when it left the
  branch). Nothing else is touched.
- If a file was edited since the rewind wrote it, the confirmation says so:
  "⚠ Edited since the rewind: a.txt. Restoring overwrites these edits."
- A rewind followed by a restore of the last rewound prompt leaves the code
  and the conversation (the same leaf) where they were.

## Where the code comes from

Nothing is snapshotted twice:

- **bash** calls: bash-changes already records the repository root, the
  before/after git trees and the changed files of each call
  (`details.fileChanges`, or a `bash-changes` session entry for calls
  detached to the background). Rewind reads a file out of the before tree
  (`git ls-tree` + `git cat-file`), Restore out of the after tree. Those
  trees are unreachable objects that `git gc` prunes in time; a file whose
  tree is gone is named ("⚠ Can't restore b.txt: the earlier content is
  gone…") and the others are still restored.
- **edit** and **write**: before a file's first change after each prompt, its
  content is backed up (as Claude Code's file history), and after every call
  its new content too (for Restore). Nested calls (codemode) count with the
  calling tool.
- **Subagents** (sessions that run inside this Pi with no UI and a
  `parentSession`): their edit/write backups, and their bash changes when
  bash-changes runs in them, go into the parent session's store, under the
  parent's current prompt and the tool call that runs the subagent. They are
  restored with that prompt, as Claude Code's subagent edits are part of the
  turn. The subagent itself keeps no store and no Rewind.
- The rewinds and restores themselves, with what they wrote.

The store is `<agent dir>/rewind/<session id>/`: content-addressed blobs,
`backups.jsonl` and `records.jsonl`. Nothing is written into your
repository: no refs, no HEAD, no index, no stash. Stores whose session file
is gone are pruned when a session starts (after a day's grace, since Pi
writes a new session's file late). An unsaved session's store lives in the
temp directory and is removed when it ends.

## Settings

Pi's own double-Escape opens `/tree` by default. Rewind takes the second
press itself, so `/tree` never opens from it, but set Pi's off to be safe:

```json
{ "doubleEscapeAction": "none" }
```

## What is exact, and what isn't

- Screens: Claude Code's strings, layout (title in the accent color, dim
  hints, "❯" pointer, ↑/↓ markers, 5 options at most, digits pick), keys and
  conditions. Colors are the Pi theme's tokens (`accent`, `dim`, `muted`,
  `success`/`error` for `+N`/`-N`, `warning`), so light and dark themes both
  work.
- The warning is adapted: Claude Code says "Bash changes to other files are
  not undone" because it only tracks files Edit/Write touched; here bash's
  changes inside the git repository of Pi's working directory are restored
  too, so it says "Bash changes outside the git repository are not undone"
  (outside a repository: "Bash changes are not undone outside a git
  repository").
- Every user message on the branch is listed, including ones before a
  compaction (rewinding there brings the full history back); Claude Code
  only lists the messages still in its transcript. Its `/resume … (previous
  session)` row, the `/name args`, `Skill(name)` and `! cmd` row formats, and
  restoring pasted images and the permission mode have no Pi counterpart.
- A picker row counts its turn from the content before the turn to the
  content after it (not to the file on disk for the last turn); a turn with
  edits made before the extension was installed shows "⚠ No code restore".
- Files are rewritten in place (keeping their inode) and symlinks are
  recreated; Claude Code refuses symlinks, hard links and moved directories.
- **Summaries**: Claude Code forks the conversation and appends its request;
  Pi has no fork, so the summarized messages go to the model as text (Pi's
  `serializeConversation`) followed by Claude Code's request, with Pi's
  summarization system prompt. "Summarize from here" sends only the messages
  it summarizes. The summary is stored as Pi's branch summary or compaction
  entry (Pi wraps them in its own `<summary>` text in the context), not as
  Claude Code's "This session is being continued…" user message.
- **Summarize up to here** goes through Pi's compaction, which refuses a
  session whose context fits in `compaction.keepRecentTokens` (20k tokens by
  default): Pi then reports "Compaction failed: Nothing to compact (session
  too small)" and nothing changes. Pi's compaction indicator (Escape cancels)
  shows while it runs, instead of "Summarizing…" in the dialog.
- Esc+Esc: the hook wraps the editor's `onEscape` (installed after
  input-autocomplete's editor, at session start and after `/tree`), so an
  Escape that closes the slash/@ popup or a Pi dialog never counts. An
  Escape that clears input-autocomplete's ghost suggestion doesn't count
  either (Claude Code has no such suggestion to compare). An extension that
  installs another editor later replaces the hook until the next session
  start.
- `/restore` only knows rewinds made by this extension; branches left with
  Pi's `/tree` are not listed.
- Bash changes outside the repository of Pi's working directory, calls made
  inside codemode scripts, and edits made before the extension was installed
  can't be restored (the last are named in the confirmation). Backups follow
  the session id: a `/fork` into a new session file doesn't carry them.
- With several subagents running at once, a subagent's changes are filed
  under the first running subagent call; it only matters for the order
  within that turn.

## Files

- `index.ts`: loads the extension with Pi's editor, serializer and TUI helpers
- `extension.ts`: the event handlers, backups, commands, summaries and Esc+Esc
- `escape.ts`: the double press and the editor hook
- `listing.ts`: the listed prompts, labels, ages, row stats and options
- `plan.ts`: the changes along a path and each file's content at a point
- `restore.ts`: reading, comparing and writing files
- `store.ts`: the per-session store
- `git.ts`: reading files out of bash-changes' trees
- `diff.ts`: line counts
- `text.ts`: every string and the summary requests
- `view.ts`: the picker and the confirmation

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly; no Pi needed
```

The pure parts (listing, time-ago, row summaries, options, prompts, double
press, ghost detection, line counts, store, git reads, pruning) and the
commands against a stand-in Pi on real files and a real git repository:
rewinding then restoring round-trips the files and the leaf, a partial
restore, a branch switch, the "edited since" warning, code-only rewind and
restore, Never mind, a pruned snapshot, both summaries, and a subagent's
edits filed with the parent's prompt.

Checked by hand in Pi 1.4.0's TUI (through a pty) with a scripted model
making real write, bash and edit calls, bash-changes and input-autocomplete
loaded: Esc+Esc (not on a draft, not on one Escape; with Pi's
`doubleEscapeAction` at its default, only Rewind opens), both confirmation
variants, each Rewind option (code and conversation, conversation, code,
both summaries, with and without context, Never mind), Esc back to the
picker, digits; `/restore` of a full rewind, of a code-only rewind, and as a
branch switch after a new prompt (which then lists the abandoned prompt);
the files after each step; the dark and light themes.
