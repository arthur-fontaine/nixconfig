# bash-changes for Pi

Records which files a `bash` call changed, so edits made by `sed -i`,
formatters, code generators or scripts show up like the edit and write tools'
changes: a summary and a diff under the call.

```
$ sed -i '' 's/one = 1/one = 100/' a.ts && printf 'hello\nworld\n' > notes.txt

 finished

✎ a.ts, notes.txt  +3 −1
a.ts  +1 −1
-1 export const one = 1;
+1 export const one = 100;
 2 export const two = 2;
notes.txt  new  +2
+1 hello
+2 world
```

## How it works

Around each `bash` call it snapshots the working tree of the git repository
that contains Pi's working directory, before and after:

1. copy an index to a temp file;
2. `git add -A` and `git write-tree` against that copy (`GIT_INDEX_FILE`);
3. compare the two trees with `git diff-tree`.

The copy starts from the repository's previous snapshot index while the real
index is unchanged (same mtime, size and inode), otherwise from the real index.
The previous snapshot already has the stat data of the untracked files, so
unchanged ones are not hashed again on every call; untracked files that did
change are hashed and stored as new blobs. The real index, the stash and the
refs are never touched. Untracked files are included and ignored files are
excluded. The blobs and trees it writes are ordinary loose objects, which
`git gc` prunes once they are unreachable. Outside a git repository nothing is
recorded.

When the trees differ, `details.fileChanges` is added to the tool result, for
successful and failed results alike:

```ts
{
  root: string;      // repository root
  before: string;    // tree id before the call
  after: string;     // tree id after it
  files: { path: string; status: "A" | "D" | "M" | "T"; added?: number; removed?: number }[];
  patch: string;     // unified diff, at most 200 KiB
  patchTruncated?: true;
  overlapping?: true; // other tools ran during the call
}
```

The model sees the same content as before. While the objects exist, any
recorded file can be restored with `git checkout <before> -- <path>`.

The before snapshot is taken in a `tool_call` handler and the after snapshot
in a `tool_result` handler, so it works with whichever extension provides the
`bash` tool (background-tools overrides it) and never registers `bash` itself.
Windows are kept by tool call id until the result comes, however late.

### Calls in the background

When background-tools detaches a call (Ctrl+B, or `background: true`), Pi
gets a placeholder result (`details.background`) and runs `tool_result` on
it, never on the final result. So the window stays open past the placeholder
and closes on background-tools' `end` event (`pi.events`, channel
`background-tools`), when the command has really finished. The changes then
can't go into the result's details: they are saved as a `bash-changes`
session entry, `{ toolCallId, fileChanges }`, and the row is repainted with
them. Resumed sessions read these entries from their branch.

## Display

A tool renderer for `bash` (`pi.registerToolRenderer`) chains onto the
renderer it replaces (`next()`): Pi's bash renderer, or another extension's,
draws the call and its output, and the changes come below the output. The
inner renderer always gets back its own component as `lastComponent`, so
renderers that reuse it keep working.

- A summary line: `✎`, the changed file names (two at most, then a count),
  the line totals, the status of a single file (`new`, `deleted`, `type
  changed`, `binary`) and `overlapping` when other tools ran meanwhile.
- Each file's header (path, status, `+added −removed`), then its hunks in the
  edit tool's format (`-12 old`, `+12 new`, ` 12 context`) and colors
  (`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`). Added lines are
  syntax highlighted with Pi's `highlightCode`, for the language
  `getLanguageFromPath` gives, highlighting each hunk's new side as one block.
  Later hunks are separated by `...` and git's enclosing-function context.
- Collapsed: the first 3 files show their first 10 diff lines, the first 6
  files are listed, the rest are counted, and a hint names the expand key.
  Expanded (`ctrl+o`): every file and every line.

Colors come from the current Pi theme, so they follow theme changes. Results
stored in a session keep their changes, so resumed sessions show them too.

## Settings

In `settings.json`:

```json
{
  "bashChanges": {
    "detect": true,
    "openFiles": 3,
    "newFilesOpen": false,
    "previewLines": 10,
    "listFiles": 6
  }
}
```

| Key | Meaning |
| --- | --- |
| `detect` | Snapshot around bash calls. Off, nothing is recorded (stored changes still show). |
| `openFiles` | Files whose diff is previewed while collapsed. |
| `newFilesOpen` | Also preview new files past `openFiles`. |
| `previewLines` | Diff lines previewed per file while collapsed. |
| `listFiles` | Files listed while collapsed; the rest are counted. |

They are read when a session starts.

## Features and how they map

The original is the pi-harness plugin `pi-bash-changes`, built on the
harness's tool decorators and feed.

