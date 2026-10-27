{ ... }:
let
  domain = "com.smallcast.app.beta";

  # Smallcast reads these keys with `data(forKey:)`.
  dataKeys = {
    aiConnections = [
      {
        id = "3DB7ADBD-1693-417F-80DA-B8437B92C2A3";
        name = "Llama";
        # Llama.app's server (see ../llama).
        provider = "openAICompatible";
        baseURL = "http://localhost:9931/v1";
        models = [ "LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0" ];
        visionModels = [ ];
      }
    ];
    aiDefaultModel = {
      chatGPT = { model = "gpt-5.6-luna"; effort = "medium"; };
    };
    quickActionModel = {
      codex = { model = "gpt-5.6-luna"; effort = "medium"; };
    };
    extensionAppearances = {
      coffee = { tint = "brown"; symbol = "cup.and.heat.waves"; };
    };
    quickPrompts = [
      {
        id = "64D0E352-6E92-41C6-90A9-E539A0944F37";
        name = "Translate";
        iconSymbol = "translate";
        template = "Translate\n\n~~~\n{argument name=\"text\"}\n~~~\n\nto {argument name=\"language\"}";
        isEnabled = true;
        showsInRootSearch = true;
      }
    ];
    fallbackPresets = [
      {
        id = "92D46321-889A-4066-882D-D3165037A608";
        name = "Translate to English";
        target.quickPrompt._0 = "64D0E352-6E92-41C6-90A9-E539A0944F37";
        values.language = "english";
      }
    ];
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
      # Left over from LM Studio; the current build no longer reads them.
      "^(aiProvider|aiBaseURL)$"
      # AVKit's player state, not a Smallcast setting.
      "^AVDesktopPlaybackControls"
    ];
  };

  targets.darwin.defaults.${domain} = {
    showInMenuBar = true;
    compactMode = true;
    paletteTheme = "liquidGlass";
    supportReminders = false;
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
    disabledFallbacks = [ "command:ai-chat" "command:define" ];
    # Ids are the quick prompt and fallback preset in dataKeys, and a quicklink.
    fallbackOrder = [
      "command:ai-chat"
      "fallback-preset:92d46321-889a-4066-882d-d3165037a608"
      "command:search-files"
      "command:run-shell-command"
      "command:define"
      "quick-prompt:64d0e352-6e92-41c6-90a9-e539a0944f37"
      "quicklink:0371236b-43ce-4e41-b741-8d3b614d2317"
    ];
    launcherSectionOrder = [ "results" "fallbacks" "files" ];
    fileSearchEnabled = true;
    fileSearchEngine = "content";
    calendarEnabled = true;
    calendarMenuBarDisplay = 0;
    quicklinksEnabled = true;
    emojiSuggestionsEnabled = true;
    windowManagementEnabled = true;
    customCommandsEnabled = false;
    extensionsEnabled = true;
    currencyRatesEnabled = true;

    dictationEnabled = true;
    dictationModel = "ultra";
    "hotkey.dictation" = builtins.toJSON { combo._0 = { carbonKeyCode = 96; carbonModifiers = 4096; }; };

    aiEnabled = true;
    aiModel = "LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0";
    aiWebSearch = true;
  };

  nixconfig.defaultsData.${domain} = dataKeys;
}
