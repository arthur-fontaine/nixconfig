{ pkgs, lib, config, ... }:
let
  # Mixologist rewrites the whole file whenever a setting changes in the app.
  prefs = {
    hidingMethod = "restriction";
    # The apps Bartender 7 hid, by bundle id, plus DigUp. Mixologist hides
    # every item of an app; Bartender listed them one by one.
    hiddenApps = [
      "app.llama.Llama"
      "ch.protonvpn.mac"
      "com.1password.1password"
      "com.abdurrahim.DigUp"
      "com.anthropic.claudefordesktop"
      "com.apple.campo"
      "com.fleetdm.desktop"
      "com.FluidApp.app"
      "com.hnc.Discord"
      "com.microsoft.teams2"
      "com.pais.handy"
      "com.sentinelone.SentinelAgent"
      "com.smallcast.app.beta"
      "dev.kdrag0n.MacVirt"
      "fyi.lunar.Lunar"
      "iordv.Droppy"
      "notion.id"
      "org.openlogi.agent"
      "org.pqrs.Karabiner-Console-User-Server"
      "pro.betterdisplay.BetterDisplay"
    ];
    hiddenAppleItems = [ ];
  };
  managed = (pkgs.formats.json { }).generate "mixologist-settings.json" prefs;
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
in
{
  nixconfig.sync.mixologist = {
    method = "json-merge";
    managed = prefs;
    live = "~/.config/mixologist/settings.json";
    repo = "modules/home/programs/mixologist/default.nix";
  };

  # Mixologist applies the file as soon as it changes, so a running copy picks
  # this up without a restart.
  home.activation.mixologistSettings = lib.hm.dag.entryAfter [ "writeBoundary" ]
    (merge managed "${config.home.homeDirectory}/.config/mixologist/settings.json");

  # Mixologist's "Launch at login" is an SMAppService login item, which no
  # setting controls.
  launchd.agents.mixologist = {
    enable = true;
    config = {
      ProgramArguments = [ "/usr/bin/open" "-a" "Mixologist" ];
      RunAtLoad = true;
    };
  };
}
