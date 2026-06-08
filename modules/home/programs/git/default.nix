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
              echo "  Creates a worktree, reusing the branch if it exists or creating it from source-branch (default: the repo's default branch)"
              return 1
            fi
            local name="$1"
            local base="$2"
            local root
            root="$(git rev-parse --path-format=absolute --git-common-dir)/.."
            cd "$root" || return 1
            if git show-ref --verify --quiet "refs/heads/$name"; then
              git worktree add "$name" "$name"
            elif git show-ref --verify --quiet "refs/remotes/origin/$name"; then
              git worktree add --track -b "$name" "$name" "origin/$name"
            elif ! git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
              # No commits yet (e.g. fresh git binit): start an orphan worktree
              git worktree add --orphan -b "$name" "$name"
            else
              # New branch off a base. Default to the repo's actual default
              # branch instead of a hardcoded "main": when the default was
              # something else (master, develop, …) "main" failed to resolve
              # and we silently fell through to an empty --orphan worktree.
              if [ -z "$base" ]; then
                base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
                base="''${base#origin/}"
                [ -z "$base" ] && base="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
              fi
              if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1; then
                echo "git wt: base branch '$base' not found" >&2
                return 1
              fi
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
