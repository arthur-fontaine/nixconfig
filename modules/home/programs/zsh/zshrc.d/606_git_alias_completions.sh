# Completions for custom git aliases defined in modules/home/programs/git.
#
# Zsh's _git completion dispatches to `_git-<alias>` functions when present,
# so defining them here is enough — no compdef needed.

_git-bare-clone() {
  _arguments \
    '1:url:' \
    '2:directory:_files -/'
}

_git-bclone() {
  _git-bare-clone
}

_git-binit() {
  _arguments \
    '1:name:_files -/'
}

_git-wt() {
  _arguments \
    '1:branch:__git_branch_names' \
    '2:source branch:__git_branch_names'
}
