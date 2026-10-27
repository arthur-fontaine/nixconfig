{ pkgs, ... }:
let
  mbxConfig = (pkgs.formats.toml { }).generate "mbx-config.toml" {
    # Experimental: dev builds go through blaze (installed by mise), which
    # rebuilds an edited function without Cargo.
    blaze = true;
  };
in
{
  nixconfig.sync.mbx = {
    method = "copy";
    managed = mbxConfig;
    live = "~/Library/Application Support/mbx/config.toml";
    repo = "modules/home/programs/mbx/default.nix";
  };

  # mbx reads its global config from dirs::config_dir(), which on macOS is
  # Application Support, not ~/.config.
  home.file."Library/Application Support/mbx/config.toml".source = mbxConfig;

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
