{ pkgs, lib, config, ... }:
let
  apps = import ./apps.nix { inherit (config.home) homeDirectory; };

  # A Dock launch opens no port. `<name>-live` starts the app with its control
  # port so the `<name>-live` MCP server can drive it; that server runs it
  # itself on its first call.
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

  cli = name: "/opt/homebrew/bin/${name}-cli";

  server = name: args: {
    type = "stdio";
    command = cli name;
    inherit args;
  };

  # Claude Code starts every server with the session, before any app is open;
  # see live-mcp.py.
  liveMcp = pkgs.writeScript "craft-live-mcp" ''
    #!${pkgs.python3}/bin/python3
    ${builtins.readFile ./live-mcp.py}
  '';

  liveServer = name: craft: {
    type = "stdio";
    command = "${liveMcp}";
    args = [
      "--label" craft.app
      "--headless-server" name
      "--port" (toString craft.port)
      "--launcher" "${launcher name craft}/bin/${name}-live"
      "--fallback" (builtins.toJSON ([ (cli name) ] ++ craft.headless))
      "--"
      (cli name)
    ] ++ craft.live;
  };
in
{
  home.packages = lib.mapAttrsToList launcher apps;

  nixconfig.claudeMcpServers = lib.concatMapAttrs (name: craft: {
    ${name} = server name craft.headless;
    "${name}-live" = liveServer name craft;
  }) apps;
}
