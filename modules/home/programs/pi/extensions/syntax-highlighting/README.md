# Syntax highlighting for Pi

A port of the pi-harness plugin `pi-syntax-highlighting`. It colors the
`bash` tool's rows: the command in its own syntax, the code it embeds
(`python -c '…'`, a heredoc fed to `node`, a SQL query for `psql`), and the
parts of the output worth spotting (errors, exit codes, HTTP statuses,
diffs, JSON).

```
$ cd src && python3 -c 'import json; print(json.dumps(x))' | jq .
  └ cd, python3, jq: command names · -c: option · the program: Python
2026-05-01T10:00:00Z [api] ERROR: boom      dim time, red level
GET /health HTTP/1.1 500                    accent method, red status
Command exited with code 2                  red code
```

## Colors follow the theme

Every color is a Pi theme token, so with `theme: "light/dark"` the rows
switch with the terminal's appearance like the rest of the UI, and a custom
theme recolors them too:

| What | Token |
| --- | --- |
| Command names, keywords, options, strings, variables, operators, comments, numbers | `syntaxFunction`, `syntaxKeyword`, `syntaxType`, `syntaxString`, `syntaxVariable`, `syntaxOperator`, `syntaxComment`, `syntaxNumber` |
| Other words of a command | `toolTitle`, as Pi draws commands; the `$` in `bashMode` |
| Embedded code, JSON output, code in diff context lines | Pi's own `highlightCode` (highlight.js with the theme's `syntax*` tokens) |
| Output text | `toolOutput`; highlights in `error`, `warning`, `success`, `accent`, `dim` |
| Diff lines | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`; hunk headers `accent` |

Rendered rows are cached per theme, so a switch redraws them in the new
colors. No fixed palette and no Shiki theme are involved.

## How it fits with other extensions

It never registers or replaces the `bash` tool, and it doesn't draw the row
itself. Through `pi.registerToolRenderer` it wraps whatever `next()` returns
(Pi's renderer, or another extension's that wraps Pi's) and recolors the
lines that renderer drew:

- In the call, it finds the command where the renderer printed it and
  recolors just that, leaving prompts, the `(timeout 30s)` suffix and
  anything another extension added.
- In the result, it recolors only lines drawn in the plain output color
  (`toolOutput`) whose text is the command's output. Pi's hints, warnings and
  timer, and lines other extensions add (a file-changes diff, say), keep
  their own colors.
- `renderShell` stays what the wrapped renderer chose, so Pi's colored box
  is kept. The inner renderer gets back its own previous component as
  `lastComponent`, never the wrapper.

It works whatever the load order: tested with a stand-in extension that
appends a line under bash results, loaded before and after it.

## Features and how they map

| pi-harness plugin | Pi |
| --- | --- |
| Bash commands highlighted (Shiki, Bash grammar) | A shell lexer of its own, colored with the theme's `syntax*` tokens. highlight.js's Bash grammar leaves most command names plain, so it isn't used for the shell itself. |
| Embedded code in Bash, found with Tree-sitter: `node -e/-p`, `python -c`, `perl -e`, `ruby -e`, `sh/bash/zsh -c`, `psql -c`, `mysql/mariadb -e`, awk's first quoted argument, sqlite3's last, heredocs fed to those and to `jq`/`yq` | Same rules, found by the lexer, highlighted with Pi's `highlightCode`. `bash -c '…'` is lexed as shell again, so a `python -c` inside it is Python. |
| `cd <cwd> && …` hidden, `cd <subdir> && …` shown relative | Same. |
| Commands folded: 1 line, or 1/2/5/all lines when the row is expanded (2 by default), `+N lines` hint | Same: 1 line collapsed, `commandPreview` lines expanded, then a dim `… N more command lines` line. |
| `ctrl+shift+o` shows every command whole, and back | Same shortcut, redraws the rows on screen. |
| Expand while writing: the whole command while its arguments stream in | Same, on by default (`expandWhileWriting`). |
| Output highlights: times, levels (`ERROR`, `WARN`, `[FAIL]`, `Tests PASSED`…), HTTP methods and statuses, non-zero exit codes, IPv4 addresses | Same rules, plus lowercase `error:`/`fatal:`/`error[E0382]:` and Pi's `Command exited with code N`. |
| `/syntax-highlighting-status` | Same command: the theme in use and which embedded languages highlight.js has loaded. |
| Settings page in the side panel (`bash-display` in `harness-settings.json`) | `syntaxHighlighting` in `settings.json` (below). |
| Row frame (`├ │ ╰─` edges colored by status) and footer `✓ exit 0 · 1.2s · timeout 30s` | Pi's own row: its background shows pending/success/error, `Took 1.2s` under the output, `(timeout 30s)` after the command, and `Command exited with code N` (colored) in the output. |
| Output preview: last 3/6/12/20 lines (6 by default), `… N earlier output lines` | Pi's own preview: last 5 lines, `ctrl+o` for all. |
| Reusable highlighter API for other plugins | Pi exports `highlightCode` and `getLanguageFromPath`; `highlight.ts` and `output.ts` here take a `Paint` and import nothing from Pi, so other extensions can use them. |

### Added in Pi

- Diff output (`git diff`, `git show`, `diff -u`): file headers bold, hunk
  headers in `accent`, added and removed lines in Pi's diff colors, context
  lines highlighted in the file's language. Hunks are counted from their
  header, so a `--- a/file` after a hunk is a header, not a removed line.
- JSON output (the whole output parses as JSON) is highlighted as JSON.
- More interpreters: `deno eval`, `php -r`, `lua -e`, `osascript -e`,
  `dash -c`, `duckdb`, and heredocs for them and for `bun`.
- A heredoc written to a file takes the file's language:
  `cat > app.py <<'EOF'`, `tee app.py <<EOF`.
- Prefixes before the interpreter are skipped: `sudo`, `env X=1`,
  `timeout 10`, `uv run`, `npx`, `pnpm exec`…

### Not exact

- The lexer reads commands for display; it is not a shell parser. Some
  cases come out plainer than with Tree-sitter: a prefix with arguments of
  its own (`sudo -u root python -c '…'`) hides the interpreter, `case`
  patterns are colored as command names, and the code inside `"…"` is
  highlighted as written, escapes included.
- highlight.js, not Shiki, highlights embedded code, so token coverage
  differs by language (there is no jq grammar, for example). Pi loads most
  of its languages just after startup; until then SQL, YAML or awk show as
  plain strings. `/syntax-highlighting-status` lists what's loaded.
- The plugin passed output containing ANSI colors through untouched. Pi
  strips them before drawing, so such output is colored here like any other.
- Diffs have no line-number gutter or added/removed backgrounds: recoloring
  can't add text without redrawing what other renderers drew, and Pi's
  themes have no diff background tokens.
- Not ported: the CPU/memory/IO activity line (pi-runtime's Linux process
  monitor) and the line-numbered hunk and difftastic renderers the plugin
  shared with bash-changes and the Git cards. bash-changes draws its own
  diff in Pi.
- `ctrl+shift+o` needs a terminal that tells it from `ctrl+o` (Kitty
  keyboard protocol or modifyOtherKeys, as Ghostty does).

## Settings

```json
{ "syntaxHighlighting": { "commandPreview": 2, "expandWhileWriting": true } }
```

- `commandPreview`: lines of a command shown when its row is expanded, a
  number or `"all"`. Collapsed rows show one line.
- `expandWhileWriting`: show the whole command while the model writes it.

Read when a session starts.

## Files

- `index.ts`: the Pi wiring (renderer wrapping, shortcut, command, settings)
- `shell.ts`: the shell lexer and the embedded-language rules
- `highlight.ts`: commands and embedded code to theme colors
- `output.ts`: output kinds (JSON, diff, log) and their colors
- `overlay.ts`, `ansi.ts`: recoloring lines another renderer drew
- `command.ts`: the `cd` shortening and folding
- `tests/`: `node --test 'tests/*.test.ts'` (Node 24 runs the TypeScript
  directly; no Pi install needed)
