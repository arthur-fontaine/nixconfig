# Compatibility layer

This directory contains files kept mainly for transition and compatibility with the old chezmoi-based setup.

Examples:
- `.Brewfile`
- `chezmoi.toml`
- `nix.conf`
- helper scripts still sourced by legacy shell snippets

The goal is to shrink this directory over time as more behavior moves into first-class Nix modules.
