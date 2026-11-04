# thefuck's alias, made on first use: `thefuck --alias` is a Python start (most of a second)
# that every shell paid for.
fuck() {
  unfunction fuck
  eval "$(thefuck --alias)"
  fuck "$@"
}
