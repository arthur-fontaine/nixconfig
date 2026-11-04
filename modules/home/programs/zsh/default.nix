{ lib, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    # ez-compinit (zsh_plugins.txt) runs compinit once, at the first prompt, from a dump kept
    # for a day: home-manager's own `compinit` here rebuilt it on every start.
    completionInit = "";
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;

    initContent = lib.mkMerge [
      (lib.mkBefore (builtins.readFile ./zshrc))
      # home-manager's history block (order 910) runs `mkdir -p "$(dirname "$HISTFILE")"`:
      # two programs on every start for a folder that is always there. Shell functions
      # stand in for them just around it.
      (lib.mkOrder 905 ''
        dirname() { print -r -- ''${1:h} }
        mkdir() { [[ $1 == -p && -d $2 ]] || command mkdir "$@" }
      '')
      (lib.mkOrder 915 "unfunction dirname mkdir")
    ];
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
