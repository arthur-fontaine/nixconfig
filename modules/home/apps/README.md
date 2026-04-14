# App modules

This directory contains app-specific configuration.

Principle:
- prefer declarative Nix when the config is small and stable
- keep raw linked files when the upstream app format is large or fast-moving

Currently more declarative:
- `mise.nix`
- `codex.nix`
- `opencode.nix`
- base Pi agent settings in `pi.nix`

Currently raw file backed:
- `ghostty.nix`
- `zed.nix`
- `karabiner.nix`
- Pi agent extensions in `pi.nix`
