{ config, lib, pkgs, ... }:
let
  # herdr-core (`hc`) runs the Herdr app's terminals and agents; the app (the
  # `herdr-app` cask) won't open without it. Not in Homebrew or nixpkgs, and
  # unrelated to the `herdr` TUI formula. The app finds it on the login
  # shell's PATH and leaves updating a package-managed core to us: bump the
  # version from https://releases.herdr.dev/core/latest.json.
  version = "0.1.17";

  herdrCore = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr-core";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://releases.herdr.dev/core/${version}/herdr-core-macos-aarch64.tar.gz";
      hash = "sha256-ztvU1Nm6E4VYgZjdTTxn0mVEePM63VtkRdTQ652l/PM=";
    };
    sourceRoot = ".";
    # A signed release binary: leave it byte for byte.
    dontFixup = true;
    installPhase = ''
      install -Dm755 herdr-core $out/bin/herdr-core
      ln -s herdr-core $out/bin/hc
    '';
    meta.platforms = [ "aarch64-darwin" ];
  };

  # Herdr rewrites its shipped mods and layouts on every start, so changes live
  # in copies: `nix` is the shipped `main` layout pointing at nix-* copies of
  # its mods (shipped in herdr-app 0.1.11, then patched; each first commit is
  # the shipped file, to diff against after an update).
  # Files are linked one by one: Herdr writes jsconfig.json and .d.ts files
  # into each mod folder, so the folders themselves must stay writable.
  # Herdr refuses an import whose file resolves outside the mod's folder, and
  # every linked file resolves into the store. So a mod split into modules is
  # joined into one main.js here: the shared mods/_lib files it imports, then its
  # own modules (both without `export`), then main.js without those imports.
  # Kept apart in the repo so `node --test` runs them.
  bundle = mod: { shared ? [ ], modules ? [ ] }: pkgs.runCommand "herdr-${mod}-main.js" { } ''
    {
      ${lib.concatMapStrings (f: "sed 's/^export //' ${./mods/_lib/${f}}\n") shared}
      ${lib.concatMapStrings (f: "sed 's/^export //' ${./mods/${mod}/${f}}\n") modules}
      grep -v -E '^import .* from "(\./|\.\./_lib/)' ${./mods/${mod}/main.js}
    } > $out
  '';
  # The patched copies of shipped mods, and nix-diff (the diff tab nix-changes opens).
  mods = {
    nix-sidebar = { };
    nix-files = { };
    nix-changes = { };
    nix-diff = { modules = [ "model.js" "syntax.js" ]; };
    nix-worktree = { shared = [ "repo.js" ]; };
    nix-menu = { };
    nix-tabs = { };
    nix-status = { };
    nix-pane = { };
    nix-head = { };
    # The + popover: an open or idle worktree, or a new one, then Pi or a terminal.
    nix-new = { shared = [ "repo.js" ]; };
    # The code editor: a renderer for a headless Neovim; grid.js (its UI as a grid) and
    # nvim.js (msgpack-RPC to it) joined in.
    nix-editor = { modules = [ "grid.js" "nvim.js" ]; };
    # The Info panel: the selected Pi session and the Claude usage; model.js (the figures) joined in.
    nix-info = { modules = [ "model.js" ]; };
  };
  modFiles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList (mod: o: [
    { name = "herdr-app/mods/${mod}/main.js"; value.source = if o == { } then ./mods/${mod}/main.js else bundle mod o; }
    { name = "herdr-app/mods/${mod}/mod.json"; value.source = ./mods/${mod}/mod.json; }
  ]) mods));

  merge = import ../../lib/merge-json.nix { inherit pkgs; };
  json = pkgs.formats.json { };
  home = "${config.xdg.configHome}/herdr-app";

  # Herdr rewrites both files itself (Settings, zoom keys, mods' shared state),
  # so only these keys are merged in.
  settings = {
    font_size = 12;
    minimum_contrast = 1;
    sounds.enabled = true;
  };
  # Keys for the nix-* mods, all on cmd (terminals never get it, so nothing is
  # taken from typing). nix-status is always shown, so it runs them.
  keys.global = {
    "cmd-shift-n" = "nix-status.dispatch"; # new worktree
    "cmd-j" = "nix-status.jump";
    "cmd-shift-j" = "nix-status.back";
    "cmd-shift-b" = "nix-status.worktrees";
    "cmd-shift-r" = "nix-status.review";
    "cmd-shift-o" = "nix-status.editor";
  };
  shared = {
    layout = "nix";
    # The Files and Changes panels the tab bar offers (picked in the welcome).
    "workspace.panels" = [ "changes" "files" "info" ];
  };
in
{
  nixconfig.sync = {
    herdr-settings = {
      method = "json-merge";
      managed = settings;
      live = "~/.config/herdr-app/settings.json";
      repo = "modules/home/programs/herdr/default.nix (settings)";
      ignore = [ "^zoom$" ];
    };
    herdr-keys = {
      method = "json-merge";
      managed = keys;
      live = "~/.config/herdr-app/keys.json";
      repo = "modules/home/programs/herdr/default.nix (keys)";
      # Herdr's own defaults, written on first start.
      ignore = [ "^global\\." "^terminal\\." ];
    };
    herdr-shared = {
      method = "json-merge";
      managed = shared;
      live = "~/.config/herdr-app/shared.json";
      repo = "modules/home/programs/herdr/default.nix (shared)";
      # Mods' own state: onboarding, colors, sidebar width, list sorting.
      ignore = [ "^frame\\." "^space\\.colors" "^sidebar\\." "^agents\\." "^nix-spaces\\." "^nix\\." ];
    };
  };

  home.packages = [ herdrCore ];

  # A running Herdr keeps shared.json in memory and saves it on its next
  # change: quit Herdr before `rebuild` for the shared keys to stick.
  home.activation.herdrSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ${merge (json.generate "herdr-settings.json" settings) "${home}/settings.json"}
    ${merge (json.generate "herdr-shared.json" shared) "${home}/shared.json"}
    ${merge (json.generate "herdr-keys.json" keys) "${home}/keys.json"}
  '';

  xdg.configFile = modFiles // {
    "herdr-app/layouts/nix.json".source = ./layouts/nix.json;
    # The layout's light and dark themes.
    "herdr-app/themes/nix-light.json".source = ./themes/nix-light.json;
    "herdr-app/themes/nix-dark.json".source = ./themes/nix-dark.json;
    # nix-editor's backend: the config `nvim --embed` starts with.
    "herdr-app/nix-editor/init.lua".source = ./nix-editor/init.lua;
  };

  # The stdio launcher nix-editor reaches over 127.0.0.1:7741 (a mod can't start
  # processes). Run by the login shell, so it finds the user's node, nvim and language
  # servers on their PATH; nothing is installed for them.
  launchd.agents.herdr-lsp-bridge = {
    enable = true;
    config = {
      ProgramArguments = [ "/bin/zsh" "-lc" "exec node ${./lsp-bridge/bridge.js}" ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/herdr-lsp-bridge.log";
    };
  };

  # The icons every nix-* mod draws from. Copied, not linked: Herdr draws an svg only
  # when it is a real file in its home (a link into the store shows nothing).
  home.activation.herdrIcons = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    rm -rf "${home}/mods/nix-head/icons"
    mkdir -p "${home}/mods/nix-head/icons"
    cp ${./mods/nix-head/icons}/*.svg "${home}/mods/nix-head/icons/"
    chmod u+w "${home}/mods/nix-head/icons/"*.svg
  '';
}
