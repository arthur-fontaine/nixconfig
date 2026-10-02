{ pkgs, lib, config, ... }:
let
  # The rest of the file is app state keyed by account and device ids.
  prefs = {
    preferences = {
      quickEntryShortcut = "off";
      coworkBrowserToolsEnabled = true;
      coworkPreferredBrowser = "chrome";
      coworkWebSearchEnabled = true;
      coworkScheduledTasksEnabled = true;
      ccdScheduledTasksEnabled = true;
    };
  };
  managed = (pkgs.formats.json { }).generate "claude-desktop-config.json" prefs;
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
in
{
  nixconfig.sync.claude-desktop = {
    method = "json-merge";
    managed = prefs;
    live = "~/Library/Application Support/Claude/claude_desktop_config.json";
    repo = "modules/home/programs/claude-desktop/default.nix";
    ignore = [
      "^(?!preferences\\.)"
      "ByAccount$"
      "^preferences\\.(epitaxyPrefs|launchPreview[A-Za-z]+|coworkLegacyRootGrantsPruned|coworkHipaaRestricted|orgWorkAcrossAppsDisabled|remoteToolsDeviceName|sidebarMode)$"
      "Latched$"
    ];
  };

  home.activation.claudeDesktopConfig = lib.hm.dag.entryAfter [ "writeBoundary" ]
    (merge managed "${config.home.homeDirectory}/Library/Application Support/Claude/claude_desktop_config.json");
}
