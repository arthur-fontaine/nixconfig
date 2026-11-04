{ config, lib, pkgs, ... }:
let
  # `direnv hook zsh` prints the same script every time: generated once here and sourced,
  # instead of home-manager's `eval "$(direnv hook zsh)"`, a process on every shell start.
  zshHook = pkgs.runCommand "direnv-hook.zsh" { } ''
    ${lib.getExe config.programs.direnv.package} hook zsh > $out
  '';
in
{
  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
    enableZshIntegration = false;
  };

  programs.zsh.initContent = lib.mkAfter "source ${zshHook}";
}
