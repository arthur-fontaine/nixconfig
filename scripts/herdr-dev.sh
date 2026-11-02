#!/usr/bin/env bash
# A second Herdr window for testing this repo's Herdr config without touching
# the real one: its own HERDR_APP_HOME, with the mods and layouts linked from
# the home-manager build exactly as `rebuild` would link them (store symlinks,
# so a mod that can't load from the store fails here too).
#
#   scripts/herdr-dev.sh start [layout]   build, link, open the window
#   scripts/herdr-dev.sh relink           rebuild and relink (mods reload live)
#   scripts/herdr-dev.sh shot [file]      screenshot of the test window
#   scripts/herdr-dev.sh stop             close it and delete its home
#
# Spaces and tabs live in herdr-core, which both windows share: close what you
# open here (herdr-app do space.close --id … --confirmed true).
set -euo pipefail
HOME_DIR="${HERDR_DEV_HOME:-/tmp/herdr-dev}"
HOST="${NIXCONFIG_HOST:-$(hostname -s)}"  # as rebuild (zshrc.d/708_rebuild.sh)
repo="$(cd "$(dirname "$0")/.." && pwd)"
user="$(id -un)"

pid() {
  for p in $(pgrep -f 'Herdr.app/Contents/MacOS/Herdr' || true); do
    case "$(ps eww -p "$p")" in *"HERDR_APP_HOME=$HOME_DIR"*) echo "$p" ;; esac
  done
}

link() {
  local files
  files="$(nix build --no-link --print-out-paths "path:$repo#darwinConfigurations.$HOST.config.home-manager.users.$user.home-files")"
  mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts"
  for src in "$files"/.config/herdr-app/mods/*/; do
    name="$(basename "$src")"
    mkdir -p "$HOME_DIR/mods/$name"
    for f in "$src"*; do ln -sfn "$(readlink "$f" || echo "$f")" "$HOME_DIR/mods/$name/$(basename "$f")"; done
  done
  for f in "$files"/.config/herdr-app/layouts/*; do ln -sfn "$(readlink "$f" || echo "$f")" "$HOME_DIR/layouts/$(basename "$f")"; done
}

case "${1:-}" in
  start)
    if [ -n "$(pid)" ]; then echo "already running ($(pid))"; exit 0; fi
    mkdir -p "$HOME_DIR"
    # Skip the welcome, start on the given layout.
    printf '{"frame.welcomed":"finished","layout":"%s","workspace.panels":["changes","files"]}\n' "${2:-nix}" > "$HOME_DIR/shared.json"
    link
    HERDR_APP_HOME="$HOME_DIR" nohup /Applications/Herdr.app/Contents/MacOS/Herdr > "$HOME_DIR.log" 2>&1 &
    for _ in $(seq 1 30); do HERDR_APP_HOME="$HOME_DIR" herdr-app status >/dev/null 2>&1 && break; sleep 0.5; done
    HERDR_APP_HOME="$HOME_DIR" herdr-app status | head -12 ;;
  relink) link; echo linked ;;
  shot) HERDR_APP_HOME="$HOME_DIR" herdr-app shot "${2:-/tmp/herdr-dev-shot.png}" ;;
  stop)
    p="$(pid)"
    if [ -n "$p" ]; then kill $p; fi
    rm -rf "$HOME_DIR" "$HOME_DIR.log"; echo stopped ;;
  *) sed -n 2,13p "$0"; exit 1 ;;
esac
