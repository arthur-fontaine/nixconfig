# Raw file payloads

This directory keeps file-backed configuration that is still easier to manage as literal files than as Nix data.

Current groups:
- `ghostty/`
- `karabiner/`
- `pi/extensions/`
- `zed/`
- `zsh/`
- `brew/`, `chezmoi/`, `local/`, `nix/` for compatibility carry-over

When a file becomes small, stable, and worth modeling in Nix, move it out of this directory and into a dedicated module.
