{ username, homeDirectory, ... }:
{
  imports = [
    ./environment.nix
    ./zsh.nix
    ./git.nix
    ./gh.nix
    ./apps
    ./compat
    ./dev.nix
  ];

  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "25.05";

  programs.home-manager.enable = true;
}
