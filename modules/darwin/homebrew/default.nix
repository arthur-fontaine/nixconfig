{ ... }:
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
  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };

    taps = import ./taps.nix;

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
