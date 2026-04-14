{ lib, ... }:
{
  home.sessionPath = [
    "$HOME/.local/bin"
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin"
    "$HOME/.lmstudio/bin"
  ];

  home.sessionVariables = {
    CARGO_NET_GIT_FETCH_WITH_CLI = "true";
    CODEX_HOME = "$HOME/.config/codex";
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
