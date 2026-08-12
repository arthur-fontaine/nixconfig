{ pkgs, lib, config, ... }:
let
  settingsJson = (pkgs.formats.json { }).generate "claude-settings.json" {
    permissions.defaultMode = "auto";
    model = "opus[1m]";

    enabledPlugins = {
      "skill-creator@claude-plugins-official" = true;
      "playwright@claude-plugins-official" = true;
      "ralph-loop@claude-plugins-official" = true;
      "rust-analyzer-lsp@claude-plugins-official" = true;
      "figma@claude-plugins-official" = true;
      "typescript-lsp@claude-plugins-official" = true;
      "frontend-design@claude-plugins-official" = true;
    };

    extraKnownMarketplaces."callstack-agent-skills".source = {
      source = "github";
      repo = "callstackincubator/agent-skills";
    };

    effortLevel = "medium";
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
  mcpServersJson = (pkgs.formats.json { }).generate "claude-mcp-servers.json" {
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
in
{
  # Copy settings.json and skills instead of symlinking so Claude Code can
  # write to them (toggling plugins, changing theme via /config, skill-creator
  # adding skills). Managed files reset to this repo's version on each
  # activation; runtime state lives in ~/.claude/settings.local.json and
  # ~/.claude.json, of which only the mcpServers entries below are managed.
  home.activation.claudeConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    claude_dir="${config.home.homeDirectory}/.claude"
    $DRY_RUN_CMD mkdir -p "$claude_dir/skills/context7-mcp" "$claude_dir/rules"

    $DRY_RUN_CMD cp -f ${settingsJson} "$claude_dir/settings.json"
    $DRY_RUN_CMD chmod u+w "$claude_dir/settings.json"

    $DRY_RUN_CMD cp -f ${./CLAUDE.md} "$claude_dir/CLAUDE.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/CLAUDE.md"

    $DRY_RUN_CMD cp -f ${./skills/context7-mcp/SKILL.md} "$claude_dir/skills/context7-mcp/SKILL.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/skills/context7-mcp/SKILL.md"

    $DRY_RUN_CMD cp -f ${./rules/context7.md} "$claude_dir/rules/context7.md"
    $DRY_RUN_CMD chmod u+w "$claude_dir/rules/context7.md"

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
