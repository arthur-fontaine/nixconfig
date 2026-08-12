DOTENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/.env"

# Secrets kept out of this repo. `set -a` auto-exports every assignment so the
# file stays plain KEY=VALUE with no `export` prefixes.
if [[ -r "$DOTENV_FILE" ]]; then
  set -a
  source "$DOTENV_FILE"
  set +a
fi

unset DOTENV_FILE
