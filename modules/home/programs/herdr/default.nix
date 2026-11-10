{ config, lib, pkgs, ... }:
let
  # herdr-core (`hc`) runs the Herdr app's terminals and agents; the app (the
  # `herdr-app` cask) won't open without it. Not in Homebrew or nixpkgs, and
  # unrelated to the `herdr` TUI formula. The app finds it on the login
  # shell's PATH and leaves updating a package-managed core to us: bump the
  # version from https://releases.herdr.dev/core/latest.json.
  version = "0.1.18";

  # Since 0.1.18 the core is an app of its own on macOS, Herdr Core.app (so macOS can grant it
  # the local network and the microphone for the programs in its terminals). It wants to run
  # from a complete signed bundle: the bundle is kept whole, and herdr-core and hc are its
  # binary. A core in /nix/store is taken as Nix-managed: the app never updates it, which is
  # why an older one here showed "belongs to nix (update it in your Nix configuration)".
  herdrCore = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr-core";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://releases.herdr.dev/core/${version}/herdr-core-macos-aarch64.tar.gz";
      hash = "sha256-d9ivCS4lrmUPRCTW2tJ1FPaRahHYB/sHUoWM0nwh5Pw=";
    };
    sourceRoot = ".";
    # A signed release bundle: leave it byte for byte.
    dontFixup = true;
    installPhase = ''
      mkdir -p $out/Applications $out/bin
      cp -R "Herdr Core.app" $out/Applications/
      ln -s "$out/Applications/Herdr Core.app/Contents/MacOS/herdr-core" $out/bin/herdr-core
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
  # own modules (both without `export`; "../nix-editor/nvim.js" names another mod's), then
  # main.js without those imports.
  # Kept apart in the repo so `node --test` runs them.
  bundle = mod: { shared ? [ ], modules ? [ ] }: pkgs.runCommand "herdr-${mod}-main.js" { } ''
    {
      ${lib.concatMapStrings (f: "sed 's/^export //' ${./mods/_lib/${f}}\n") shared}
      ${lib.concatMapStrings (f: "sed -e 's/^export //' -e '/^import .* from \"\\.\\.\\{0,1\\}\\//d' ${./mods/${mod}/${f}}\n") modules}
      grep -v -E '^import .* from "(\./|\.\./)' ${./mods/${mod}/main.js}
    } > $out
  '';
  # The patched copies of shipped mods, and nix-diff (the diff tab nix-changes opens).
  mods = {
    nix-sidebar = { };
    nix-files = { shared = [ "editor.js" ]; };
    nix-changes = { };
    # The diff tab, editable: edit.js (its figures), and the editor's grid.js (key notation) and
    # nvim.js (its Neovim, started on diff.lua) joined in.
    nix-diff = { shared = [ "editor.js" ]; modules = [ "model.js" "syntax.js" "edit.js" "../nix-editor/grid.js" "../nix-editor/nvim.js" ]; };
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
    nix-info = { shared = [ "editor.js" ]; modules = [ "model.js" ]; };
    # The kanban (a block under the sidebar's tree, the board as a tab, its dialogs), on the
    # herdr-kanban daemon below; model.js (its figures) joined in.
    nix-kanban = { modules = [ "model.js" ]; };
  };
  modFiles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList (mod: o: [
    { name = "herdr-app/mods/${mod}/main.js"; value.source = if o == { } then ./mods/${mod}/main.js else bundle mod o; }
    { name = "herdr-app/mods/${mod}/mod.json"; value.source = ./mods/${mod}/mod.json; }
  ]) mods));

  # The kanban's daemon and its `herdr-kanban` CLI (kanban/README.md). TypeScript run as it
  # is by Node 24 (type stripping), so there is no build step: nix only fetches the pnpm
  # dependencies (the MCP SDK) and runs the unit tests.
  kanban = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "herdr-kanban";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ./kanban;
      fileset = lib.fileset.unions [ ./kanban/package.json ./kanban/pnpm-lock.yaml ./kanban/pnpm-workspace.yaml ./kanban/src ./kanban/test ];
    };
    nativeBuildInputs = [ pkgs.nodejs_24 pkgs.pnpm_10 pkgs.pnpmConfigHook pkgs.makeWrapper ];
    pnpmDeps = pkgs.fetchPnpmDeps {
      inherit (finalAttrs) pname version src;
      pnpm = pkgs.pnpm_10;
      fetcherVersion = 4;
      hash = "sha256-XoeN3WKVfSi95agvcVF7ZLzAn0TgVxAyqlAZnojS/hQ=";
    };
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      node --test test/*.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/herdr-kanban $out/bin
      cp -R package.json src node_modules $out/lib/herdr-kanban/
      makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/herdr-kanban --add-flags $out/lib/herdr-kanban/src/cli.ts
      runHook postInstall
    '';
    meta.mainProgram = "herdr-kanban";
  });

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
    # ⇧ as in "find in the project"; ⌘F stays find-in-file for the editor.
    "cmd-shift-f" = "nix-sidebar.filter";
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
      ignore = [ "^frame\\." "^space\\.colors" "^sidebar\\." "^agents\\." "^nix-spaces\\." "^nix\\." "^nix-kanban\\." ];
    };
  };

  home.packages = [ herdrCore kanban ];

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
    # nix-diff's backend: init.lua without language servers, and the live diff of each file.
    "herdr-app/nix-editor/diff.lua".source = ./nix-editor/diff.lua;
    # Its code colors: Ayu, as in Zed and Ghostty (init.lua puts it on the runtimepath).
    "herdr-app/nix-editor/ayu".source = pkgs.vimPlugins.neovim-ayu;
  };

  # The stdio launcher nix-editor reaches over 127.0.0.1:7741 (a mod can't start
  # processes). Run by the login shell, so it finds the user's node, nvim and language
  # servers on their PATH; nothing is installed for them.
  launchd.agents.herdr-lsp-bridge = {
    enable = true;
    config = {
      # mise is activated in the interactive shell only (a login shell has no node and no
      # language servers), so the bridge runs on mise's node shim with that shell's PATH.
      ProgramArguments = [ "${config.home.homeDirectory}/.local/share/mise/shims/node" "${./lsp-bridge/bridge.js}" ];
      EnvironmentVariables.PATH = lib.concatStringsSep ":" [
        "${config.home.homeDirectory}/.local/share/mise/shims"
        "/etc/profiles/per-user/${config.home.username}/bin"
        "/run/current-system/sw/bin"
        "/nix/var/nix/profiles/default/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/herdr-lsp-bridge.log";
    };
  };

  # The kanban's daemon: the local API the nix-kanban mod reads (127.0.0.1:7742), the scheduler
  # that sends To-do cards to the project orchestrators, and MCP on the LAN when enabled from
  # Herdr (7744). Its PATH reaches hc, herdr-app, pi, git, dns-sd and vm_stat.
  launchd.agents.herdr-kanban = {
    enable = true;
    config = {
      ProgramArguments = [ "${kanban}/bin/herdr-kanban" "daemon" ];
      EnvironmentVariables.PATH = lib.concatStringsSep ":" [
        "${config.home.homeDirectory}/.local/bin"
        "/etc/profiles/per-user/${config.home.username}/bin"
        "/run/current-system/sw/bin"
        "/nix/var/nix/profiles/default/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/herdr-kanban.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/herdr-kanban.log";
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
