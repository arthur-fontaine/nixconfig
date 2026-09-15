{ ... }:
{
  # Same keys Droppy's own Settings > Export writes. License, caches, migration
  # flags, and per-machine ids (display and Reminders list UUIDs) stay out.
  targets.darwin.defaults."iordv.Droppy" = {
    startAtLogin = true;
    updateChannel = "beta";
    enableBetaUpdates = true;
    quickActionsMailApp = "systemDefault";
    smartExportConversionReveal = false;
    skipConcealedClipboard = true;

    # Notch and shelf
    enableNotchShelf = true;
    autoExpandShelf = false;
    autoHideOnFullscreen = true;
    hideMediaOnlyOnFullscreen = true;
    hideNotchInMissionControl = true;
    hideNotchOnExternalDisplays = true;
    hidePhysicalNotch = false;
    externalDisplayAdvancedVisibilityEnabled = true;
    shelfSplitModeEnabled = false;
    shelfSurfaceSizePreset = "small";
    shelfWidgetGridRowCount = 1;
    shelfWidgetGridOrder = [ ];
    shelfWidgetGridHiddenTypes = [ ];
    customShelfWidgets = builtins.toJSON {
      version = 1;
      widgets = [ "media" ];
      widthScales = { media = 1; tasksCalendar = 0.73; };
    };
    syncShelfAndBasket = true;
    notchedSurfaceAppearance = "dynamicGlass";
    externalSurfaceAppearance = "dynamicGlass";
    subtleSurfaceOutline = true;
    subtleSurfaceOutlineInRestingState = true;
    favoriteWidgetOne = "none";
    favoriteWidgetTwo = "none";
    favoriteWidgetThree = "none";
    favoriteWidgetFour = "none";

    # Basket
    enableFloatingBasket = true;
    enableMultiBasket = true;
    enableBasketAutoHide = true;
    basketAutoHideDelay = 2.0;

    # HUDs
    enableHUDReplacement = true;
    enableBrightnessHUDReplacement = true;
    enableKeyboardBrightnessKeyHUD = true;
    enableDNDHUD = true;
    enableVolumeKeyFeedbackSound = false;
    showHUDsOnAllDisplays = true;
    hudVolumeColorPreset = "default";
    enableBetterDisplayCompatibility = true;
    enableMultiLiveActivities = true;

    # Lock screen
    enableLockScreenFeatures = true;
    lockScreenMediaArtworkExpanded = true;
    lockScreenMediaMaterial = "liquid";
    lockScreenWidgetMaterial = "liquid";
    lockScreenMotionArtworkFullscreen = false;

    # Media
    mediaHUDPreferredLaunchTarget = "spotify";
    mediaWidgetLiveArtwork = false;
    liveAudioVisualizer = false;
    autoOpenMediaHUDOnShelfExpand = false;

    # Clipboard
    clipboardHistoryLimit = 50;
    clipboardHistoryUnlimited = false;
    clipboardRetentionDays = 0;
    enableClipboardBeta = false;
    emojiPickerEnabled = false;

    # Droplets
    aiCodingHUD_installed = true;
    aiCodingHUD_enabled = true;
    aiCodingHUD_compactPriority = "media";
    extension_removed_aiCodingHUD = false;
    meetingControls_installed = true;
    meetingControls_enabled = true;
    meetingControls_actionOrder = [ "toggleMute" "toggleCamera" "toggleShareScreen" "endCall" ];
    meetingControls_hiddenActions = [ ];
    extension_removed_meetingControls = false;
    todo_installed = true;
    todo_enabled = true;
    todo_syncCalendarEnabled = true;
    todo_syncRemindersEnabled = true;
    extension_removed_todo = false;
  };
}
