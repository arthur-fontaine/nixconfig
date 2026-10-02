{ pkgs, lib, config, ... }:
let
  # The rest of the file is app state keyed by account and device ids.
  managed = (pkgs.formats.json { }).generate "claude-desktop-config.json" {
    preferences = {
      quickEntryShortcut = "off";
      coworkBrowserToolsEnabled = true;
      coworkPreferredBrowser = "chrome";
      coworkWebSearchEnabled = true;
      coworkScheduledTasksEnabled = true;
      ccdScheduledTasksEnabled = true;
    };
  };
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
in
{
  home.activation.claudeDesktopConfig = lib.hm.dag.entryAfter [ "writeBoundary" ]
    (merge managed "${config.home.homeDirectory}/Library/Application Support/Claude/claude_desktop_config.json");
}
