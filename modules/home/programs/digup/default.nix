{ config, ... }:
{
  nixconfig.sync.digup = {
    method = "defaults";
    live = "com.abdurrahim.DigUp";
    repo = "modules/home/programs/digup/default.nix";
    ignore = [
      "^onboarded$"
    ];
  };

  # Indexed folders are chosen in onboarding, which also asks for access to
  # each one. Keep to folders that exist on every Mac.
  targets.darwin.defaults."com.abdurrahim.DigUp" = let home = config.home.homeDirectory; in {
    roots = map (dir: "${home}/${dir}") [ "Desktop" "Documents" "Downloads" "Pictures" "Movies" "Music" ];
    excludedFolders = [ ];
    excludedTypes = [ ];
    codeRoots = [ "${home}/Developer" ];
    codeExcludedFolders = [ ];

    # Bundle id of the editor code results open in, at the matched line.
    codeEditor = "dev.zed.Zed-Preview";

    SUAutomaticallyUpdate = true;
    SUEnableAutomaticChecks = true;
  };

  # DigUp's own "Launch at login" is an SMAppService login item, which no
  # preference controls. A launch this soon after login still counts as one
  # for DigUp, so the search window stays closed.
  launchd.agents.digup = {
    enable = true;
    config = {
      ProgramArguments = [ "/usr/bin/open" "-a" "DigUp" ];
      RunAtLoad = true;
    };
  };
}
