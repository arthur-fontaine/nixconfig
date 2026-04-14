# Program modules

This directory contains one subdirectory per configured program or tool.

Principles:
- keep each program's Nix module in `programs/<name>/default.nix`
- colocate raw files with the program that owns them
- prefer declarative Nix when the config is small and stable
- keep literal files beside the module when the upstream format is larger or fast-moving

Examples:
- `git/` and `gh/` are fully declarative
- `zsh/`, `ghostty/`, `zed/`, `karabiner/`, and `pi/` keep file payloads beside their module
- `mise/`, `codex/`, and `opencode/` stay small and declarative
