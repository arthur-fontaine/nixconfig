{ ... }:
{
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    lastChangelogVersion = "0.66.1";
    defaultProvider = "openai-codex";
    defaultModel = "gpt-5.4";
    defaultThinkingLevel = "high";
    quietStartup = true;
    theme = "light";
    packages = [ "git:github.com/MasuRii/pi-rtk-optimizer" ];
  };

  home.file.".pi/agent/nono-sandbox.json".text = builtins.toJSON {
    enabled = true;
    readWritePaths = [ "~/.pi/agent/extensions/" ];
  };

  home.file.".pi/agent/extensions".source = ./extensions;
}
