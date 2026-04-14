mkcd()
{
  all_args=("$@")
  remove_last_arg=${all_args[@]:0:$((${#all_args[@]}-1))}
  mkdir_opts="${remove_last_arg[@]}"
  last_arg="${@: -1}"
  mkdir $mkdir_opts $last_arg && cd $last_arg
}
