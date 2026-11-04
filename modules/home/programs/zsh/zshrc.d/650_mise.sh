# `mise activate zsh` prints the same script until mise changes: kept in a cache file and
# sourced, rather than run on every shell start. It still runs `mise hook-env` once, for PATH.
() {
  local bin=$HOME/.local/bin/mise cache=${XDG_CACHE_HOME:-$HOME/.cache}/zsh/mise-activate.zsh
  [[ -x $bin ]] || return
  if [[ ! -s $cache || $bin -nt $cache ]]; then
    [[ -d $cache:h ]] || mkdir -p $cache:h
    $bin activate zsh >| $cache
  fi
  source $cache
}
