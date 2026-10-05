{ pkgs, lib, config, ... }:
let
  # The user-scope plugins to keep installed. Activation uninstalls any other;
  # set one to false to keep it installed but disabled.
  enabledPlugins = {
    "skill-creator@claude-plugins-official" = true;
    "playwright@claude-plugins-official" = true;
    "ralph-loop@claude-plugins-official" = true;
    "rust-analyzer-lsp@claude-plugins-official" = true;
    "figma@claude-plugins-official" = true;
    "typescript-lsp@claude-plugins-official" = true;
    "frontend-design@claude-plugins-official" = true;
    "humanizer@humanizer" = true;
    "swift-lsp@claude-plugins-official" = true;
    "eli5@claude-community" = true;
    "auto-effort@auto-effort-dev" = true;
    # Built-in mod, off by default: a side agent that flags what you might miss.
    "cc-plugin-you-should-know@builtin" = true;
  };

  settingsJson = (pkgs.formats.json { }).generate "claude-settings.json" {
    permissions.defaultMode = "auto";
    model = "opus[1m]";

    inherit enabledPlugins;

    extraKnownMarketplaces = {
      "callstack-agent-skills".source = {
        source = "github";
        repo = "callstackincubator/agent-skills";
      };

      "humanizer".source = {
        source = "github";
        repo = "blader/humanizer";
      };

      "claude-community".source = {
        source = "github";
        repo = "anthropics/claude-plugins-community";
      };

      # Third-party marketplaces don't auto-update by default; this one is mine.
      "auto-effort-dev" = {
        source = {
          source = "github";
          repo = "arthur-fontaine/cc-mod-auto-effort";
        };
        autoUpdate = true;
      };
    };

    # auto-effort's local decision model, served by the llama.cpp build in
    # modules/darwin/llama-cpp.nix. Without a provider the mod does nothing.
    env.AUTO_EFFORT_PROVIDER = "nisev";

    effortLevel = "medium";

    modelSettings = {
      "claude-fable-5-1".effortLevel = "medium";
      "claude-opus-5".effortLevel = "medium";
      "claude-opus-5-5".effortLevel = "high";
    };

    advisorModel = "fable";
    tui = "fullscreen";
    theme = "auto";
    preferredNotifChannel = "terminal_bell";
    remoteControlAtStartup = true;
    inputNeededNotifEnabled = true;
    agentPushNotifEnabled = true;
    skipDangerousModePermissionPrompt = true;
    skipAutoPermissionPrompt = true;
    skipWorkflowUsageWarning = true;
  };

  # User-scope MCP servers. Claude Code expands ${VAR} in these at connect
  # time, so tokens stay in ~/.config/.env (see zshrc.d/902_dotenv.sh) rather
  # than in this repo.
  mcpServers = {
    context7 = {
      type = "http";
      url = "https://mcp.context7.com/mcp";
      headers."CONTEXT7_API_KEY" = "\${CONTEXT7_API_KEY}";
    };

    excalidraw = {
      type = "http";
      url = "https://api.excalidraw.com/api/v1/mcp";
      headers."Authorization" = "Bearer \${EXCALIDRAW_API_TOKEN}";
    };
  };
  mcpServersJson = (pkgs.formats.json { }).generate "claude-mcp-servers.json" mcpServers;

  # Mods that aren't in a marketplace. Claude Code loads every folder in
  # ~/.claude/skills that has a .claude-plugin/plugin.json, as <name>@skills-dir.
  localMods = {
    cache-timer = {
      src = ./mods/cache-timer;
      repo = "modules/home/programs/claude/mods/cache-timer";
      files = [ ".claude-plugin/plugin.json" "hooks/hooks.json" "hooks/register.js" ];
    };

    # Copy of jarrodwatts/claude-image-view that also draws in Zed's terminal,
    # which has no graphics protocol. See its README.
    image-view = {
      src = ./mods/image-view;
      repo = "modules/home/programs/claude/mods/image-view";
      files = [
        ".claude-plugin/plugin.json"
        "hooks/hooks.json"
        "hooks/register.tsx"
        "hooks/layout.ts"
        "hooks/halfblock.ts"
        "types/index.d.ts"
      ];
    };

    # Upstream installs it with degit into ~/.claude/skills; bump `rev` to update.
    cache-warmer = {
      src = "${pkgs.fetchFromGitHub {
        owner = "samyakjain0606";
        repo = "awesome-learning-material";
        rev = "b66754081dbf93eedadc7470b9e1f419c06232ff";
        hash = "sha256-1FhnSXuRkwfvl9/cguobKqznudsK0vh7dZTpdtMwfm4=";
      }}/cache-warmer";
      repo = "modules/home/programs/claude/default.nix (localMods.cache-warmer, upstream)";
      files = [ ".claude-plugin/plugin.json" "hooks/hooks.json" "hooks/register.ts" "types/index.d.ts" ];
    };
  };

  declaredPluginsJson = (pkgs.formats.json { }).generate "claude-declared-plugins.json" (lib.attrNames enabledPlugins);
