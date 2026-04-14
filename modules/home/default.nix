{ username, homeDirectory, ... }:
{
  imports = [
    # Core user environment.
    ./environment.nix
    ./zsh.nix
    ./git.nix
    ./gh.nix

    # App-specific configuration.
    ./apps

    # Large installation lists and activation hooks.
    ./dev.nix
  ];

  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "25.05";

  programs.home-manager.enable = true;
}
