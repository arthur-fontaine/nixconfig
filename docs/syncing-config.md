# Syncing config

The repo is the source of truth. `rebuild` pushes it to the Mac.
Nothing pushes the other way. When you change a setting in an app, copy that
change back into the repo by hand, or the next `rebuild` reverts it.

## How each program is managed

| Method | What it means | Programs |
| --- | --- | --- |
| Symlink | The live file points into the Nix store. It is read-only. Edit the repo, then `rebuild`. | Ghostty, Karabiner, zsh, Pi, Mise, git, gh, Neovim (except its lockfile), ssh, Llama model overrides |
| Copy | `rebuild` copies the file and leaves it writable. The app can edit it. `rebuild` resets it. | Zed, Claude Code, Neovim lockfile, pi-caveman, 1Password SSH agent |
| Merge | `rebuild` merges the listed keys into a file the app also writes. Keys the module does not list are left alone. | Codex, OpenLogi, Handy, Claude desktop, Claude Code MCP servers |
| macOS defaults | `rebuild` writes the listed keys with `defaults import`. Keys the module does not list are left alone. | Droppy, Smallcast Beta, Bartender, Keka, AirBattery, BetterDisplay, ProtonVPN, screenshots, system settings |

## Find what changed

```sh
scripts/config-drift.py
```

It compares every managed file and defaults domain with the live Mac and
names the repo file to edit. `changed` means the live value differs from the
repo. `unmanaged` lists live keys the repo does not set yet, minus the app
state each module ignores. Exit status is 1 when anything changed.

Each module registers what it manages in `nixconfig.sync` (see
`modules/home/lib/default.nix`). A new module needs an entry there to be
covered.

In Claude Code, the repo's `sync-config` skill walks through the whole loop.

## The loop

1. Change the setting in the app.
2. Run `scripts/config-drift.py` and copy the change into the module it names (see the program sections below).
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
| `~/.claude/CLAUDE.md`, `rules/`, `skills/` | Copied from the files next to the module. Copy edits back. |
| `~/.claude/skills/<mod>/` | Mods outside a marketplace, from `localMods` in the module. `rebuild` replaces each folder whole. `cache-timer` lives in `mods/` next to the module; `cache-warmer` is pinned upstream. |
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
- Keys the app stores as `data` (`aiConnections`, `aiDefaultModel`, `extensionAppearances`) go in the `dataKeys` set, which feeds `nixconfig.defaultsData`. The activation step writes them with `defaults write -data`.
- Extensions and their preferences live in `~/Library/Application Support/com.smallcast.app.beta/`. They are not managed.

## Bartender 7

Domain: `com.surteesstudios.Bartender`. Repo module: `modules/home/programs/bartender/default.nix`.

Only the behaviour and style settings are managed. The item layout
(`GoldenGateProfiles`, `GoldenGateHiddenItemOrderKeys`) is not: it lists every
menu bar item on this Mac by position, including work-managed agents. Arrange
items in Bartender itself.

## Keka, AirBattery, BetterDisplay, ProtonVPN

Plain defaults domains, one module each under `modules/home/programs/`:
`com.aone.keka`, `com.lihaoyun6.AirBattery`, `pro.betterdisplay.BetterDisplay`,
`ch.protonvpn.mac`.

- BetterDisplay keys named `<setting>@Display:<tag>` are tied to displays this Mac has seen. Only app-wide keys are managed.
- ProtonVPN stores per-account settings under keys suffixed with the account email. Those stay out of the repo.
- Keka's archive file associations live in `modules/darwin/core/defaults/archives.nix`.

## Llama

Repo module: `modules/home/programs/llama/default.nix`. It lists the models
to keep, and `rebuild` downloads any missing file into the Hugging Face cache
(`~/.cache/huggingface/hub`), where Llama.app finds it. Install a model in the
app to try it, then add it to `models` (with its `mmproj-`/`mtp-` files) to
keep it. Models removed from the list stay on disk: delete them in the app.

Per-model llama.cpp options go in the module's `settings`, which become
`~/.config/llama/models.user.ini` (read-only). The app's own `models.ini` is
regenerated on every launch and is not managed.

Smallcast uses the server at `localhost:9931` and names models by their
`repo:QUANT` id.

`modules/darwin/llama-cpp.nix` swaps in a llama.cpp dev build from GitHub
(for decision models) while the installed Llama.app is `appVersion`. Once the
app updates, the next `rebuild` goes back to the app's own build; check whether
the new version's pin has what you need, and bump both values if not.

## Handy

Repo module: `modules/home/programs/handy/default.nix`. Merged into
`~/Library/Application Support/com.pais.handy/settings_store.json`. The
post-processing prompt lives in `improve-transcriptions.txt` beside the module.

API keys, the provider list Handy ships, and onboarding state stay out. The
speech model itself is a download: pick it again in Handy on a new Mac. Quit
Handy before `rebuild`, or it may write its in-memory settings back.

## Claude desktop

Repo module: `modules/home/programs/claude-desktop/default.nix`. Merged into
`~/Library/Application Support/Claude/claude_desktop_config.json`. Only
`preferences` keys are managed. The rest is state keyed by account and device.

## Neovim

Live files: `~/.config/nvim/`. Repo files: `modules/home/programs/neovim/`.
`init.lua` and `lua/` are symlinked. `lazy-lock.json` is copied, because
`:Lazy update` rewrites it. To keep updated plugin pins:

```sh
cp ~/.config/nvim/lazy-lock.json modules/home/programs/neovim/
```

## ssh and the 1Password SSH agent

`~/.ssh/config` comes from `modules/home/programs/ssh/default.nix`. It
includes `~/.ssh/config.local`, which is not managed: put hosts that do not
belong in a public repo there.

`~/.config/1Password/ssh/agent.toml` comes from
`modules/home/programs/onepassword/default.nix`. Git commit signing goes
through this agent, so check `ssh-add -l` against the agent socket after
changing the vault list.

## Not managed

- Settings synced to an account: Spotify, Discord, Chrome, Figma, Notion, Linear, Teams, WhatsApp, ChatGPT.
- Apps with only window state: DataGrip, Cyberduck, HTTPie, OrbStack (its VM settings change with `orb config set`), UTM.
- Smallcast quicklinks and extensions, which live in SQLite and `~/Library/Application Support/com.smallcast.app.beta/`.
- The Dock's app list.

## Homebrew apps

Add or remove a cask in `modules/darwin/homebrew/casks-*.nix`, then `rebuild`.
`rebuild` removes apps that are installed by Homebrew but no longer listed.
Apps that Homebrew does not ship get a cask in `Casks/` at the repo root. See
`modules/darwin/homebrew/README.md`.
