{ lib, ... }:
let
  domain = "com.smallcast.app.beta";

  # Smallcast reads these three keys with `data(forKey:)`, so they must be
  # written as plist data; `targets.darwin.defaults` has no data type.
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

  writeData = key: value: ''
    run /usr/bin/defaults write ${domain} ${key} -data \
      "$(printf '%s' ${lib.escapeShellArg (builtins.toJSON value)} | /usr/bin/xxd -p | tr -d '\n')"
  '';
in
{
  targets.darwin.defaults.${domain} = {
    showInMenuBar = true;
    compactMode = true;
    webSearchTemplate = "https://duckduckgo.com/?q={query}";
    launcherAliases = {
      "system-action:toggle-system-appearance" = "Dark/light mode";
    };
    "hotkey.togglePalette" = builtins.toJSON { combo._0 = { carbonKeyCode = 49; carbonModifiers = 256; }; };
    "hotkey.toggleEmoji" = builtins.toJSON { combo._0 = { carbonKeyCode = 80; carbonModifiers = 0; }; };

    fallbackCommandsEnabled = true;
    fallbackCommands = [ "search-web" "search-files" "ask-ai" ];
    fileSearchEnabled = true;
    calendarEnabled = true;
    windowManagementEnabled = true;
    customCommandsEnabled = false;
    extensionsEnabled = true;

    aiEnabled = true;
    aiProvider = "lmstudio";
    aiModel = "liquid/lfm2.5-1.2b";
    aiBaseURL = "http://localhost:49281/v1";
    aiWebSearch = true;
  };

  home.activation.smallcastDataDefaults = lib.hm.dag.entryAfter [ "setDarwinDefaults" ]
    (lib.concatStrings (lib.mapAttrsToList writeData dataKeys));
}
