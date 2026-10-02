{ ... }:
{
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
