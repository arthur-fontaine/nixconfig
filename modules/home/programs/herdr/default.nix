{ pkgs, ... }:
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
in
{
  home.packages = [ herdrCore ];
}
