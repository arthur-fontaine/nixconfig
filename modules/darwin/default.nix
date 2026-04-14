{ pkgs, username, ... }:
{
  imports = [
    ./core
    ./homebrew
  ];

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.primaryUser = username;
  users.users.${username}.shell = pkgs.zsh;

  environment.shells = [ pkgs.zsh ];
  environment.systemPackages = with pkgs; [ git ];

  system.stateVersion = 6;
}
