# nixconfig

Nix-based macOS configuration converted from `~/.local/share/chezmoi` and curated parts of `~/.config`.

## Goals

- preserve the behavior of the original chezmoi-managed setup
- move machine state into declarative `nix-darwin` + `home-manager`
- keep raw app configs where Nix modules would add little value
- keep large package lists easy to scan and edit

## Structure

### Entry point

- `flake.nix`

### macOS layer

- `modules/darwin/default.nix`: shared Darwin wiring
- `modules/darwin/defaults.nix`: macOS defaults
- `modules/darwin/homebrew.nix`: Homebrew activation and package wiring
- `modules/darwin/lists/*.nix`: taps, brews, casks

### home-manager layer

- `modules/home/default.nix`: user module composition
- `modules/home/environment.nix`: PATH, env vars, screenshot directory/defaults
- `modules/home/zsh.nix`: shell wiring, prompt, plugins, completions
- `modules/home/git.nix`: declarative git config
- `modules/home/gh.nix`: declarative GitHub CLI config
- `modules/home/dev.nix`: VS Code, Go, Cargo install hooks
- `modules/home/apps/default.nix`: app-module aggregation
- `modules/home/apps/*.nix`: app-specific config
- `modules/home/compat/default.nix`: legacy compatibility layer
- `modules/home/lists/*.nix`: large tool/extension lists
- `modules/home/files/**`: raw config files copied from the current setup where direct file management is still preferred

## What is declarative now

These are modeled directly in Nix:

- Homebrew taps, formulae, casks
- macOS defaults
- git config
- gh config
- shell environment variables and PATH additions
- screenshot directory creation and screenshot destination
- VS Code / Go / Cargo install hooks
- Mise config
- Codex config
- OpenCode config
- base Pi agent settings

## What stays as raw config files

These are still linked from `modules/home/files/**` because that is the simplest way to keep behavior exact and easy to diff:

- Ghostty
- Zed
- Karabiner
- Pi agent extensions
- zsh prompt, plugins, completions, and `zshrc.d` fragments
- transitional compatibility files like `.Brewfile`, `chezmoi.toml`, and `nix.conf`

## Notes

- This repo has not run `nix` locally.
- The current revision has only been statically reviewed for likely Nix/Home Manager issues; it has not been evaluated yet.
- Auth and secret state is still intentionally excluded.
- `zsh_plugins.zsh` and generated completions are seeded from the repo and then refreshed into mutable files during activation.
- Pi config now targets `~/.pi/agent/**`, which matches the original chezmoi layout.
- `modules/home/apps/**` is the cleaner long-term home for app configuration.
- `modules/home/compat/**` exists specifically to isolate legacy carry-over files from the future-state Nix config.

## Apply later

When you are ready on your machine:

```sh
sudo nix run nix-darwin -- switch --flake .#Arthur-Mac
```
