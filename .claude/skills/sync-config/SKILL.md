---
name: sync-config
description: Sync app settings changed on this Mac back into the nixconfig repo, and bring a new app's config under management. Use when the user says they changed a setting in an app (Zed, Claude Code, Droppy, Smallcast, Bartender, Keka, Llama, OpenLogi, Codex, ...), asks to sync, port, or check local config against the repo, asks what drifted, or wants a newly installed app's settings added to the nix config.
---

# Sync local config into nixconfig

The repo is the source of truth and `rebuild` pushes it to the Mac. Nothing
pushes the other way, so a setting changed in an app is lost on the next
`rebuild` unless it is copied into the repo first. This skill does that copy.

`docs/syncing-config.md` explains how each program is managed. Read it when an
entry below does not make sense.

## 1. Find the drift

```sh
scripts/config-drift.py            # every managed program
scripts/config-drift.py --only droppy,zed-settings
scripts/config-drift.py --changed-only   # skip unmanaged keys
scripts/config-drift.py --json
```

It reads the `nixconfig.sync` manifest from the flake, so it needs `nix` and
Python 3.11+ (`nix shell nixpkgs#python3 -c scripts/config-drift.py` if the
default `python3` is older). The host defaults to `$NIXCONFIG_HOST`.

Each line names the repo file to edit:

- `changed`: the live value differs from the repo. Usually the user changed it in the app.
- `missing`: the repo sets it, but it is not on the Mac. Usually `rebuild` has not run since the repo changed, or the app was never launched. Do not delete it from the repo for this reason alone.
- `unmanaged`: a live key the repo does not list. It is either a new setting worth adding or app state to ignore.

Confirm the direction before editing. If the user did not change that setting
in the app, the repo may be the side that moved: run `rebuild` instead.

## 2. Port each change

Edit the file the report names. By method:

| Method | What to edit |
| --- | --- |
| `copy` with a repo file | Copy the live file over the repo file (`cp ~/.config/zed/settings.json modules/home/programs/zed/`), then review `git diff`. |
| `copy` with a Nix attrset (`claude-settings`, `pi-caveman`, `onepassword-ssh-agent`) | Port the key into the attrset in the named module. |
| `json-merge`, `toml-merge` | Port the key into the attrset the entry names. Dotted paths in the report are nested attrs. |
| `defaults` | Add the key to `targets.darwin.defaults.<domain>`. If the live value is plist data holding JSON, put it in `nixconfig.defaultsData.<domain>` as a Nix value instead. |
| `macos:<domain>` | Edit the matching file in `modules/darwin/core/defaults/`. |

Match the value type the app stores: `true` and `1` differ, and so do `2` and
`2.0`. Some apps store JSON as a string (Droppy's `customShelfWidgets`,
Smallcast's hotkeys). Write those with `builtins.toJSON`.

## 3. Sort unmanaged keys

For each `unmanaged` key, decide:

- **A setting the user chose**: add it as in step 2.
- **App state** (counters, timestamps, caches, onboarding or migration flags, window sizes, ids for this Mac or this account): add a regex to that entry's `ignore` list in its module, so the next report stays quiet. Keep the regexes narrow.

When unsure, look at the app's settings window or ask the user. Do not guess.

## 4. Keep secrets and identity out

The repo is public. Never commit:

- tokens, API keys, license keys, passwords, trial or license state
- email addresses, account or user ids, device UUIDs, display ids, IP addresses
- paths or hosts that name the user's employer or its infrastructure
- security-scoped bookmarks and other `data` blobs you cannot read

If a setting is only reachable through one of these (ProtonVPN keys suffixed
with the account email, Bartender's item layout), leave it unmanaged and say so
in the module comment. Machine-only ssh hosts go in `~/.ssh/config.local`,
which is not in the repo. Tokens for MCP servers go in `~/.config/.env` and are
referenced as `${VAR}`.

## 5. Bring a new app under management

1. Find where it stores settings:
   - `defaults export <bundle id> - | plutil -p -`. Get the bundle id with `/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "/Applications/<App>.app/Contents/Info.plist"`.
   - files in `~/.config/<app>`, `~/.<app>`, or `~/Library/Application Support/<app>`
   - nothing worth managing: settings synced to the user's account, or only window state. Say so in `docs/syncing-config.md` instead.
2. Pick the method:
   - plist prefs: `targets.darwin.defaults`, plus `nixconfig.defaultsData` for data keys
   - a file the app never writes: `xdg.configFile` or `home.file` (a read-only symlink)
   - a file the app rewrites in full: copy it in a `home.activation` step, like `zed/` or `neovim/`
   - a file the app rewrites with keys of its own: merge into it with `modules/home/lib/merge-json.nix`, like `claude-desktop/`
   - a private file (mode 600): `install -m 600` in an activation step, like `onepassword/`
3. Create `modules/home/programs/<app>/default.nix` and add it to `modules/home/programs/default.nix`.
4. Register a `nixconfig.sync.<name>` entry in the same module (options in `modules/home/lib/default.nix`) so the drift report covers it.
5. Add a section to `docs/syncing-config.md`, and a row to its table.

## 6. Verify and hand off

1. Build, which needs no sudo: `nix build --no-link "path:$PWD#darwinConfigurations.$NIXCONFIG_HOST.system"`.
2. Run `scripts/config-drift.py` again. Values you just ported from the live Mac should now report `ok`.
3. Commit with a Conventional Commit message (`chore(droppy): sync shelf settings`).
4. Ask before pushing. `rebuild` runs `git pull --ff-only` in `$NIXCONFIG_REPO_DIR` (default `~/nixconfig`), so the commit must be pushed, or present in that checkout, before it applies.
5. `rebuild` needs sudo. Ask the user to run `! rebuild`, then run the drift report once more. Restart apps that cache prefs in memory (Bartender, Keka, Droppy) if they did not pick the change up.
