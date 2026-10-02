{ ... }:
{
  nixconfig.sync.airbattery = {
    method = "defaults";
    live = "com.lihaoyun6.AirBattery";
    repo = "modules/home/programs/airbattery/default.nix";
    ignore = [
      "^(deviceName|machineType|neverRemindMe|alertList)$"
      "^NSStatusItem "
    ];
  };

  # deviceName and machineType describe this Mac and are detected at launch.
  targets.darwin.defaults."com.lihaoyun6.AirBattery" = {
    launchAtLogin = true;
    showOn = "none";
    colorfulBattery = false;
    revListOnWidget = true;
    widgetInterval = -1;

    ideviceOverBLE = true;
    readBLEDevice = false;
    readBTHID = true;

    # With whitelistMode on, blockedDevices is the list of devices to show.
    whitelistMode = true;
    blockedDevices = [
      "MacBook Pro de Arthur"
      "iPhone d’Arthur"
      "AirPods Pro de Arthur 🄻🅁"
    ];

    SUAutomaticallyUpdate = true;
    SUEnableAutomaticChecks = true;
    SUSendProfileInfo = false;
  };
}
