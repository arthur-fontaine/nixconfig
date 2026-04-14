{ pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;
    dotDir = ".config/zsh";
    initExtraFirst = builtins.readFile ./files/zsh/zshrc;
  };

  home.packages = with pkgs; [ zsh ];
}
