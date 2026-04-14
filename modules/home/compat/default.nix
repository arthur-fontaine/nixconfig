{ ... }:
{
  # Keep these around during the migration away from chezmoi and ad-hoc dotfiles.
  xdg.configFile."chezmoi/chezmoi.toml".source = ../files/chezmoi/chezmoi.toml;
  xdg.configFile."nix/nix.conf".source = ../files/nix/nix.conf;

  home.file.".Brewfile".source = ../files/brew/Brewfile;
  home.file.".local/bin/env".source = ../files/local/bin/env;
}
