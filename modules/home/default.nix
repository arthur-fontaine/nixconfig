{ pkgs, username, homeDirectory, ... }:
{
  imports = [
    ./shell.nix
    ./files.nix
    ./dev.nix
    ./apps.nix
  ];

  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "25.05";

  programs.home-manager.enable = true;
}
