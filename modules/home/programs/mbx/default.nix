{ pkgs, ... }:
{
  # mbx (mr-boxington) itself is installed by mise; see modules/home/programs/mise.
  #
  # mbx behaves like Cargo only when started through a shim named `cargo`
  # (the same launcher `mbx setup` writes). We ship that shim declaratively
  # instead of running `mbx setup`, which would try to edit the read-only mise
  # config. The shim must stay off PATH: mbx strips the shim's directory from
  # PATH for the whole build. zsh aliases `cargo` to it (behind sfw) in
  # zshrc.d/707_sfw_aliases.sh.
  xdg.dataFile."mbx-cargo-shim/cargo".source = pkgs.writeShellScript "cargo" ''
    export MBX_CARGO_SHIM_MODE=1 MBX_CARGO_SHIM_PATH="$0"
    exec mbx "$@"
  '';
}
