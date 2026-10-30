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

  mcpServers = config.nixconfig.claudeMcpServers;
  mcpJson = (pkgs.formats.json { }).generate "pi-mcp.json" { inherit mcpServers; };
  mcpPath = "${config.home.homeDirectory}/.pi/agent/mcp.json";
  merge = import ../../lib/merge-json.nix { inherit pkgs; };

  # The skills of the Claude Code plugins in ../claude, at the commits Claude
  # Code installed.
  pluginSkills =
    let
      official = pkgs.fetchFromGitHub {
        owner = "anthropics";
        repo = "claude-plugins-official";
        rev = "f8c5e7a1dcb71b10cb74586224b5401f3de5db28";
        hash = "sha256-lmJbRtHsAN/rxqzm5hzxxu8lx+iiqRCtocJ7YET03Lg=";
      };
      community = pkgs.fetchFromGitHub {
        owner = "anthropics";
        repo = "claude-plugins-community";
        rev = "f4c9452f5ca091f1be7064d9faab1b001ea21645";
        hash = "sha256-iKvIn5H0+zoAB9svNl3v2Mss3akRF2WqiokgzcidegU=";
      };
      humanizer = pkgs.fetchFromGitHub {
        owner = "blader";
        repo = "humanizer";
        rev = "523374dee72d67c7b2b5f858ea0094ffda49c3ac";
        hash = "sha256-qJIMwaas5Wnz270rUbPa4E5v2GQ62SQ1rKT0jmjYhyw=";
      };
      figma = pkgs.fetchFromGitHub {
        owner = "figma";
        repo = "mcp-server-guide";
        rev = "f2789420e7e8b4e2465dfeb1e12e1fc6a31397e5";
        hash = "sha256-0VOSMv6RQrSWC2oRKMaZJQAKm8Z7zuWyEXL6djxtYZ0=";
      };
    in
    {
      skill-creator = "${official}/plugins/skill-creator/skills/skill-creator";
      frontend-design = "${official}/plugins/frontend-design/skills/frontend-design";
      eli5 = "${community}/eli5/skills/eli5";
      inherit humanizer;
      # One folder per skill inside.
      figma = "${figma}/skills";
    };
in
{
  nixconfig.sync.pi-settings = {
    method = "json-merge";
    managed = settings;
    live = "~/.pi/agent/settings.json";
    repo = "modules/home/programs/pi/default.nix";
    ignore = [ "^lastChangelogVersion$" ];
  };

  nixconfig.sync.pi-mcp-servers = {
    method = "json-merge";
    managed = { inherit mcpServers; };
    live = "~/.pi/agent/mcp.json";
    repo = "modules/home/programs/pi/default.nix (mcpServers)";
  };

  # The same global instructions as Claude Code. Pi has no rules/ directory,
  # so Claude Code's rules are appended to them.
  home.file = {
    ".pi/agent/AGENTS.md".text = lib.concatStringsSep "\n" [
      (builtins.readFile ../claude/CLAUDE.md)
      (builtins.readFile ../claude/rules/context7.md)
    ];
    ".pi/agent/skills/context7-mcp".source = ../claude/skills/context7-mcp;
    ".pi/agent/extensions/remote-control".source = ./extensions/remote-control;
  } // lib.mapAttrs' (name: src: lib.nameValuePair ".pi/agent/skills/${name}" { source = src; }) pluginSkills;

  # Pi writes settings.json itself (/model, /settings), so merge into a
  # writable copy. The old config symlinked it into the store: start over.
  home.activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -L "${settingsPath}" ] && [[ "$(readlink "${settingsPath}")" == /nix/store/* ]]; then
      $DRY_RUN_CMD rm "${settingsPath}"
    fi
    ${merge settingsJson settingsPath}

    # Pi saves exposure and enabled changes to mcp.json, so merge into it too.
    ${merge mcpJson mcpPath}
  '';
}
