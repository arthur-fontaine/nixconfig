function ??() {
  local prompt="Give me a bash command to $1. Only output the raw command without formatting."
  local command

  command=$(pi -p "$prompt" --model github-copilot/claude-haiku-4.5:minimal)

  printf "\n\033[1mGenerated command:\033[0m\n"
  printf "\033[36m%s\033[0m\n\n" "$command"
  printf "Do you want to run this command? \033[33m[y/N]\033[0m "

  local old_stty
  old_stty=$(stty -g)

  stty -icanon min 1 time 0 -echo
  answer=$(dd bs=1 count=1 2>/dev/null)
  stty "$old_stty"

  printf "\033[33m%s\033[0m\n\n" "$answer"

  if [[ "$answer" =~ [Yy] ]]; then
    printf "\033[32mRunning command...\033[0m\n\n"
    eval "$command"
  else
    printf "\033[33mSkipped.\033[0m\n"
  fi
}