| pi-harness plugin | Pi extension |
| --- | --- |
| A `bash` execution decorator snapshots before and after | `tool_call` (before) and `tool_result` (after) handlers; `bash` is not re-registered. |
| Temp index copy, `git add -A` + `git write-tree` via `GIT_INDEX_FILE`, `git diff-tree` | Same. |
| Previous snapshot index reused while the real index is unchanged | Same; "unchanged" is the same mtime, size and inode. |
| Real index, stash and refs untouched; untracked included, ignored excluded; nothing outside a repository | Same. |
| `details.fileChanges` with root, both trees, files with status and line counts, patch capped at 200 KB | Same fields. The cap is 200 KiB, cut on a line boundary, with `patchTruncated`. |
| Added to successful and failed results; model-facing content unchanged | Same. The handler returns only `details`, spreading the details already there. Details that aren't an object are left alone. |
| Thrown failures, abort and timeout normalized to error results that carry the changes | Pi already turns a thrown `execute()` into an error result and runs `tool_result` on it, so these carry the changes too. |
| Direct and Ctrl+B-detached executions carry the same evidence | Direct calls: in `details.fileChanges`. Detached calls (background-tools): the window stays open until background-tools' `end` event, and the changes go into a `bash-changes` session entry, since the final result never passes through `tool_result`. Both show the same way. |
| `overlapping` when another tool ran during the window | Same, from `tool_execution_start`/`tool_execution_end` of any tool. |
| Tree ids allow `git checkout <before> -- <path>` | Same. |
| Git-quoted paths (UTF-8 octal bytes, quotes, backslashes, control characters) keep their own hunks, `core.quotePath` on or off | Same. A type change's two diff sections stay under its one path. |
| Feed row `✎ a.ts +3 −1 new …  <first command line>`, `✎` as the status mark | The call row stays Pi's (or the highlighter's); the same summary opens the changes block under the output. A failure shows as Pi's error styling of the call. |
| Result: output (last 12 lines), then the files | Pi's bash renderer shows the output (last 5 lines collapsed, all expanded), then the changes. |
| Clickable `▾ path M +3 −1` headers over hunks with line numbers, syntax-highlighted added and removed lines, `┄` + function context between hunks | Headers aren't clickable; `ctrl+o` expands all. Hunks use the edit tool's format; added lines are highlighted, removed and context lines use the diff colors. `...` + function context between hunks. |
| First three files open, past six the rest fold behind `+N more files` | Collapsed: 3 files previewed, 6 listed, the rest counted. Expanded: everything. |
| `▸ script · N lines · exit 0` line revealing the full highlighted command | Dropped: Pi's call row already shows the whole command, and the output its exit code. |
| Settings page (detect, row leads with change or command, files open, new files open, fold over, output folded/shown and its lines, script folded/shown) | `bashChanges` in `settings.json`: `detect`, `openFiles`, `newFilesOpen`, `listFiles`, plus `previewLines`. The row, output and script options are dropped: those parts are drawn by Pi's bash renderer. |

### Not exact

- Calls made by other tools (codemode scripts, `ctx.executeTool`) are not
  snapshotted: their results never reach the transcript, so there is nowhere
  to show the changes.
- Changes are attributed to the window between the two snapshots, not to the
  process: edits from your editor, other Pi processes or tools running at the
  same time land in it (`overlapping` flags the last). Edits outside the
  repository, like in `/tmp`, are not recorded. Changes inside a submodule
  only show as its commit moving.
- The before snapshot runs inside `tool_call`, in extension load order. Pi
  stops at the first handler that blocks, so an extension that blocks or asks
  for approval (auto-mode) should load before this one: then a blocked call
  is never snapshotted and the wait for approval stays outside the window. If
  it loads after, the snapshot of a call it blocks is discarded at
  `tool_execution_end`.
- `git add -A` runs the repository's clean filters (git-lfs, for one) on
  changed files, and in a huge untracked tree the first snapshot takes a
  while.
- No intra-line (word) highlighting of changed lines, which the edit tool's
  own diff has.
- HTML exports (`/export`) draw `bash` with Pi's own template, not with tool
  renderers, so they don't show the changes.
- A call in the background keeps its window open until it ends, so whatever
  the model does meanwhile is included and flagged `overlapping`.

## Remote Control

`details.fileChanges` rides along with the tool result; the Remote Control
extension needs nothing for it. A detached call's changes live in their
session entry and are only shown in the terminal.

## Files

- `index.ts`: loads the extension with Pi's `highlightCode`, `getLanguageFromPath`, `keyHint` and `wrapTextWithAnsi`
- `extension.ts`: the event handlers, settings and the renderer chaining
- `snapshot.ts`: the git snapshots and the diff
- `patch.ts`: splits the patch into files and hunks
- `render.ts`: the summary, file headers and diff lines

## Tests

```sh
node --test 'tests/*.test.ts'   # Node 24 runs the TypeScript directly; no Pi needed
```

They snapshot temporary git repositories (with the user's and the system's
git config shut out) and check the result, the untouched real index, refs and
stash, the warm index, type changes, binary and mode changes, the patch cap and
awkward paths. The renderer and the event wiring (blocked calls, late and
detached results, resumed sessions) run against a stand-in theme and a
stand-in `pi`.

Checked by hand in Pi 1.4.0's TUI with claude-haiku-4.5: a `sed -i` plus a new
file, collapsed and expanded; a resumed session with `previewLines` and
`listFiles` lowered; another renderer wrapping `bash`, loaded before and after
this one; and a `background: true` call under background-tools, whose changes
appear when it ends.
