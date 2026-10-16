{ pkgs, lib, config, ... }:
let
  apps = import ./apps.nix { inherit (config.home) homeDirectory; };

  # A Dock launch opens no port. `<name>-live` starts the app with its control
  # port so the `<name>-live` MCP server can drive it.
  launcher = name: craft: pkgs.writeShellScriptBin "${name}-live" ''
    app="/Applications/${craft.app}.app"
    if /usr/bin/nc -z 127.0.0.1 ${toString craft.port} 2>/dev/null; then
      exec /usr/bin/open -a "$app"
    fi
    if /usr/bin/pgrep -qf "$app/Contents/MacOS/"; then
      echo "${craft.app} is running without its control port. Quit it, then run ${name}-live again." >&2
      exit 1
    fi
    ${lib.optionalString (name == "photocraft") ''/bin/mkdir -p "$HOME/Library/Application Support/Photocraft"''}
    exec /usr/bin/open -a "$app" --args ${lib.escapeShellArgs craft.appArgs}
  '';

  server = name: args: {
    type = "stdio";
    command = "/opt/homebrew/bin/${name}-cli";
    inherit args;
  };
in
{
  home.packages = lib.mapAttrsToList launcher apps;

  nixconfig.claudeMcpServers = lib.concatMapAttrs (name: craft: {
    ${name} = server name craft.headless;
    "${name}-live" = server name craft.live;
  }) apps;
}
