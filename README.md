# nixconfig

Nix-based macOS configuration originally imported from `~/.local/share/chezmoi` and curated parts of `~/.config`, now cleaned up to be managed directly by Nix.

## Goals

- preserve the behavior of the original setup while moving ownership to Nix
- move machine state into declarative `nix-darwin` + `home-manager`
- keep raw app configs where Nix modules would add little value
- keep large package lists easy to scan and edit

## Structure

### Entry point

- `flake.nix`

### macOS layer

- `modules/darwin/default.nix`: shared Darwin wiring
- `modules/darwin/core/default.nix`: shared Darwin core imports
- `modules/darwin/core/defaults.nix`: macOS defaults
- `modules/darwin/homebrew/default.nix`: Homebrew activation and package wiring
- `modules/darwin/homebrew/*.nix`: categorized Homebrew taps, formulae, and casks

### home-manager layer

- `modules/home/default.nix`: user module composition
- `modules/home/core/default.nix`: shared home-manager core imports
- `modules/home/core/environment.nix`: PATH, env vars, screenshot directory/defaults
- `modules/home/programs/default.nix`: program-module aggregation
- `modules/home/programs/<name>/default.nix`: one module per program or tool
- `modules/home/programs/<name>/*`: raw files colocated with the program that owns them
- `modules/home/profiles/development/default.nix`: development profile activation hooks
- `modules/home/profiles/development/*.nix`: grouped VS Code, Go, and Cargo lists

## What is declarative now

These are modeled directly in Nix:

- Homebrew taps, formulae, and casks grouped by category
- macOS defaults
- git config
- gh config
- shell environment variables and PATH additions
- screenshot directory creation and screenshot destination
- VS Code / Go / Cargo install hooks with grouped extension lists
- Mise config
- Codex config
- OpenCode config
- base Pi agent settings

## What stays as raw config files

These are still kept as literal files, but now live beside the program module that owns them so ownership is obvious:

- Ghostty themes
- Zed
- Karabiner
- Pi agent extensions
- zsh prompt, plugins, completions, and `zshrc.d` fragments

## Notes

- This repo has not run `nix` locally.
- The current revision has only been statically reviewed for likely Nix/Home Manager issues; it has not been evaluated yet.
- Auth and secret state is still intentionally excluded.
- `zsh_plugins.zsh` and generated completions are seeded from the repo and then refreshed into mutable files during activation.
- Pi config now targets `~/.pi/agent/**`, which matches the original chezmoi layout.
- `modules/home/programs/**` is now the long-term home for tool and app configuration.
- Homebrew and VS Code lists are grouped by category to make review and editing easier.
- This repo no longer carries chezmoi compatibility files such as `.Brewfile`, `chezmoi.toml`, or a copied `nix.conf`.

## Apply later

When you are ready on your machine:

```sh
sudo nix run nix-darwin -- switch --flake .#Arthur-Mac
```
