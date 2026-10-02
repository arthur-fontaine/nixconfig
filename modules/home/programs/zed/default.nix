{ config, lib, ... }:
{
  nixconfig.sync = {
    zed-settings = {
      method = "copy";
      managed = ./settings.json;
      live = "~/.config/zed/settings.json";
      repo = "modules/home/programs/zed/settings.json";
    };
    zed-keymap = {
      method = "copy";
      managed = ./keymap.json;
      live = "~/.config/zed/keymap.json";
      repo = "modules/home/programs/zed/keymap.json";
    };
  };

  # Copy settings.json and keymap.json instead of symlinking so Zed can write to them
  # (e.g. when installing extensions). Resets to managed version on each activation.
  home.activation.copyZedSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p ${config.xdg.configHome}/zed
    $DRY_RUN_CMD cp -f ${./settings.json} ${config.xdg.configHome}/zed/settings.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/zed/settings.json
    $DRY_RUN_CMD cp -f ${./keymap.json} ${config.xdg.configHome}/zed/keymap.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/zed/keymap.json
  '';
}
