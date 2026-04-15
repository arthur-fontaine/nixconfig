{ pkgs, ... }:
let
  toml = pkgs.formats.toml { };
in
{
  xdg.configFile."codex/config.toml".source = toml.generate "codex-config.toml" {
    model = "gpt-5.4";
    model_reasoning_effort = "high";

    plugins = {
      "google-calendar@openai-curated" = { enabled = true; };
      "gmail@openai-curated" = { enabled = true; };
      "github@openai-curated" = { enabled = true; };
    };

    projects = {};

    notice = {
      model_migrations = {
        "gpt-5.3-codex" = "gpt-5.4";
      };
    };
  };
}
