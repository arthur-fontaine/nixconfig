{ ... }:
{
  # 1 = no action. Without it macOS puts Quick Note on the bottom-right corner.
  system.defaults.dock = {
    wvous-tr-corner = 1;
    wvous-br-corner = 1;
  };

  system.defaults.CustomUserPreferences."com.apple.dock" = {
    showMissionControlGestureEnabled = true;
    showAppExposeGestureEnabled = false;
  };
}
