rebuild()
{
  sudo darwin-rebuild switch --flake "path:${NIXCONFIG_REPO_DIR:-$HOME/nixconfig}#${NIXCONFIG_HOST:-$(hostname -s)}" "$@"
}
