{ config, lib, ... }:
{
  xdg.configFile."zed/keymap.json".source = ./keymap.json;

  # Copy settings.json instead of symlinking so Zed can write to it
  # (e.g. when installing extensions). Resets to managed version on each activation.
  home.activation.copyZedSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD cp -f ${./settings.json} ${config.xdg.configHome}/zed/settings.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/zed/settings.json
  '';
}
