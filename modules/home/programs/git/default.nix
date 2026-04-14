{ lib, gitName ? null, gitEmail ? null, gitSigningKey ? null, ... }:
let
  hasSigningKey = gitSigningKey != null && gitSigningKey != "";
in
{
  programs.git = {
    enable = true;

    settings = {
      user =
        lib.optionalAttrs (gitName != null && gitName != "") { name = gitName; }
        // lib.optionalAttrs (gitEmail != null && gitEmail != "") { email = gitEmail; }
        // lib.optionalAttrs hasSigningKey { signingkey = gitSigningKey; };

      alias = {
        adog = "log --all --decorate --oneline --graph";
      };

      url."ssh://git@github.com/".insteadOf = "https://github.com/";

      merge.conflictstyle = "zdiff3";
      push.autoSetupRemote = true;
    }
    // lib.optionalAttrs hasSigningKey {
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
