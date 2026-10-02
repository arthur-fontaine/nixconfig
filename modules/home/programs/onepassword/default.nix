{ pkgs, lib, config, ... }:
let
  # Keys the 1Password SSH agent offers. Git commit signing goes through the
  # same agent (see ../git), so a vault missing here breaks signing.
  agentToml = (pkgs.formats.toml { }).generate "1password-agent.toml" {
    ssh-keys = [
      { vault = "Personal"; }
    ];
  };
in
{
  nixconfig.sync.onepassword-ssh-agent = {
    method = "copy";
    managed = agentToml;
    live = "~/.config/1Password/ssh/agent.toml";
    repo = "modules/home/programs/onepassword/default.nix";
  };

  # Copied with mode 600 instead of symlinked: the Nix store is world-readable
  # and 1Password keeps this directory private.
  home.activation.onepasswordSshAgent = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    dir="${config.xdg.configHome}/1Password/ssh"
    $DRY_RUN_CMD mkdir -p "$dir"
    $DRY_RUN_CMD chmod 700 "${config.xdg.configHome}/1Password" "$dir"
    $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m 600 ${agentToml} "$dir/agent.toml"
  '';
}
