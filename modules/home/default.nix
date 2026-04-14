{ username, homeDirectory, ... }:
{
  imports = [
    ./core
    ./programs
    ./profiles/development
  ];

  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "25.05";

  programs.home-manager.enable = true;
}
