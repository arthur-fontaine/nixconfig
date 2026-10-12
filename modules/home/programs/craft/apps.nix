# The storytold Craft apps and how agents reach them. Each `<name>-cli` (from
# Casks/) serves MCP on stdio: `headless` drives an engine of its own with no
# window, `live` drives the app window once `<name>-live` has started it with
# its control port. Ports are the ones each project documents.
{ homeDirectory }:
let
  # PhotoCraft's control channel is the only one with a token. The first
  # `photocraft-live` creates this file (mode 0600); the MCP server reads it.
  photocraftToken = "${homeDirectory}/Library/Application Support/Photocraft/control.token";
  # Without roots PhotoCraft automation can't touch any file.
  photocraftRoots = [
    "--automation-read-root" homeDirectory
    "--automation-write-root" homeDirectory
  ];
in
{
  photocraft = {
    app = "PhotoCraft";
    port = 7878;
    appArgs = [ "--control" "7878" "--control-token-file" photocraftToken ] ++ photocraftRoots;
    headless = [ "mcp" ] ++ photocraftRoots;
    live = [ "mcp" "--bridge" "127.0.0.1:7878" "--control-token-file" photocraftToken ];
  };

  lightcraft = {
    app = "LightCraft";
    port = 7980;
    appArgs = [ "--control" "7980" ];
    headless = [ "mcp" ];
    live = [ "mcp" "--connect" "127.0.0.1:7980" ];
  };

  # With no mode flag the server uses the app when its port answers and falls
  # back to headless, so one server covers both.
  vectorcraft = {
    app = "VectorCraft";
    port = 7979;
    appArgs = [ "--control" "7979" ];
    headless = [ "mcp" ];
    live = null;
  };

  filmcraft = {
    app = "FilmCraft";
    port = 9876;
    appArgs = [ "--control" "9876" ];
    headless = [ "mcp" ];
    live = [ "mcp" "--bridge" "127.0.0.1:9876" ];
  };

  effectcraft = {
    app = "EffectCraft";
    port = 9877;
    appArgs = [ "--control" "9877" ];
    # Checkpoints unsaved headless work, so it survives a server restart.
    headless = [ "mcp" "--autosave" ];
    live = [ "mcp" "--bridge" "9877" ];
  };
}
