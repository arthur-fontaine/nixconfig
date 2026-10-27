# Homebrew module

This directory contains Homebrew configuration and the categorized package lists it consumes.

Principles:
- keep the Homebrew module in `homebrew/default.nix`
- keep taps, brews, and casks beside the module that owns them
- group long package lists by category so they stay easy to scan and edit

Edit the list files directly when you want to add or remove packages.

Activation installs Homebrew when `brew` is missing and stops if it is older
than 7, after one `brew update` attempt.

If you delete a listed cask's app by hand, the next rebuild reinstalls it.
To get rid of an app for good, remove it from the cask list instead.

Casks that Homebrew does not ship live in `Casks/` at the repo root. Homebrew
only reads casks from that directory in a tap, and the tap is this repo itself
(`nixconfig/casks`, cloned from `nixconfigDir`). Commit a new cask before
rebuilding: `brew tap` sees committed content only. Reference it as
`nixconfig/casks/<token>` in a cask list.

Personal apps (Mixologist, Some Browser) keep their cask in their own repo,
under `Casks/`, and publish a DMG with the same name in every GitHub release.
Their repo is declared as a tap with a `clone_target` in `default.nix`, and the
cask as `{ name = "arthur-fontaine/<repo>/<token>"; greedy = true; }`, since a
`version :latest` cask only upgrades when greedy.
