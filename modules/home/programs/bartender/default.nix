{ ... }:
let
  domain = "com.surteesstudios.Bartender";
in
{
  nixconfig.sync.bartender = {
    method = "defaults";
    live = "com.surteesstudios.Bartender";
    repo = "modules/home/programs/bartender/default.nix";
    ignore = [
      "^GoldenGate(Profiles|HiddenItemOrderKeys|AlwaysHiddenItemOrderKeys|ColdStartCatalogV1|AXOwnerFailureLedgerV1|MoveFailureLedgerV1|SelectedProfileID|ProfileSchemaVersion)$"
      "^(AdjustedPrefs|BartenderSeven|bartendersix|onboarding_|shouldShow|isNewUser|ResetPermission|SK2?|MenuBarAgentPreferences|MenuBarColoring|FRFeedback|com\\.surteesstudios)"
      "^NSStatusItem "
      "^SU(FeedURL)$"
    ];
  };

  # Item layout (GoldenGateProfiles, *ItemOrderKeys) stays out: it lists every
  # menu bar item on this Mac, including work-managed agents, by position.
  # Trial state, failure ledgers, and per-display coloring stay out too.
  targets.darwin.defaults.${domain} = {
    "launchAtLogin.isEnabled" = true;
    SimpleLayoutModeEnabled = true;

    GoldenGateMenuBarIcon = "Dot";
    GoldenGateBarItemImageMode = "onlyShown";
    GoldenGateBartenderBarEnabled = false;
    GoldenGateHideBartenderMenuBarItem = false;
    GoldenGateAllowsSystemItemHiding = true;
    GoldenGateShowingHiddenItemsTrigger = "Bar item clicked";

    HideItemsWhenShowingOthers = false;
    HideShownItemsLeaveItemsToRightOfBartender = false;
    HideShownItemsWhen = 2;

    SUAutomaticallyUpdate = false;
    SUEnableAutomaticChecks = true;
    SUSendProfileInfo = false;
  };

  nixconfig.defaultsData.${domain} = {
    GoldenGateNewItemsPlacement = { section = "hidden"; };
    stored_style = {
      baseStyle.standard = { };
      roundBottomofBar = false;
      shadow = false;
      seperatePills = false;
      roundBottomOfScreen = false;
      colors = [ ];
      shape = "bar";
    };
  };
}
