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

        bare-clone = ''
          !f() {
            local url="$1"
            local dir="''${2:-$(basename "$url" .git)}"
            mkdir -p "$dir" && cd "$dir" || return 1
            git clone --bare "$url" .bare || return 1
            echo "gitdir: ./.bare" > .git
            git --git-dir=.bare config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
            git --git-dir=.bare fetch origin
            echo "✓ Bare repo cloned into $(pwd)"
            echo "  Next: git wt <branch-name> [source-branch]"
          }; f'';

        bclone = ''!git bare-clone "$@"'';

        wt = ''
          !f() {
            if [ -z "$1" ]; then
              echo "Usage: git wt <name> [source-branch]"
              echo "  Creates a worktree, reusing the branch if it exists or creating it from source-branch (default: main)"
              return 1
            fi
            local name="$1"
            local base="''${2:-main}"
            local root
            root="$(git rev-parse --path-format=absolute --git-common-dir)/.."
            cd "$root" || return 1
            if git show-ref --verify --quiet "refs/heads/$name"; then
              git worktree add "$name" "$name"
            elif git show-ref --verify --quiet "refs/remotes/origin/$name"; then
              git worktree add --track -b "$name" "$name" "origin/$name"
            else
              git worktree add "$name" -b "$name" "$base"
            fi
          }; f'';
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
