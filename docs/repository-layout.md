# Repository layout

This document keeps the implementation details out of the main README.
If you only want to install the setup on a Mac, start with the root `README.md` instead.

## Goals

- keep machine setup declarative with `nix-darwin` + `home-manager`
- keep app and tool ownership obvious
- keep large package lists easy to scan and edit
- keep raw config files close to the program they belong to

## Entry points

- `flake.nix`: top-level flake definition and `darwinConfigurations`
- `hosts/default.nix`: merges tracked hosts from `hosts/shared.nix` with optional local overrides from `hosts/local.nix`
- `hosts/shared.nix`: tracked host definitions
- `hosts/local.nix.example`: template for a machine-specific host definition

## macOS layer

- `modules/darwin/default.nix`: shared Darwin wiring
- `modules/darwin/core/`: macOS defaults and system-level settings
- `modules/darwin/homebrew/`: Homebrew taps, formulae, and casks grouped by category
- `modules/darwin/services/`: system-level launchd services (e.g. dnsmasq for `*.localhost`)

## home-manager layer

- `modules/home/default.nix`: user-level module composition
- `modules/home/core/`: environment and shared home-manager settings
- `modules/home/programs/`: one subdirectory per configured program or tool
- `modules/home/lib/`: shared helpers and the `nixconfig.*` options (plist data keys, the sync manifest, JSON merging)
- `modules/home/profiles/development/`: grouped development tooling such as Go tools and Cargo installs

## Declarative in Nix

These are modeled directly in Nix:

- macOS defaults
- Homebrew taps, formulae, and casks
- shell environment variables and PATH wiring
- git and gh configuration
- development tool installation hooks
- Mise, Codex, and Pi base configuration

## Kept as raw config files

These remain literal files, colocated with the module that owns them:

- Ghostty
- Zed
- Karabiner
- Pi extensions
- zsh prompt, plugins, completions, and `zshrc.d` fragments

## Scripts and skills

- `scripts/bootstrap-macos.sh`: first-time setup of a Mac
- `scripts/config-drift.py`: compares the managed config with the live Mac
- `.claude/skills/sync-config/`: Claude Code skill that ports app settings back into the repo

## Syncing changes back

See [`syncing-config.md`](./syncing-config.md) for how each program is managed and how to pull a change made in an app into the repo.

## Notes

- secrets and auth state are intentionally excluded
- `hosts/local.nix` is ignored by git on purpose, so a bootstrap run can create a machine-specific config without touching tracked files
- while you use `hosts/local.nix`, run rebuilds with a `path:` flake reference such as `sudo darwin-rebuild switch --flake "path:$PWD#My-Mac"`
- if you want your host definition versioned, move it from `hosts/local.nix` into `hosts/shared.nix` once you are happy with it
