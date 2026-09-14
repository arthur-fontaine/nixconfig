# Homebrew module

This directory contains Homebrew configuration and the categorized package lists it consumes.

Principles:
- keep the Homebrew module in `homebrew/default.nix`
- keep taps, brews, and casks beside the module that owns them
- group long package lists by category so they stay easy to scan and edit

Edit the list files directly when you want to add or remove packages.

Casks that Homebrew does not ship live in `Casks/` at the repo root. Homebrew
only reads casks from that directory in a tap, and the tap is this repo itself
(`nixconfig/casks`, cloned from `nixconfigDir`). Commit a new cask before
rebuilding: `brew tap` sees committed content only. Reference it as
`nixconfig/casks/<token>` in a cask list.
