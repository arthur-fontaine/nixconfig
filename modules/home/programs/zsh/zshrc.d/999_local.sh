# Local, unsynced shell functions and aliases. This repo owns the loader only;
# the files it sources are yours and stay out of git.
for _local_rc in "${XDG_CONFIG_HOME:-$HOME/.config}"/zsh/local.d/*.sh(N); do
  source "$_local_rc"
done
unset _local_rc
