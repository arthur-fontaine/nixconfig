{ config, lib, pkgs, ... }:
let
  # herdr-core (`hc`) runs the Herdr app's terminals and agents; the app (the
  # `herdr-app` cask) won't open without it. Not in Homebrew or nixpkgs, and
  # unrelated to the `herdr` TUI formula. The app finds it on the login
  # shell's PATH and leaves updating a package-managed core to us: bump the
  # version from https://releases.herdr.dev/core/latest.json.
  version = "0.1.16";

  herdrCore = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr-core";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://releases.herdr.dev/core/${version}/herdr-core-macos-aarch64.tar.gz";
      hash = "sha256-aY2PDET05LFf7BdNUqOdV6AUz9ca3e1EtToHU7Rp0P0=";
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
  # in copies: `nix` is the shipped `main` layout pointing at nix-spaces and
  # nix-agents (shipped spaces/agents from herdr-app 0.1.11, then patched).
  # Files are linked one by one: Herdr writes jsconfig.json and .d.ts files
  # into each mod folder, so the folders themselves must stay writable.
  mods = [ "nix-spaces" "nix-agents" ];
  modFiles = lib.listToAttrs (lib.concatMap (mod: map (file: {
    name = "herdr-app/mods/${mod}/${file}";
    value.source = ./mods/${mod}/${file};
  }) [ "main.js" "mod.json" ]) mods);

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
  shared = {
    layout = "nix";
    # The Files and Changes panels the tab bar offers (picked in the welcome).
    "workspace.panels" = [ "changes" "files" ];
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
    herdr-shared = {
      method = "json-merge";
      managed = shared;
      live = "~/.config/herdr-app/shared.json";
      repo = "modules/home/programs/herdr/default.nix (shared)";
      # Mods' own state: onboarding, colors, sidebar width, list sorting.
      ignore = [ "^frame\\." "^space\\.colors" "^sidebar\\." "^agents\\." "^nix-spaces\\." ];
    };
  };

  home.packages = [ herdrCore ];

  # A running Herdr keeps shared.json in memory and saves it on its next
  # change: quit Herdr before `rebuild` for the shared keys to stick.
  home.activation.herdrSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ${merge (json.generate "herdr-settings.json" settings) "${home}/settings.json"}
    ${merge (json.generate "herdr-shared.json" shared) "${home}/shared.json"}
  '';

  xdg.configFile = modFiles // {
    "herdr-app/layouts/nix.json".source = ./layouts/nix.json;
  };
}
