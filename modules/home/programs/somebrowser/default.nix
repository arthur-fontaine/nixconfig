{ ... }:
let
  domain = "dev.somebrowser.browser";
in
{
  nixconfig.sync.somebrowser = {
    method = "defaults";
    live = domain;
    repo = "modules/home/programs/somebrowser/default.nix";
    ignore = [
      "^NS(NavPanel|OSP)"
      "^com\\.apple\\."
    ];
  };

  # Settings are `setting.<key>` (keys are declared in each feature.json), stored
  # as JSON data and only while they differ from the default. Per-site settings
  # and the session live in ~/Library/Application Support/Some Browser and are
  # not managed.
  nixconfig.defaultsData.${domain} = {
    "setting.search.engine" = "google";
  };
}
