rebuild()
{
  local dir="${NIXCONFIG_REPO_DIR:-$HOME/nixconfig}"
  git -C "$dir" pull --ff-only || return 1
  sudo darwin-rebuild switch --flake "path:$dir#${NIXCONFIG_HOST:-$(hostname -s)}" "$@"
}
