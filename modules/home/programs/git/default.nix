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

        # No "$@" here: git appends the alias args automatically, so passing
        # them explicitly would forward each arg twice (the second copy landed
        # in bare-clone's optional [dir] slot, making it mkdir the whole URL).
        bclone = ''!git bare-clone'';

        binit = ''
          !f() {
            if [ -z "$1" ]; then
              echo "Usage: git binit <name>"
              echo "  Initializes an empty bare repo (.bare + .git pointer) in <name>/, same layout as git bclone"
              return 1
            fi
            local dir="$1"
            mkdir -p "$dir" && cd "$dir" || return 1
            git init --bare --initial-branch=main .bare || return 1
            echo "gitdir: ./.bare" > .git
            echo "✓ Bare repo initialized in $(pwd)"
            echo "  Next: git wt <branch-name>"
          }; f'';

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
            elif git rev-parse --verify --quiet "$base" >/dev/null; then
              git worktree add "$name" -b "$name" "$base"
            else
              # No commits yet (e.g. fresh git binit): start an orphan worktree
              git worktree add --orphan -b "$name" "$name"
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