in
{
  nixconfig.sync = lib.concatMapAttrs (name: mod: lib.listToAttrs (map (file: {
    name = "claude-mod-${name}-${file}";
    value = {
      method = "copy";
      managed = "${mod.src}/${file}";
      live = "~/.claude/skills/${name}/${file}";
      inherit (mod) repo;
    };
  }) mod.files)) localMods // {
    claude-settings = {
      method = "copy";
      managed = settingsJson;
      live = "~/.claude/settings.json";
      repo = "modules/home/programs/claude/default.nix (settingsJson)";
    };
    claude-md = {
      method = "copy";
      managed = ./CLAUDE.md;
      live = "~/.claude/CLAUDE.md";
      repo = "modules/home/programs/claude/CLAUDE.md";
    };
    claude-rule-context7 = {
      method = "copy";
      managed = ./rules/context7.md;
      live = "~/.claude/rules/context7.md";
      repo = "modules/home/programs/claude/rules/context7.md";
    };
    claude-skill-context7 = {
      method = "copy";
      managed = ./skills/context7-mcp/SKILL.md;
      live = "~/.claude/skills/context7-mcp/SKILL.md";
      repo = "modules/home/programs/claude/skills/context7-mcp/SKILL.md";
    };
    claude-mcp-servers = {
      method = "json-merge";
      managed = { inherit mcpServers; };
      live = "~/.claude.json";
      repo = "modules/home/programs/claude/default.nix (mcpServers)";
      # Everything outside mcpServers is Claude Code's own state.
      ignore = [ "^(?!mcpServers\\.)" ];
    };
  };

  # Copy settings.json and skills instead of symlinking so Claude Code can
  # write to them (toggling plugins, changing theme via /config, skill-creator
  # adding skills). Managed files reset to this repo's version on each
  # activation; runtime state lives in ~/.claude/settings.local.json and
  # ~/.claude.json, of which only the mcpServers entries below are managed.
  home.activation.claudeConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    claude_dir="${config.home.homeDirectory}/.claude"
    $DRY_RUN_CMD mkdir -p "$claude_dir/skills/context7-mcp" "$claude_dir/rules"

    # Uninstall user-scope plugins enabledPlugins doesn't list, as Homebrew's
    # zap cleanup does for casks. Project and local installs are left alone.
    # Before settings.json is copied, because uninstalling rewrites it.
    claude_bin=/opt/homebrew/bin/claude
    installed="$claude_dir/plugins/installed_plugins.json"
    if [ -x "$claude_bin" ] && [ -f "$installed" ]; then
      ${pkgs.jq}/bin/jq -r --slurpfile declared ${declaredPluginsJson} '
        .plugins // {} | to_entries[]
        | select(any(.value[]; .scope == "user"))
        | .key
        | select(. as $id | $declared[0] | index($id) | not)
      ' "$installed" | while read -r plugin; do
        echo "Uninstalling undeclared Claude Code plugin $plugin"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/timeout 60 "$claude_bin" plugin uninstall "$plugin" < /dev/null > /dev/null \
          || echo "warning: could not uninstall $plugin" >&2
      done
    fi

    $DRY_RUN_CMD cp -f ${settingsJson} "$claude_dir/settings.json"
    $DRY_RUN_CMD chmod u+w "$claude_dir/settings.json"

    $DRY_RUN_CMD cp -f ${./CLAUDE.md} "$claude_dir/CLAUDE.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/CLAUDE.md"

    $DRY_RUN_CMD cp -f ${./skills/context7-mcp/SKILL.md} "$claude_dir/skills/context7-mcp/SKILL.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/skills/context7-mcp/SKILL.md"

    $DRY_RUN_CMD cp -f ${./rules/context7.md} "$claude_dir/rules/context7.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/rules/context7.md"

    # Replaced whole, so a file dropped upstream doesn't linger. Writable
    # because Claude Code writes generated types into the mods it loads.
    ${lib.concatStrings (lib.mapAttrsToList (name: mod: ''
      $DRY_RUN_CMD rm -rf "$claude_dir/skills/${name}"
      $DRY_RUN_CMD mkdir -p "$claude_dir/skills/${name}"
      $DRY_RUN_CMD cp -R ${mod.src}/. "$claude_dir/skills/${name}"
      $DRY_RUN_CMD chmod -R u+w "$claude_dir/skills/${name}"
    '') localMods)}

    # ~/.claude.json is Claude Code's own runtime state, so merge the managed
    # MCP servers into it instead of rewriting it. Servers added by hand (via
    # `claude mcp add`) survive; the managed keys are reset on each activation.
    # The temp file sits next to the target so the replacement is atomic.
    claude_json="${config.home.homeDirectory}/.claude.json"
    if [ ! -e "$claude_json" ]; then
      $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m 600 /dev/null "$claude_json"
      $DRY_RUN_CMD ${pkgs.coreutils}/bin/tee "$claude_json" <<< '{}' > /dev/null
    fi
    if ${pkgs.jq}/bin/jq -e . "$claude_json" > /dev/null 2>&1; then
      merged="$(${pkgs.coreutils}/bin/mktemp "$claude_json.XXXXXX")"
      if ${pkgs.jq}/bin/jq --slurpfile managed ${mcpServersJson} \
           '.mcpServers = ((.mcpServers // {}) + $managed[0])' \
           "$claude_json" > "$merged"; then
        $DRY_RUN_CMD mv -f "$merged" "$claude_json"
      fi
      rm -f "$merged"
    else
      echo "warning: $claude_json is not valid JSON, skipping MCP server merge" >&2
    fi
  '';
}
