{ pkgs, lib, config, ... }:
let
  # Blender Lab's MCP server. It runs nothing itself: every tool goes over TCP
  # to the add-on below, inside a Blender window or a `blender --background`.
  version = "1.0.3";

  blenderApp = "/Applications/Blender.app";
  blender = "${blenderApp}/Contents/MacOS/Blender";

  # Blender's add-on listens on 9876 by default, which is FilmCraft's port.
  livePort = 9878;

  python = pkgs.python3;

  blenderMcp = python.pkgs.buildPythonApplication {
    pname = "blender-mcp";
    inherit version;
    pyproject = true;

    src = pkgs.fetchgit {
      url = "https://projects.blender.org/lab/blender_mcp.git";
      rev = "v${version}";
      hash = "sha256-pYeByO4Oi5eyynsJhGVd1vBWXHvhGn+Y5LGit6Kazlw=";
    };
    sourceRoot = "blender_mcp/mcp";

    build-system = [ python.pkgs.setuptools ];
    dependencies = with python.pkgs; [ docutils mcp pyyaml ] ++ mcp.optional-dependencies.cli;
  };

  addonZip = pkgs.fetchurl {
    url = "https://projects.blender.org/lab/blender_mcp/releases/download/v${version}/mcp-${version}.zip";
    hash = "sha256-p6nagWGSUC5aCiAqOWRE4ma0fY/E90rUaYBIvUMEBwc=";
  };
  addonModule = "bl_ext.user_default.mcp";

  # Starts a windowless Blender for this server alone, on a free port, so
  # several Claude sessions don't share one scene, and stops it on exit.
  headless = pkgs.writeShellScript "blender-mcp-headless" ''
    port=$(${python}/bin/python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
    "${blender}" --background --online-mode --command blender_mcp --port "$port" </dev/null >&2 &
    pid=$!
    trap 'kill "$pid" 2>/dev/null' EXIT
    for _ in $(seq 60); do
      /usr/bin/nc -z 127.0.0.1 "$port" 2>/dev/null && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    BLENDER_MCP_PORT=$port ${blenderMcp}/bin/blender-mcp
  '';

  # Auto-start is off (see the activation below), so a Dock launch opens no
  # port. This starts Blender with the add-on listening for blender-live.
  startLive = ''
    import bpy
    def start():
        bpy.context.preferences.addons["${addonModule}"].preferences.port = ${toString livePort}
        bpy.ops.blmcp.server_start()
    bpy.app.timers.register(start, first_interval=1.0)
  '';
  # A Blender window, not the background ones the headless server starts.
  guiRunning = "/bin/ps -axo command= | /usr/bin/grep -F '${blender}' | /usr/bin/grep -v -e --background -e grep | /usr/bin/grep -q .";
  launcher = pkgs.writeShellScriptBin "blender-live" ''
    if /usr/bin/nc -z 127.0.0.1 ${toString livePort} 2>/dev/null; then
      exec /usr/bin/open -a "${blenderApp}"
    fi
    if ${guiRunning}; then
      echo "Blender is running without its MCP server. Quit it, then run blender-live again." >&2
      exit 1
    fi
    # -n: a background Blender counts as a running instance, and open would
    # otherwise hand it the arguments instead of starting a window.
    exec /usr/bin/open -n -a "${blenderApp}" --args --online-mode --python-expr ${lib.escapeShellArg startLive}
  '';

  serverEnv.BLENDER_PATH = blender;
in
{
  home.packages = [ launcher ];

  nixconfig.claudeMcpServers = {
    blender = {
      type = "stdio";
      command = "${headless}";
      env = serverEnv;
    };
    blender-live = {
      type = "stdio";
      command = "${blenderMcp}/bin/blender-mcp";
      env = serverEnv // { BLENDER_MCP_PORT = toString livePort; };
    };
  };

  # Installs the add-on into the installed Blender version's user extensions
  # and turns its auto-start off. Reruns when the add-on or Blender's version
  # changes, because each Blender version keeps its own extensions.
  home.activation.blenderMcpAddon = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -x "${blender}" ]; then
      marker="${config.xdg.stateHome}/nixconfig/blender-mcp-addon"
      version=$(/usr/bin/defaults read "${blenderApp}/Contents/Info.plist" CFBundleShortVersionString)
      config_dir="$HOME/Library/Application Support/Blender/''${version%.*}/config"
      want="$version ${addonZip}"
      if [ "$(cat "$marker" 2>/dev/null)" = "$want" ]; then
        :
      # Writing prefs first would stop Blender offering to import the previous
      # version's settings on its first launch.
      elif [ ! -d "$config_dir" ]; then
        echo "Open Blender ''${version%.*} once, then rebuild to install its MCP add-on." >&2
      # An open window saves its own prefs on quit, over the ones written here.
      elif ${guiRunning}; then
        echo "Quit Blender, then rebuild to install its MCP add-on." >&2
      else
        echo "Installing the Blender MCP add-on..."
        if $DRY_RUN_CMD "${blender}" --background --command extension install-file --repo user_default --enable ${addonZip} >/dev/null \
          && $DRY_RUN_CMD "${blender}" --background --python-expr \
            'import bpy; bpy.context.preferences.addons["${addonModule}"].preferences.use_autostart = False; bpy.ops.wm.save_userpref()' >/dev/null; then
          $DRY_RUN_CMD mkdir -p "$(dirname "$marker")"
          $DRY_RUN_CMD printf '%s' "$want" > "$marker"
        else
          echo "warning: could not install the Blender MCP add-on" >&2
        fi
      fi
    fi
  '';
}
