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
    # Esc twice on an empty prompt opens Rewind (extensions/rewind), not /tree.
    doubleEscapeAction = "none";
    # Selecting text with the mouse doesn't copy it.
    fullscreenCopyOnSelect = false;
    # As Claude Code's: every interactive session shows in the Claude apps.
    remoteControlAtStartup = true;
    # Keep the conversation in the Claude apps when Pi exits.
    remoteControlArchiveOnQuit = false;
    # Pi's tool_search, for the tools kept out of the first request (exposure "deferred"):
    # pi-subagents' SubagentWorkflow, a quarter of that request on its own (6k tokens).
    defaultTools = [ "+tool_search" ];

    # Pinned: Pi runs package code, so bump the commit after reading the diff.
    packages = [
      # Patched (see piClaudeCode below), so a local path rather than git.
      "${piClaudeCode}"
      # The ask_user_question tool. The remote-control extension answers it
      # from the Claude apps through the package's rpiv:ask-user:* events.
      "npm:@juicesharp/rpiv-ask-user-question@2.15.0"
      # /btw: side conversations that don't enter the main one.
      "npm:pi-btw@0.8.0"
      # /goal: goals with tracked progress and an independent completion auditor.
      "npm:pi-goal-x@0.34.1"
      # Pasted screenshots as [Image #N] markers with clickable links.
      # Patched (see piImageView below), so a local path rather than npm.
      "${piImageView}"
      # Claude Code's subagents: the Agent tool, FleetView, /agents, @agent mentions.
      # Patched (see piSubagents below), so a local path rather than npm.
      "${piSubagents}"
      # Messages between running sessions. Installed only: extensions/intercom
      # loads it without its commands and adds the @session mentions.
      {
        source = "npm:pi-intercom@0.18.1";
        extensions = [ ];
        skills = [ ];
      }
    ];
  };
  # pi-image-view 0.5.0 with patches/pi-image-view-draft-on-submit.patch: Pi empties the editor
  # before the input handlers run, and auto-effort's (ahead of it, waiting on its local model)
  # gave pi-image-view's 250 ms scan the time to see no marker and forget the pasted images,
  # so the prompt went out with "[Image #1]" and no image. No dependencies.
  piImageView = pkgs.runCommand "pi-image-view-0.5.0-patched" { } ''
    mkdir -p $out
    tar xzf ${
      pkgs.fetchurl {
        url = "https://registry.npmjs.org/pi-image-view/-/pi-image-view-0.5.0.tgz";
        hash = "sha256-k/HHsdYH7rxeB0tqozifPYq/xReFDG45trO459+FcVQ=";
      }
    } -C $out --strip-components=1
    patch -d $out -p1 < ${./patches/pi-image-view-draft-on-submit.patch}
  '';
  # @tintinweb/pi-subagents 0.22.1 with patches/pi-subagents-fleet-refresh.patch, until a
  # release fixes FleetView staying hidden for background agents, and
  # patches/pi-subagents-deferred-workflow.patch: SubagentWorkflow's 6k-token description is
  # loaded through tool_search when a workflow is asked for, not sent with every request. Pi doesn't patch npm
  # packages, and a local package brings its own dependencies: croner and nanoid have none.
  piSubagents =
    let
      npm = name: version: hash: pkgs.fetchurl {
        url = "https://registry.npmjs.org/${name}/-/${baseNameOf name}-${version}.tgz";
        inherit hash;
      };
    in
    pkgs.runCommand "pi-subagents-0.22.1-patched" { } ''
      mkdir -p $out/node_modules/croner $out/node_modules/nanoid
      tar xzf ${npm "@tintinweb/pi-subagents" "0.22.1" "sha256-KB8kkjDbiiXsnbizAhByYNH9Ap900jyvVMTyLRXQe3k="} -C $out --strip-components=1
      tar xzf ${npm "croner" "10.0.1" "sha256-1tk8KGEl/tVnuYaldv8dqnTnLVa7Y/4oJIyhfPywDO4="} -C $out/node_modules/croner --strip-components=1
      tar xzf ${npm "nanoid" "5.1.16" "sha256-0/2cvcnmyPlhepLmsGowjFamLHRPdI45PRAgOGbBs/g="} -C $out/node_modules/nanoid --strip-components=1
      patch -d $out -p1 < ${./patches/pi-subagents-fleet-refresh.patch}
      patch -d $out -p1 < ${./patches/pi-subagents-deferred-workflow.patch}
    '';
  # earendil-works/pi-claude-code with patches/pi-claude-code-caller-cache.patch: a caller's own
  # prompt-cache breakpoints on user blocks reach the API (auto-mode places them where Claude
  # Code's classifier does), and a model asked for by full id ("claude-sonnet-5") isn't routed
  # through Claude Code's "sonnet" alias, which now means Sonnet 5.5; a spawn that lands while
  # Claude Code's updater rewrites its binary (ENOEXEC) is tried again; a rewritten request keeps
  # at most the API's four cache breakpoints. With patches/pi-claude-code-status-cache.patch,
  # Pi's startup no longer waits for six `claude auth status` (seconds each): they share
  # one, and the last logged-in answer is kept in ~/.pi/agent/cache. With
  # patches/pi-claude-code-keep-thinking.patch, the signed thinking of earlier turns reaches
  # the API again: Claude Code dropped it from every replayed turn, so the model re-planned
  # from scratch at each tool round (the looping chats). With
  # patches/pi-claude-code-thinking-summary.patch, the thinking comes summarized (the API's
  # default is now omitted, an empty text) for thinking-rows to show. With
  # patches/pi-claude-code-raw-tool-results.patch, tool results go out as Pi has them: Claude Code
  # trimmed the newest one and the next request replayed it untrimmed, which voided the prompt
  # cache from it on (from the system prompt on, past the API's 20-block lookback). No runtime dependencies:
  # its imports are Pi's own packages.
  piClaudeCode = pkgs.runCommand "pi-claude-code-70abb65-patched" { } ''
    cp -r ${
      pkgs.fetchFromGitHub {
        owner = "earendil-works";
        repo = "pi-claude-code";
        rev = "70abb65186592ca788b29b3db22c3160d629c41f";
        hash = "sha256-9BHTz/IRf8jZczVYoXtypepBDmWJ9+5id6hwZUdeSV0=";
      }
    } $out
    chmod -R u+w $out
    patch -d $out -p1 < ${./patches/pi-claude-code-caller-cache.patch}
    patch -d $out -p1 < ${./patches/pi-claude-code-status-cache.patch}
    patch -d $out -p1 < ${./patches/pi-claude-code-keep-thinking.patch}
    patch -d $out -p1 < ${./patches/pi-claude-code-thinking-summary.patch}
    patch -d $out -p1 < ${./patches/pi-claude-code-raw-tool-results.patch}
  '';
  # nedleeds/pi-compact-tools 0.16.7 with patches/pi-compact-tools-claude-bash.patch: bash
  # titles leave the folding of long commands to syntax-highlighting, and an opened command
  # ends with Pi's "Took 4.2s", which auto-mode's note goes beside. Loaded
  # from the extensions folder, not as a package, for its place among them (see
  # extensionsManifest). Its imports are Pi's own packages; its theme isn't loaded.
  piCompactTools = pkgs.runCommand "pi-compact-tools-0.16.7-patched" { } ''
    mkdir -p $out
    tar xzf ${
      pkgs.fetchurl {
        url = "https://registry.npmjs.org/pi-compact-tools/-/pi-compact-tools-0.16.7.tgz";
        hash = "sha256-uK62LedKA/IQNn96HVngeoXhNn4c8sdPJ2jpNx1NTYE=";
      }
    } -C $out --strip-components=1
    patch -d $out -p1 < ${./patches/pi-compact-tools-claude-bash.patch}
  '';
  # Tool rows as Claude Code draws them. compact-tools rewrites the file (/compact-tools),
  # so it is merged, not replaced.
  compactToolsJson = (pkgs.formats.json { }).generate "pi-compact-tools.json" { style = "claude"; };
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
  # pi-subagents' global settings: no widget above the editor, since FleetView under it
  # lists the same agents. Its /agents menu writes the project's .pi/subagents.json, which
  # overrides this file, and never this file.
  subagentsJson = (pkgs.formats.json { }).generate "pi-subagents.json" { widgetMode = "off"; };
  # Cmd+C copies Pi's own selection in fullscreen mode (copy-on-select is off), as in any
  # app; Ghostty passes cmd+c through when it has no selection of its own.
  keybindingsJson = (pkgs.formats.json { }).generate "pi-keybindings.json" {
    # Ctrl+C copies a selection through input-autocomplete's editor, as in Claude Code.
    "app.message.copy" = [ "super+c" ];
  };
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
  # The browser extension draws with image-view's kitty.ts and signs in with remote-control's
  # api.ts (Claude Code's credentials), imported from their folders in the repo; the store copy
  # brings its own, since each extension folder is linked alone.
  browserExtension = pkgs.runCommand "pi-extension-browser" { } ''
    cp -R ${./extensions/browser} $out
    chmod -R u+w $out
    cp ${./extensions/image-view/kitty.ts} $out/kitty.ts
    cp ${./extensions/remote-control/api.ts} $out/remote-control-api.ts
    substituteInPlace $out/index.ts \
      --replace-fail '"../image-view/kitty.ts"' '"./kitty.ts"' \
      --replace-fail '"../remote-control/api.ts"' '"./remote-control-api.ts"'
  '';
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
      # Root cause before any fix: fix workers stacked guesses on bugs they never traced.
      superpowers = pkgs.fetchFromGitHub {
        owner = "obra";
        repo = "superpowers";
        rev = "22f0b463e7a5e579904dd6211a520321035526f7";
        hash = "sha256-rP5YsyGuPd9YSW/Fj3aukrq1bLuV+nwwQMK4JaZQgkI=";
      };
    in
    {
      skill-creator = "${official}/plugins/skill-creator/skills/skill-creator";
      frontend-design = "${official}/plugins/frontend-design/skills/frontend-design";
      eli5 = "${community}/eli5/skills/eli5";
      inherit humanizer;
      systematic-debugging = "${superpowers}/skills/systematic-debugging";
    };

  extensions = {
    remote-control = ./extensions/remote-control;
    auto-effort = ./extensions/auto-effort;
    auto-compact = ./extensions/auto-compact;
    cache-timer = ./extensions/cache-timer;
    cache-warmer = ./extensions/cache-warmer;
    image-view = imageView;
    you-should-know = ./extensions/you-should-know;
    # Claude Code's permission mode "auto", which Claude Code runs in (settings.json).
    auto-mode = ./extensions/auto-mode;
    intercom = ./extensions/intercom;
    # Claude Code's /rename, renaming again when the task changes: the @ names above.
    session-name = ./extensions/session-name;
    # Ctrl+B or `background: true` sends a bash call to the background.
    background-tools = ./extensions/background-tools;
    # Claude Haiku suggests how to continue the prompt, as dim text Tab inserts.
    input-autocomplete = ./extensions/input-autocomplete;
    # The files each bash call changed, as a diff under its output.
    bash-changes = ./extensions/bash-changes;
    # Bash commands and their output in the theme's colours, embedded code included.
    syntax-highlighting = ./extensions/syntax-highlighting;
    # Tool rows as Claude Code draws them: "⦁ Bash(ls)", then "⎿ " and the output.
    compact-tools = piCompactTools;
    # Pi's startup header without its "Pi can explain its own features" line.
    startup-header = ./extensions/startup-header;
    # Claude Code's /rewind (Esc twice), and /restore to bring rewound prompts back.
    rewind = ./extensions/rewind;
    # Herdr's Info panel: labels the terminal with its session file, keeps the Claude usage.
    herdr-session = ./extensions/herdr-session;
    # Messages from `hc send` go to the agent (a steer mid-run), not into the draft.
    hc-inbox = ./extensions/hc-inbox;
    # A resumed session shows its whole conversation, each compaction where it happened.
    full-history = ./extensions/full-history;
    # Pi's footer as two lines: where you are, then what's going on.
    footer = ./extensions/footer;
    # web_search and web_fetch through TinyFish, and view_image to look at a URL's image.
    web = ./extensions/web;
    # Claude Code's Claude in Chrome tools, through the Claude in Chrome bridge, with the
    # tab playing as a video in a picture-in-picture view while Pi uses the browser.
    browser = browserExtension;
    # Commands run in the environment of an interactive shell in the session's folder,
    # direnv's included, however Pi was started (Herdr, `hc run`).
    shell-env = ./extensions/shell-env;
    # Thinking as a tool-like row: "⦁ Thinking (3.2k tokens · 12s)", not nothing.
    thinking-rows = ./extensions/thinking-rows;
    # Long bash commands named in plain words by Claude Haiku, cached by command.
    bash-titles = ./extensions/bash-titles;
    # Tool rows drawn faint, apart from the agent's own words.
    tool-rows-faint = ./extensions/tool-rows-faint;
    # Voice calls (/call, Ctrl+Alt+V): local turn detection, Whisper and Voxtral in the
    # pi-voice daemon below; the written answers stay exactly as they are.
    voice = ./extensions/voice;
  };
  piVoice = import ./voice.nix { inherit pkgs lib; };
  # Pi loads the folder's extensions in directory order, unsorted, and each tool renderer
  # wraps those of the extensions loaded after it. A manifest fixes the order: these first,
  # so that what they add to a row (auto-mode's note, background-tools' detached rows,
  # bash-changes' diff, syntax-highlighting's colors, image-view's images) goes on
  # compact-tools' Claude-style rows, then the rest by name. One loaded after compact-tools
  # would hand it its own view of the row, which compact-tools shows once opened.
  wrappersOfCompactTools = [
    # First, so it fades the whole row, what the others add included.
    "tool-rows-faint"
    "auto-mode"
    "background-tools"
    "bash-changes"
    "syntax-highlighting"
    "image-view"
    "compact-tools"
  ];
  extensionsManifest = (pkgs.formats.json { }).generate "pi-extensions-package.json" {
    name = "pi-extensions";
    private = true;
    pi.extensions = map (
      name: if name == "compact-tools" then "./${name}/extensions/compact-tools.ts" else "./${name}/index.ts"
    ) (wrappersOfCompactTools ++ lib.subtractLists wrappersOfCompactTools (lib.attrNames extensions));
  };
  skills = pluginSkills // {
    context7-mcp = ../claude/skills/context7-mcp;
    run-and-verify = ./skills/run-and-verify;
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

  # `with-lease <name> <command>`: runs the command once no other agent holds <name> (a
  # physical device, say), so parallel workers take turns. mkdir is atomic; the lease goes
  # when the command ends, and one left by a crash goes after 30 minutes without refresh.
  home.packages = [
    # The voice extension starts `pi-voice serve`, which starts `pi-voice-audio`.
    piVoice.daemon
    piVoice.audio
    (pkgs.writeShellScriptBin "with-lease" ''
      set -eu
      [ $# -ge 2 ] || { echo "usage: with-lease <name> <command...>" >&2; exit 2; }
      d="''${LEASE_DIR:-$HOME/.cache/leases}/$1"; shift
      mkdir -p "$(dirname "$d")"
      until mkdir "$d" 2>/dev/null; do
        if [ -n "$(find "$d" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rm -rf "$d"; continue; fi
        echo "with-lease: waiting for $(basename "$d"), held by $(cat "$d/owner" 2>/dev/null || echo '?')" >&2
        sleep 10
      done
      echo "''${HC_TERMINAL_ID:-pid $$}: $*" > "$d/owner"
      # Refresh the lease while this shell lives; no output, so it holds no pipe open.
      (while kill -0 $$ 2>/dev/null; do touch "$d"; sleep 60; done) >/dev/null 2>&1 &
      trap 'rm -rf "$d"' EXIT INT TERM
      "$@"
    '')
  ];

  # The same global instructions as Claude Code. Pi has no rules/ directory,
  # so Claude Code's rules are appended to them. Extensions and skills are each
  # one link to the declared set, so anything else in those folders goes, as
  # Homebrew removes what the config doesn't list (piReplaceUnmanaged).
  home.file = {
    ".pi/agent/AGENTS.md".text = lib.concatStringsSep "\n" [
      (builtins.readFile ../claude/CLAUDE.md)
      (builtins.readFile ../claude/rules/context7.md)
      (builtins.readFile ./AGENTS.pi.md)
    ];
    ".pi/agent/extensions".source = pkgs.linkFarm "pi-extensions" (
      extensions // { "package.json" = extensionsManifest; }
    );
    # Role prompts for the orchestrator chats Herdr's sidebar opens on a worktree or a
    # project click (pi --append-system-prompt).
    ".pi/agent/orchestrator".source = ./orchestrator;
    ".pi/agent/skills".source = pkgs.linkFarm "pi-skills" skills;
  };

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
    ${merge subagentsJson "${config.home.homeDirectory}/.pi/agent/subagents.json"}
    ${merge keybindingsJson "${config.home.homeDirectory}/.pi/agent/keybindings.json"}
    ${merge compactToolsJson "${config.home.homeDirectory}/.pi/agent/compact-tools.json"}
  '';

  # Before home-manager links the two folders: a real folder in their place
  # (from Pi used without this config) would block the link.
  home.activation.piReplaceUnmanaged = lib.hm.dag.entryBefore [ "checkLinkTargets" ] ''
    for dir in "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/skills"; do
      if [ -d "$dir" ] && [ ! -L "$dir" ]; then
        $DRY_RUN_CMD rm -rf "$dir"
      fi
    done
  '';

  # Packages too: Pi keeps a checkout of each git package it ever installed.
  # And Pi from mise, before it moved to Homebrew, would shadow Homebrew's.
  home.activation.piPrunePackages =
    let
      gitDirs = lib.concatMap (
        p:
        let
          m = builtins.match "git:([^@]+)(@.*)?" (if builtins.isString p then p else p.source);
        in
        lib.optional (m != null) (lib.head m)
      ) settings.packages;
    in
    lib.hm.dag.entryAfter [ "piSettings" ] ''
      for repo in "$HOME"/.pi/agent/git/*/*/*; do
        [ -d "$repo" ] || continue
        case " ${toString gitDirs} " in
          *" ''${repo#"$HOME"/.pi/agent/git/} "*) ;;
          *) $DRY_RUN_CMD rm -rf "$repo" ;;
        esac
      done
      [ -d "$HOME/.pi/agent/git" ] && $DRY_RUN_CMD find "$HOME/.pi/agent/git" -mindepth 1 -type d -empty -delete
      if PATH="${pkgs.mise}/bin:$PATH" mise ls --installed npm:@mariozechner/pi-coding-agent 2>/dev/null | grep -q .; then
        PATH="${pkgs.mise}/bin:$PATH" $DRY_RUN_CMD mise uninstall --all npm:@mariozechner/pi-coding-agent
      fi
    '';

  # Claude Code's sessions, copied into Pi's session store so /resume lists them
  # (Pi only resumes its own). Incremental, and never overwrites a copy that was
  # continued in Pi; see the script.
  home.activation.piImportClaudeSessions = lib.hm.dag.entryAfter [ "piSettings" ] ''
    $DRY_RUN_CMD ${pkgs.nodejs}/bin/node ${./import-claude-sessions.mjs} --thinking ${settings.defaultThinkingLevel} \
      || echo "warning: importing Claude Code sessions into Pi failed" >&2
  '';
}
