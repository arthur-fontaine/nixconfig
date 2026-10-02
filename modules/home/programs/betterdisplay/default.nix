{ ... }:
{
  # Only app-wide settings. Every `<setting>@Display:<tag>` key is bound to a
  # tag BetterDisplay assigns to each display it has seen, so it does not
  # carry over to another Mac.
  targets.darwin.defaults."pro.betterdisplay.BetterDisplay" = {
    integrationHTTP = true;
    osdIntegrationNotification = true;
    osdShowBasic = false;
    showIntegrationDetails = true;
    showSliderLabelsAndValues = true;

    SUAutomaticallyUpdate = true;
    SUEnableAutomaticChecks = true;
    SUSendProfileInfo = false;
  };
}
