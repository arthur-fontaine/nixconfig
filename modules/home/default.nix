{ username, homeDirectory, ... }:
{
  imports = [
    ./environment.nix
    ./zsh.nix
    ./git.nix
    ./gh.nix
    ./ghostty.nix
    ./mise.nix
    ./zed.nix
    ./karabiner.nix
    ./codex.nix
    ./opencode.nix
    ./pi.nix
    ./legacy.nix
    ./dev.nix
  ];

  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "25.05";

  programs.home-manager.enable = true;
}
