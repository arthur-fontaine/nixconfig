{ ... }:
{
  programs.git = {
    enable = true;

    settings = {
      user = {
        name = "Arthur Fontaine";
        email = "0arthur.fontaine@gmail.com";
        signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFqXVHTP+AGPqko54gq4iXtlDTiut2G6gT05KRiwxOpY";
      };

      alias = {
        adog = "log --all --decorate --oneline --graph";
      };

      url."ssh://git@github.com/".insteadOf = "https://github.com/";

      merge.conflictstyle = "zdiff3";
      
      push.autoSetupRemote = true;

      gpg = {
        format = "ssh";
        "ssh".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      };
      commit.gpgsign = true;
    };

    lfs.enable = true;
  };

  programs.delta = {
    enable = true;
    enableGitIntegration = true;
    options = {
      dark = true;
      navigate = true;
    };
  };
}
