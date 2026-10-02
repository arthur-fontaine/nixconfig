{ ... }:
let
  domain = "com.smallcast.app.beta";

  # Smallcast reads these three keys with `data(forKey:)`.
  dataKeys = {
    aiConnections = [
      {
        id = "3DB7ADBD-1693-417F-80DA-B8437B92C2A3";
        name = "";
        provider = "lmStudio";
        baseURL = "http://localhost:49281/v1";
        models = [ "liquid/lfm2.5-1.2b" ];
        visionModels = [ ];
      }
    ];
    aiDefaultModel = {
      chatGPT = { model = "gpt-5.6-luna"; effort = "medium"; };
    };
    extensionAppearances = {
      coffee = { tint = "brown"; symbol = "cup.and.heat.waves"; };
    };
  };
in
{
  nixconfig.sync.smallcast = {
    method = "defaults";
    live = "com.smallcast.app.beta";
    repo = "modules/home/programs/smallcast/default.nix";
    ignore = [
      "^bound[A-Za-z]+IDs$"
      "^(aiInstalledProviders|customCommands|AppleShowScrollBars)$"
    ];
  };

  targets.darwin.defaults.${domain} = {
    showInMenuBar = true;
    compactMode = true;
    webSearchTemplate = "https://duckduckgo.com/?q={query}";
    hiddenLauncherItems = [ "com.anthropic.claude-code-url-handler" ];
    launcherAliases = {
      "system-action:toggle-system-appearance" = "Dark/light mode";
    };
    "hotkey.togglePalette" = builtins.toJSON { combo._0 = { carbonKeyCode = 49; carbonModifiers = 256; }; };
    "hotkey.toggleEmoji" = builtins.toJSON { combo._0 = { carbonKeyCode = 80; carbonModifiers = 0; }; };
    "hotkey.command:search-emoji" = builtins.toJSON { combo._0 = { carbonKeyCode = 80; carbonModifiers = 0; }; };

    fallbackCommandsEnabled = true;
    fallbackCommands = [ "search-web" "search-files" "ask-ai" ];
    fileSearchEnabled = true;
    calendarEnabled = true;
    calendarMenuBarDisplay = 0;
    quicklinksEnabled = true;
    emojiSuggestionsEnabled = true;
    windowManagementEnabled = true;
    customCommandsEnabled = false;
    extensionsEnabled = true;

    aiEnabled = true;
    aiProvider = "lmstudio";
    aiModel = "liquid/lfm2.5-1.2b";
    aiBaseURL = "http://localhost:49281/v1";
    aiWebSearch = true;
  };

  nixconfig.defaultsData.${domain} = dataKeys;
}
