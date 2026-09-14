{ username, homeDirectory, nixconfigDir, ... }:
let
  brewLists = [
    (import ./brews-cli-shell.nix)
    (import ./brews-dev-workflow.nix)
    (import ./brews-language-toolchains.nix)
    (import ./brews-data-infra-media.nix)
  ];

  caskLists = [
    (import ./casks-security-ai.nix)
    (import ./casks-dev-browsers.nix)
    (import ./casks-productivity-media.nix)
    (import ./casks-system-peripherals.nix)
  ];
in
{
  # Runs before the homebrew step. Stale cached manifests make brew bundle fail
  # with "Couldn't find manifest matching bottle checksum"; a refetch fixes it.
  system.activationScripts.extraActivation.text = ''
    sudo -u ${username} -H find "${homeDirectory}/Library/Caches/Homebrew/downloads" \
      -name '*.bottle_manifest.json' -delete 2>/dev/null || true
  '';

  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      # nix-darwin appends `--zap --force-cleanup` to `brew bundle` for this,
      # so unlisted formulae/casks are zapped non-interactively during activation.
      cleanup = "zap";
      upgrade = true;
    };

    taps = import ./taps.nix ++ [
      {
        name = "nixconfig/casks";
        clone_target = nixconfigDir;
        force_auto_update = true;
        trusted = true;
      }
    ];

    brews = builtins.concatLists brewLists;

    casks = builtins.concatLists caskLists;
  };
}
