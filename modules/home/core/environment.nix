{ lib, hostName, nixconfigDir, ... }:
{
  home.sessionPath = [
    "$HOME/.local/bin"
  ];

  home.sessionVariables = {
    CARGO_NET_GIT_FETCH_WITH_CLI = "true";
    CODEX_HOME = "$HOME/.config/codex";
    NIXCONFIG_REPO_DIR = nixconfigDir;
    NIXCONFIG_HOST = hostName;
  };

  nixconfig.sync.screenshots = {
    method = "defaults";
    live = "com.apple.screencapture";
    repo = "modules/home/core/environment.nix";
    ignore = [ "^last-" "^location-" "^(style|target|target-[a-z]+|video)$" ];
  };

  targets.darwin.defaults = {
    "com.apple.screencapture" = {
      location = "~/Pictures/Screenshots";
    };
  };

  home.activation.createScreenshotsDirectory = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p "$HOME/Pictures/Screenshots"
  '';
}
