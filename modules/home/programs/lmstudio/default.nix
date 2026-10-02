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

  # Each entry is what `lms ls --json` reports as the model's `path`: Hub models
  # are `owner/model@variant`, Hugging Face ones `owner/repo/file`.
  models = [
    "google/gemma-4-12b-qat@q4_0"
    "google/gemma-4-e2b@q4_k_m"
    "liquid/lfm2.5-1.2b@8bit"
    "qwen/qwen3.5-4b@q4_k_m"
    "zai-org/glm-4.6v-flash@4bit"
    "LiquidAI/LFM2.5-VL-1.6B-Extract-GGUF/LFM2.5-VL-1.6B-Extract-Q8_0.gguf"
    "LiquidAI/LFM2.5-VL-450M-Extract-GGUF/LFM2.5-VL-450M-Extract-Q8_0.gguf"
    "lmstudio-community/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf"

    # Embeddings
    "awhiteside/CodeRankEmbed-Q8_0-GGUF/coderankembed-q8_0.gguf"
    "keisuke-miyako/harrier-oss-v1-270m-gguf-q8_0/harrier-oss-v1-270m-Q8_0.gguf"
    "Mungert/nomic-embed-code-GGUF/nomic-embed-code-q8_0.gguf"
    "nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf"
    "Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
  ];

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

  # `lms get` takes ~1.5s even for a model that is already there, so only call
  # it for models missing from `lms ls`. The app installs lms on first launch.
  home.activation.lmstudioModels = lib.hm.dag.entryAfter [ "lmstudioConfig" ] ''
    lms="${lmsHome}/bin/lms"
    if [ -x "$lms" ]; then
      present="$("$lms" ls --json 2>/dev/null | ${pkgs.jq}/bin/jq -r '.[].path' || true)"
      while IFS= read -r model; do
        [ -n "$model" ] || continue
        printf '%s\n' "$present" | grep -qxF "''${model%@*}" && continue

        case "$model" in
          */*/*)
            repo="$(printf '%s' "$model" | cut -d/ -f1-2)"
            file="$(printf '%s' "$model" | cut -d/ -f3-)"
            source="https://huggingface.co/$repo/blob/main/$file"
            ;;
          *) source="$model" ;;
        esac

        echo "Downloading LM Studio model $model"
        run "$lms" get "$source" --yes </dev/null || echo "Failed to download $model" >&2
      done <<'EOF'
    ${lib.concatStringsSep "\n" models}
    EOF
    else
      echo "Skipping LM Studio models: launch LM Studio once to install lms"
    fi
  '';
}
