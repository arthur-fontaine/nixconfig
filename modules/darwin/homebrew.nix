{ ... }:
let
  brewLists = [
    (import ./lists/brews-cli-shell.nix)
    (import ./lists/brews-dev-workflow.nix)
    (import ./lists/brews-language-toolchains.nix)
    (import ./lists/brews-data-infra-media.nix)
  ];

  caskLists = [
    (import ./lists/casks-security-ai.nix)
    (import ./lists/casks-dev-browsers.nix)
    (import ./lists/casks-productivity-media.nix)
    (import ./lists/casks-system-peripherals.nix)
  ];
in
{
  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };

    taps = import ./lists/taps.nix;

    # Keep one special formula as an attrset because it must not be linked.
    brews = [
      {
        name = "powershell";
        link = false;
      }
    ] ++ builtins.concatLists brewLists;

    casks = builtins.concatLists caskLists;
  };
}
