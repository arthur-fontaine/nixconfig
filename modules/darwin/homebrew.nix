{ ... }:
{
  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };

    taps = import ./lists/taps.nix;

    brews = [
      {
        name = "powershell";
        link = false;
      }
    ] ++ import ./lists/brews.nix;

    casks = import ./lists/casks.nix;
  };
}
