{ lib, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;

    initContent = lib.mkBefore (builtins.readFile ./zshrc);
  };

  xdg.configFile."zsh/zsh_plugins.txt".source = ./zsh_plugins.txt;
  xdg.configFile."zsh/zshrc.d".source = ./zshrc.d;
  xdg.configFile."zsh/completions".source = ./completions;

  home.file.".p10k.zsh".source = ./p10k.zsh;

  home.packages = [ pkgs.zsh ];

  home.activation.installZshGeneratedFiles = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
    if command -v antidote >/dev/null 2>&1; then
      antidote bundle < "$HOME/.config/zsh/zsh_plugins.txt" > "$HOME/.config/zsh/zsh_plugins.zsh"
    fi
  '';
}
