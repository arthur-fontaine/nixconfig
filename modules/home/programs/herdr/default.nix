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
  # nix-agents, nix-files and nix-changes (shipped from herdr-app 0.1.11, then
  # patched).
  # Files are linked one by one: Herdr writes jsconfig.json and .d.ts files
  # into each mod folder, so the folders themselves must stay writable.
  # Herdr refuses an import whose file resolves outside the mod's folder, and
  # every linked file resolves into the store. So a mod split into modules
  # (nix-diff: model.js and syntax.js, kept apart for `node --test`) is joined
  # into one main.js here.
  bundle = mod: modules: pkgs.runCommand "herdr-${mod}-main.js" { } ''
    {
      ${lib.concatMapStrings (m: "sed 's/^export //' ${./mods/${mod}/${m}}\n") modules}
      grep -v '^import .* from "\./' ${./mods/${mod}/main.js}
    } > $out
  '';
  # nix-diff is new: the diff tab nix-changes opens, laid out like Zed's.
  mods = {
    nix-spaces = { };
    nix-agents = { };
    nix-files = { };
    nix-changes = { };
    nix-diff = { main = bundle "nix-diff" [ "model.js" "syntax.js" ]; };
  };
  modFiles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList (mod: o: [
    { name = "herdr-app/mods/${mod}/main.js"; value.source = o.main or ./mods/${mod}/main.js; }
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
