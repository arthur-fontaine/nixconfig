# Homebrew module

This directory contains Homebrew configuration and the categorized package lists it consumes.

Principles:
- keep the Homebrew module in `homebrew/default.nix`
- keep taps, brews, and casks beside the module that owns them
- group long package lists by category so they stay easy to scan and edit

Edit the list files directly when you want to add or remove packages.
