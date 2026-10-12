{ ... }:
{
  nixconfig.sync.digup = {
    method = "defaults";
    live = "com.abdurrahim.DigUp";
    repo = "modules/home/programs/digup/default.nix";
    ignore = [
      "^onboarded$"
    ];
  };

  # Indexed folders (roots, excludedFolders, codeRoots, codeExcludedFolders) are
  # chosen in onboarding, which also asks for access to each one. Port them here
  # afterwards only if the same paths exist on every Mac.
  targets.darwin.defaults."com.abdurrahim.DigUp" = {
    # Bundle id of the editor code results open in, at the matched line.
    codeEditor = "dev.zed.Zed-Preview";

    SUAutomaticallyUpdate = true;
    SUEnableAutomaticChecks = true;
  };
}
