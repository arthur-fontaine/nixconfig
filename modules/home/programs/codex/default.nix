{ pkgs, lib, config, ... }:
let
  toml = pkgs.formats.toml { };
  configFile = toml.generate "codex-config.toml" {
    model = "gpt-5.4";
    model_reasoning_effort = "high";

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
  home.activation.codexConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    config_dir="${config.xdg.configHome}/codex"
    config_file="$config_dir/config.toml"
    $DRY_RUN_CMD mkdir -p "$config_dir"
    $DRY_RUN_CMD ${mergeScript} "$config_file" ${configFile}
  '';
}
