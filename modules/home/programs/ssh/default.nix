{ ... }:
{
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;

    # OrbStack's include only works above every Host block. config.local holds
    # hosts that do not belong in this public repo (work bastions and such).
    includes = [
      "~/.orbstack/ssh/config"
      "~/.ssh/config.local"
    ];

    settings."*".IdentityAgent = ''"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"'';
  };
}
