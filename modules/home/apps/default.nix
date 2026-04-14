{ ... }:
{
  imports = [
    # Raw file backed apps.
    ./ghostty.nix
    ./zed.nix
    ./karabiner.nix

    # Smaller configs modeled directly in Nix.
    ./mise.nix
    ./codex.nix
    ./opencode.nix
    ./pi.nix
  ];
}
