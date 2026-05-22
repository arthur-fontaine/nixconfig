{ config, lib, ... }:
{
  # Copy settings.json and keymap.json instead of symlinking so Zed can write to them
  # (e.g. when installing extensions). Resets to managed version on each activation.
  home.activation.copyZedSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD cp -f ${./settings.json} ${config.xdg.configHome}/zed/settings.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/zed/settings.json
    $DRY_RUN_CMD cp -f ${./keymap.json} ${config.xdg.configHome}/zed/keymap.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/zed/keymap.json
  '';
}
