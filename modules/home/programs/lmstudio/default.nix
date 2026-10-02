{ pkgs, lib, config, ... }:
let
  json = pkgs.formats.json { };

  # Smallcast's AI provider points at this port (see ../smallcast).
  httpServerSettings = {
    autoStartOnLaunch = true;
    port = 49281;
    cors = false;
    logSensitiveData = true;
    logIncomingTokens = false;
    verbose = true;
    logLinesLimit = 500;
    networkInterface = "127.0.0.1";
    justInTimeModelLoading = true;
    fileLoggingMode = "succinct";
  };

  # First-run flags, dismissed popups, Hugging Face tokens, and the downloads
  # folder stay out.
  appSettings = {
    language = "en";
    sidebar = {
      showButtonNames = false;
      monochromeSidebarIcons = false;
    };
    configs = {
      expandConfigsOnClick = true;
    };
    chat = {
      showSuggestionsOnNewChat = true;
      allowOnlyOneNewChat = true;
      alwaysShowPromptTemplate = false;
      useShiftEnterToSendMessage = false;
      useKeychordToRegenerate = true;
      unloadPreviousModelOnSelect = true;
      highlightChatMessageOnHover = true;
      doubleClickMessageToEdit = false;
      doubleClickChatCellRenames = false;
      aiNamingMode = "auto";
      autoExpandReasoningBlocks = false;
      reasoningBlocksVignette = true;
      messageGenInfoMode = "lastMessage";
      visualizeSpeculativeDecoding = false;
      chatFullWidth = false;
      neverAskForToolConfirmation = false;
      skipToolConfirmationPatterns = [ ];
      showChatUtilityMenuLabels = true;
      pinnedPlugins = [ ];
      showRoleAndInsertButtons = false;
      scrollLastMessageToTop = "scrollToTopNoLatch";
      showTokenCountInChatListings = false;
      moveDeletedItemsToTrash = true;
      sidebarSort = {
        field = "createdAt";
        direction = "desc";
      };
      showSpringboardWhenClosingAllTabsInSplit = false;
      imageInputs = {
        userMaxImageDimensionPixelsEnabled = true;
        userMaxImageDimensionPixels = 2048;
        ignoreModelPreferredMaxImageDimension = false;
      };
    };
    developer = {
      showExperimentalFeatures = false;
      experimentalLoadPresets = false;
      showDebugInfoBlocksInChat = false;
      showModelDownloadOptionData = false;
      showResourceConsumptionWidget = false;
      backendDownloadChannel = "stable";
      appUpdateChannel = "stable";
      runtimeLogVerbosityLevel = 3;
      allowDevelopmentPlugins = true;
      unloadPreviousJITModelOnLoad = true;
      jitModelTTL = {
        enabled = true;
        ttlSeconds = 3600;
      };
      autoUpdateExtensionPacks = true;
      autoDeleteExtensionPacks = true;
      separateReasoningContentInAPI = true;
      experimentFlags = [ ];
      apiPredictionHistoryEviction = {
        type = "time";
        ttlDays = 30;
      };
    };
    ui = {
      missionControlFullscreen = false;
      showModelFileNameInMyModels = false;
      configureLoadParamsBeforeLoad = false;
      alwaysOpenModelLoaderFromPicker = false;
      contextDisplayMode = "percentage";
      appNavigationBarPosition = "left";
      showTabStripScrollBar = false;
      tabStripFullStripStyle = false;
      openDownloadsPaneOnStartNewModelDownload = false;
    };
    cloudInference = {
      billingContext = {
        type = "personal";
      };
    };
    configPresetInclusiveness = {
      speculativeDecoding = false;
    };
    developerMode = true;
    userInterfaceComplexityLevel = 2;
    autoLoadBundledLLM = true;
    modelLoadingGuardrails = {
      mode = "off";
      customThresholdBytes = 4294967296;
      alwaysAllowLoadAnyway = false;
    };
    promptWhenCommittingUnsavedChangesWithNewFields = false;
    enableLocalService = false;
    useLlamaCppEngineProtocolRuntime3 = true;
    useHFProxy = true;
    defaultContextLength = {
      type = "custom";
      value = 8192;
    };
  };

  httpServer = json.generate "lmstudio-http-server-config.json" httpServerSettings;
  settings = json.generate "lmstudio-settings.json" appSettings;

  # LM Studio rewrites both files, so merge into them instead of replacing.
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
  lmsHome = "${config.home.homeDirectory}/.lmstudio";
in
{
  nixconfig.sync = {
    lmstudio-server = {
      method = "json-merge";
      managed = httpServerSettings;
      live = "~/.lmstudio/.internal/http-server-config.json";
      repo = "modules/home/programs/lmstudio/default.nix (httpServerSettings)";
    };
    lmstudio-settings = {
      method = "json-merge";
      managed = appSettings;
      live = "~/.lmstudio/settings.json";
      repo = "modules/home/programs/lmstudio/default.nix (appSettings)";
      ignore = [
        "^(appFirstLoad|pre030ChatsMigrated|appPostUpdateNotificationPending|downloadsFolder|cliInstalled|appIntroAcceptedForBuild|toggledConfigDropdowns)$"
        "^(dismissed[A-Za-z]+|hf[A-Za-z]+Token)$"
        "^developer\\.attemptedInstallLmsCliOnStartup$"
      ];
    };
  };

  home.activation.lmstudioConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ${merge httpServer "${lmsHome}/.internal/http-server-config.json"}
    ${merge settings "${lmsHome}/settings.json"}
  '';
}
