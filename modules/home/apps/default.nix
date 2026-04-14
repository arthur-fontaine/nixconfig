{ ... }:
{
  imports = [
    # Mixed declarative/file-backed apps.
    ./ghostty.nix
    ./zed.nix
    ./karabiner.nix
    ./pi.nix

    # Smaller configs modeled directly in Nix.
    ./mise.nix
    ./codex.nix
    ./opencode.nix
  ];
}
