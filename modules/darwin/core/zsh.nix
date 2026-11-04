{ ... }:
{
  # Completions are set up once, by ez-compinit in the user's zshrc (modules/home/programs/zsh),
  # with a dump kept for a day. The global compinit ran a full one before it on every shell,
  # and its prompt theme is replaced by Powerlevel10k anyway.
  programs.zsh = {
    enableGlobalCompInit = false;
    promptInit = "";
  };
}
