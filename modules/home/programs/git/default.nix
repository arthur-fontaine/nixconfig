{ ... }:
{
  programs.git = {
    enable = true;

    userName = "Arthur Fontaine";
    userEmail = "0arthur.fontaine@gmail.com";

    aliases = {
      adog = "log --all --decorate --oneline --graph";
    };

    delta = {
      enable = true;
      options = {
        dark = true;
        navigate = true;
      };
    };

    lfs.enable = true;

    extraConfig = {
      user.signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFqXVHTP+AGPqko54gq4iXtlDTiut2G6gT05KRiwxOpY";
      merge.conflictstyle = "zdiff3";
      push.autoSetupRemote = true;
      gpg.format = "ssh";
      gpg."ssh".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      commit.gpgsign = true;
      url."ssh://git@github.com/".insteadOf = "https://github.com/";
    };
  };
}
