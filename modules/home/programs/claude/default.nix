{ pkgs, lib, config, ... }:
let
  settingsJson = (pkgs.formats.json { }).generate "claude-settings.json" {
    permissions.defaultMode = "auto";

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

    effortLevel = "xhigh";
    tui = "fullscreen";
    theme = "auto";
    preferredNotifChannel = "terminal_bell";
    skipDangerousModePermissionPrompt = true;
    skipAutoPermissionPrompt = true;
    skipWorkflowUsageWarning = true;
  };
in
{
  # Copy settings.json and skills instead of symlinking so Claude Code can
  # write to them (toggling plugins, changing theme via /config, skill-creator
  # adding skills). Managed files reset to this repo's version on each
  # activation; runtime state lives in ~/.claude/settings.local.json and
  # ~/.claude.json, which are left untouched.
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
  '';
}
