# Syncing config

The repo is the source of truth. `rebuild` pushes it to the Mac.
Nothing pushes the other way. When you change a setting in an app, copy that
change back into the repo by hand, or the next `rebuild` reverts it.

## How each program is managed

| Method | What it means | Programs |
| --- | --- | --- |
| Symlink | The live file points into the Nix store. It is read-only. Edit the repo, then `rebuild`. | Ghostty, Karabiner, zsh, Pi, OpenCode, Mise, git, gh |
| Copy | `rebuild` copies the file and leaves it writable. The app can edit it. `rebuild` resets it. | Zed, Claude Code, Codex |
| macOS defaults | `rebuild` writes the listed keys with `defaults import`. Keys the module does not list are left alone. | Droppy, Smallcast Beta, screenshots, system settings |

## The loop

1. Change the setting in the app.
2. Copy the change into the module (see the program sections below).
3. Commit and push.
4. Run `rebuild`.
5. Restart the app if it did not pick the change up.

## Zed

Live files: `~/.config/zed/settings.json` and `~/.config/zed/keymap.json`.
Repo files: `modules/home/programs/zed/`.

```sh
cp ~/.config/zed/settings.json ~/.config/zed/keymap.json modules/home/programs/zed/
git diff modules/home/programs/zed
```

Review the diff before you commit. Zed writes extension lists and language
server state into `settings.json`. Keep what you want. Drop the rest.

## Claude Code

Repo module: `modules/home/programs/claude/default.nix`.

| Live file | How it is managed |
| --- | --- |
| `~/.claude/settings.json` | Generated from the Nix attribute set in the module. Port changes by hand. |
| `~/.claude/CLAUDE.md`, `rules/`, `skills/`, `output-styles/` | Copied from the files next to the module. Copy edits back. |
| `~/.claude.json` | Claude Code's own state. Only the `mcpServers` entries the module lists are managed. Other servers you add with `claude mcp add` survive. |
| `~/.claude/settings.local.json` | Not managed. Local only. |

To sync a setting you changed with `/config` or by toggling a plugin:

```sh
managed=$(grep -ho '/nix/store/[^ "]*claude-settings.json' \
  ~/.local/state/home-manager/gcroots/current-home/activate | head -1)
diff <(jq -S . "$managed") <(jq -S . ~/.claude/settings.json)
```

Lines marked `>` are local changes. Copy the keys you want to keep into the
`settingsJson` set in the module.

To sync a file you edited under `~/.claude/`:

```sh
cp ~/.claude/CLAUDE.md modules/home/programs/claude/CLAUDE.md
cp ~/.claude/output-styles/adhd-comms.md modules/home/programs/claude/output-styles/
```

To keep an MCP server you added with `claude mcp add`, move it into
`mcpServersJson`. Put tokens in `~/.config/.env` and reference them as
`${VAR}`. Never write a token into the module.

## Droppy

Domain: `iordv.Droppy`. Repo module: `modules/home/programs/droppy/default.nix`.

Droppy's Settings > Export writes the same domain. You do not need the export
file. Read the live values instead:

```sh
defaults read iordv.Droppy <key>
defaults export iordv.Droppy - | plutil -p -
```

Rules for the module:

- Copy the key and value as the app stores them. Booleans, integers, reals, strings, and lists map to Nix directly.
- Some keys hold JSON text, for example `customShelfWidgets` and `meetingControls_actionOrder`. Write them with `builtins.toJSON`.
- Do not add license, trial, cache, `didMigrate*`, permission flags, or ids that name this Mac. The repo is public.

## Smallcast Beta

Domain: `com.smallcast.app.beta`. Repo module: `modules/home/programs/smallcast/default.nix`.

```sh
defaults read com.smallcast.app.beta
```

Rules for the module:

- Scalar keys go in `targets.darwin.defaults`.
- Hotkeys are JSON text. Write them with `builtins.toJSON`.
- Keys the app stores as `data` (`aiConnections`, `aiDefaultModel`, `extensionAppearances`) go in the `dataKeys` set. The activation step writes them with `defaults write -data`.
- Extensions and their preferences live in `~/Library/Application Support/com.smallcast.app.beta/`. They are not managed.

## Homebrew apps

Add or remove a cask in `modules/darwin/homebrew/casks-*.nix`, then `rebuild`.
`rebuild` removes apps that are installed by Homebrew but no longer listed.
Apps that Homebrew does not ship get a cask in `Casks/` at the repo root. See
`modules/darwin/homebrew/README.md`.
