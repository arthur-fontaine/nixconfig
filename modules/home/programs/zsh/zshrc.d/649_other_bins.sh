# Add ~/.local/bin to PATH without depending on an external helper file.
case ":${PATH}:" in
  *:"$HOME/.local/bin":*)
    ;;
  *)
    export PATH="$HOME/.local/bin:$PATH"
    ;;
esac
