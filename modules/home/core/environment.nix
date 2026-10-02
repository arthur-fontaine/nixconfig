{ lib, hostName, nixconfigDir, ... }:
{
  home.sessionPath = [
    "$HOME/.local/bin"
    "$HOME/.lmstudio/bin"
  ];

  home.sessionVariables = {
    CARGO_NET_GIT_FETCH_WITH_CLI = "true";
    CODEX_HOME = "$HOME/.config/codex";
    NIXCONFIG_REPO_DIR = nixconfigDir;
    NIXCONFIG_HOST = hostName;
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
