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
    # The default, pinned so the choice is recorded. The app deletes a setting
    # set back to its default, so after that the report shows it `missing`.
    "setting.peek.trigger" = "click";
  };
}
