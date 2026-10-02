{ ... }:
{
  nixconfig.sync.protonvpn = {
    method = "defaults";
    live = "ch.protonvpn.mac";
    repo = "modules/home/programs/protonvpn/default.nix";
    ignore = [
      "@"
      "^(DynamicBugReport|FeatureFlags|IntentionallyDisconnected|Last[A-Za-z]+|LaunchedBefore|MaintenanceServerRefreshIntereval|MapWidth|NSInitialToolTipDelay|RatingSettings|ServerChangeConfig|ShowWhatsNew[A-Za-z_0-9]*|SmartProtocolConfig|TSKVendorIdentifier|UserAccountCreationDate|UserLocation|Welcomed|WireguardConfig|firstLaunchReported|isSubsequentLaunch|lastAnnouncementRefreshDate|streaming[A-Za-z]+|telemetry\\.settings\\.key|userAccountCreationDate|userRole|userTier)$"
      "^protoncore\\."
      "^NSStatusItem "
    ];
  };

  # Per-account settings (NetShield, VPN Accelerator, LAN exclusion,
  # telemetry) are stored under keys suffixed with the account email, so they
  # stay out of this public repo. So do the cached location and server data.
  targets.darwin.defaults."ch.protonvpn.mac" = {
    StartOnBoot = true;
    StartMinimized = true;
    AutoConnect = false;
    ConnectOnDemand = true;
    Firewall = true;
    SystemNotifications = true;
    alternativeRouting = true;
    smartProtocol = true;
    secureCoreToggle = true;
    RememberLoginAfterUpdate = false;

    SUAutomaticallyUpdate = true;
  };
}
