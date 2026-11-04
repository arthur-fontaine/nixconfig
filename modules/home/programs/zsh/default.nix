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

  # antidote is a zsh function, not a command: bundled by a zsh that loads it.
  home.activation.installZshGeneratedFiles = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    antidote=/opt/homebrew/opt/antidote/share/antidote/antidote.zsh
    if [ -r "$antidote" ]; then
      ${pkgs.zsh}/bin/zsh -c 'source "$1" && antidote bundle < "$2" >| "$3.tmp" && mv "$3.tmp" "$3"' \
        zsh "$antidote" "$HOME/.config/zsh/zsh_plugins.txt" "$HOME/.config/zsh/zsh_plugins.zsh" \
        || echo "warning: antidote could not bundle the zsh plugins" >&2
    fi
  '';
}
