{ pkgs, lib, config, ... }:
let
  toml = pkgs.formats.toml { };
  settings = {
    model = "gpt-5.6-terra";
    model_reasoning_effort = "medium";

    desktop = {
      conversationDetailMode = "STEPS_PROSE";
      followUpQueueMode = "queue";
      dock-icon-preference = "app-default";
      open-link-in-target-preference = "external-browser";
    };

    features.js_repl = false;

    plugins = {
      "google-calendar@openai-curated" = { enabled = true; };
      "gmail@openai-curated" = { enabled = true; };
      "github@openai-curated" = { enabled = true; };
    };

    notice = {
      model_migrations = {
        "gpt-5.3-codex" = "gpt-5.4";
      };
    };
  };
  configFile = toml.generate "codex-config.toml" settings;

  mergeScript = pkgs.writeScript "merge-codex-config.py" ''
    #!${pkgs.python3.withPackages (ps: [ ps.toml ])}/bin/python3
    import sys, os, toml

    dest, src = sys.argv[1], sys.argv[2]

    with open(src) as f:
        nix_config = toml.load(f)

    if os.path.exists(dest) and not os.path.islink(dest):
        try:
            with open(dest) as f:
                existing = toml.load(f)
        except Exception:
            existing = {}
        merged = {**existing, **nix_config}
    else:
        merged = nix_config

    tmp = dest + ".tmp"
    with open(tmp, "w") as f:
        toml.dump(merged, f)
    os.replace(tmp, dest)
  '';
in
{
  nixconfig.sync.codex = {
    method = "toml-merge";
    managed = settings;
    live = "~/.config/codex/config.toml";
    repo = "modules/home/programs/codex/default.nix";
    # Trusted project paths, marketplaces, and what the ChatGPT app adds for
    # computer use are machine state.
    ignore = [ "^(projects|marketplaces|mcp_servers|notify|shell_environment_policy)$" ];
  };

  home.activation.codexConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    config_dir="${config.xdg.configHome}/codex"
    config_file="$config_dir/config.toml"
    $DRY_RUN_CMD mkdir -p "$config_dir"
    $DRY_RUN_CMD ${mergeScript} "$config_file" ${configFile}
  '';
}
