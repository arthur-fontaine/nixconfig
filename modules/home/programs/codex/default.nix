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

    projects = {
      "/Users/arthur-fontaine/Developer/code/github.com/arthur-fontaine/vscode-autotyper" = {
        trust_level = "trusted";
      };
      "/Users/arthur-fontaine/Developer/code/github.com/arthur-fontaine/fcose-rs" = {
        trust_level = "trusted";
      };
    };

    notice = {
      model_migrations = {
        "gpt-5.3-codex" = "gpt-5.4";
      };
    };
  };
}
