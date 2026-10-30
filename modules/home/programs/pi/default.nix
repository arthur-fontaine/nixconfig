{ pkgs, lib, config, ... }:
let
  settings = {
    # Claude Pro/Max through the Claude Code CLI (`claude -p`), so requests
    # count against the subscription. claude-opus-5-5 runs as Claude Code's
    # `opus[1m]`.
    defaultProvider = "claude-code";
    defaultModel = "claude-opus-5-5";
    defaultThinkingLevel = "high";

    # Pinned: Pi runs package code, so bump the commit after reading the diff.
    packages = [
      "git:github.com/earendil-works/pi-claude-code@70abb65186592ca788b29b3db22c3160d629c41f"
      # The ask_user_question tool. The remote-control extension answers it
      # from the Claude apps through the package's rpiv:ask-user:* events.
      "npm:@juicesharp/rpiv-ask-user-question@2.15.0"
    ];
  };
  settingsJson = (pkgs.formats.json { }).generate "pi-settings.json" settings;
  settingsPath = "${config.home.homeDirectory}/.pi/agent/settings.json";
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
in
{
  nixconfig.sync.pi-settings = {
    method = "json-merge";
    managed = settings;
    live = "~/.pi/agent/settings.json";
    repo = "modules/home/programs/pi/default.nix";
    ignore = [ "^lastChangelogVersion$" ];
  };

  home.file.".pi/agent/extensions/remote-control".source = ./extensions/remote-control;

  # Pi writes settings.json itself (/model, /settings), so merge into a
  # writable copy. The old config symlinked it into the store: start over.
  home.activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -L "${settingsPath}" ] && [[ "$(readlink "${settingsPath}")" == /nix/store/* ]]; then
      $DRY_RUN_CMD rm "${settingsPath}"
    fi
    ${merge settingsJson settingsPath}
  '';
}
