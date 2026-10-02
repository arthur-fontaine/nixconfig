{ config, lib, ... }:
{
  xdg.configFile."nvim/init.lua".source = ./init.lua;
  xdg.configFile."nvim/lua" = {
    source = ./lua;
    recursive = true;
  };

  # lazy.nvim rewrites the lockfile on :Lazy update, so copy it instead of
  # symlinking it. Resets to the managed version on each activation.
  home.activation.copyNeovimLockfile = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p ${config.xdg.configHome}/nvim
    $DRY_RUN_CMD cp -f ${./lazy-lock.json} ${config.xdg.configHome}/nvim/lazy-lock.json
    $DRY_RUN_CMD chmod u+w ${config.xdg.configHome}/nvim/lazy-lock.json
  '';
}
