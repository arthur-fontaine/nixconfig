fpath+=( "$HOME/.config/zsh/completions" )

if [[ ! -d "$HOME/.config/zsh/completions/_bun" ]] && command -v bun &> /dev/null; then
  bun completions zsh &> ~/.config/zsh/completions/_bun
fi

if [[ ! -d "$HOME/.config/zsh/completions/_codex" ]] && command -v codex &> /dev/null; then
  codex completion zsh &> ~/.config/zsh/completions/_codex
fi
