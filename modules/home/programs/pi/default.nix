{ pkgs, lib, config, ... }:
let
  settings = {
    # Claude Pro/Max through the Claude Code CLI (`claude -p`), so requests
    # count against the subscription. claude-opus-5-5 runs as Claude Code's
    # `opus[1m]`.
    defaultProvider = "claude-code";
    defaultModel = "claude-opus-5-5";
    defaultThinkingLevel = "high";

    # Pi's light theme or its dark one, switched live as the terminal reports
    # its appearance. Ghostty and Zed follow macOS, so Pi does too, like
    # Claude Code's theme "auto".
    theme = "light/dark";

    # The cache-warmer extension keeps idle caches warm, like the Claude Code
    # mod. Pi's own warming is off: it takes claude-code models' cache for
    # 5 minutes (it is 1 hour) and would replay long runs through `claude -p`.
    cacheWarming = "off";
    # As Claude Code's pluginConfigs.cache-warmer: compact every session it
    # kept warm when its warm window ends, not only those above 500k.
    cacheWarmer.minCompactContextK = 100;

    # Pinned: Pi runs package code, so bump the commit after reading the diff.
    packages = [
      "git:github.com/earendil-works/pi-claude-code@70abb65186592ca788b29b3db22c3160d629c41f"
      # The ask_user_question tool. The remote-control extension answers it
      # from the Claude apps through the package's rpiv:ask-user:* events.
      "npm:@juicesharp/rpiv-ask-user-question@2.15.0"
      # /btw: side conversations that don't enter the main one.
      "npm:pi-btw@0.8.0"
      # /goal: goals with tracked progress and an independent completion auditor.
      "npm:pi-goal-x@0.34.1"
      # Pasted screenshots as [Image #N] markers with clickable links.
      "npm:pi-image-view@0.5.0"
      # Messages between running sessions. Installed only: extensions/intercom
      # loads it without its commands and adds the @session mentions.
      {
        source = "npm:pi-intercom@0.18.1";
        extensions = [ ];
        skills = [ ];
      }
    ];
  };
  settingsJson = (pkgs.formats.json { }).generate "pi-settings.json" settings;
  settingsPath = "${config.home.homeDirectory}/.pi/agent/settings.json";

  # The MCP servers Claude Code has: those other modules contribute through
  # nixconfig.claudeMcpServers, and the claude module's own two. ${VAR}
  # expands at connect time, from ~/.config/.env.
  mcpServers = config.nixconfig.claudeMcpServers // {
    context7 = {
      url = "https://mcp.context7.com/mcp";
      headers."CONTEXT7_API_KEY" = "\${CONTEXT7_API_KEY}";
    };
    excalidraw = {
      url = "https://api.excalidraw.com/api/v1/mcp";
      headers."Authorization" = "Bearer \${EXCALIDRAW_API_TOKEN}";
    };
  };
  mcpJson = (pkgs.formats.json { }).generate "pi-mcp.json" { inherit mcpServers; };

  # auto-effort's decision model, as Claude Code's AUTO_EFFORT_PROVIDER: Nisev,
  # served by the llama.cpp build in modules/darwin/llama-cpp.nix. The extension
  # keeps its on/off state in the same file, so it is merged, not replaced.
  autoEffort = { config.provider = "nisev"; };
  autoEffortJson = (pkgs.formats.json { }).generate "pi-auto-effort.json" autoEffort;
  # Likewise auto-compact's, as Claude Code's AUTO_COMPACT_PROVIDER: Spisev.
  autoCompactJson = (pkgs.formats.json { }).generate "pi-auto-compact.json" { provider = "spisev"; };
  mcpPath = "${config.home.homeDirectory}/.pi/agent/mcp.json";
  merge = import ../../lib/merge-json.nix { inherit pkgs; };

  # The Quick Look helper Claude Code's image-view mod uses, built the same way
  # from the same source (so the same store path), into the extension's bin/.
  quicklook = pkgs.swiftPackages.stdenv.mkDerivation {
    pname = "quicklook";
    version = "0.1.0";
    src = ../claude/mods/image-view/quicklook;
    nativeBuildInputs = [ pkgs.swift ];
    buildPhase = "swiftc -O main.swift -o quicklook";
    installPhase = "install -Dm755 quicklook $out/bin/quicklook";
  };
  imageView = pkgs.runCommand "pi-extension-image-view" { } ''
    cp -R ${./extensions/image-view} $out
    chmod -R u+w $out
    mkdir -p $out/bin
    cp ${quicklook}/bin/quicklook $out/bin/quicklook
  '';

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
    in
    {
      skill-creator = "${official}/plugins/skill-creator/skills/skill-creator";
      frontend-design = "${official}/plugins/frontend-design/skills/frontend-design";
      eli5 = "${community}/eli5/skills/eli5";
      inherit humanizer;
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
    ".pi/agent/extensions/auto-effort".source = ./extensions/auto-effort;
    ".pi/agent/extensions/auto-compact".source = ./extensions/auto-compact;
    ".pi/agent/extensions/cache-timer".source = ./extensions/cache-timer;
    ".pi/agent/extensions/cache-warmer".source = ./extensions/cache-warmer;
    ".pi/agent/extensions/image-view".source = imageView;
    ".pi/agent/extensions/you-should-know".source = ./extensions/you-should-know;
    # Claude Code's permission mode "auto", which Claude Code runs in (settings.json).
    ".pi/agent/extensions/auto-mode".source = ./extensions/auto-mode;
    ".pi/agent/extensions/intercom".source = ./extensions/intercom;
    # Ctrl+B or `background: true` sends a bash call to the background.
    ".pi/agent/extensions/background-tools".source = ./extensions/background-tools;
    # Claude Haiku suggests how to continue the prompt, as dim text Tab inserts.
    ".pi/agent/extensions/input-autocomplete".source = ./extensions/input-autocomplete;
    # The files each bash call changed, as a diff under its output.
    ".pi/agent/extensions/bash-changes".source = ./extensions/bash-changes;
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
    ${merge autoEffortJson "${config.home.homeDirectory}/.pi/agent/auto-effort.json"}
    ${merge autoCompactJson "${config.home.homeDirectory}/.pi/agent/auto-compact/config.json"}
  '';

  # Claude Code's sessions, copied into Pi's session store so /resume lists them
  # (Pi only resumes its own). Incremental, and never overwrites a copy that was
  # continued in Pi; see the script.
  home.activation.piImportClaudeSessions = lib.hm.dag.entryAfter [ "piSettings" ] ''
    $DRY_RUN_CMD ${pkgs.nodejs}/bin/node ${./import-claude-sessions.mjs} --thinking ${settings.defaultThinkingLevel} \
      || echo "warning: importing Claude Code sessions into Pi failed" >&2
  '';
}
