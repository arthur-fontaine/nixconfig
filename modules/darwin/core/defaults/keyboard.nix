{ ... }:
let
  nbsp = builtins.fromJSON ''"\u00a0"'';
in
{
  system.defaults.CustomUserPreferences."com.apple.HIToolbox" = {
    AppleCurrentKeyboardLayoutInputSourceID = "com.apple.keylayout.USInternational-PC";
    AppleEnabledInputSources = [
      {
        "Bundle ID" = "com.apple.CharacterPaletteIM";
        InputSourceKind = "Non Keyboard Input Method";
      }
      {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout ID" = 15000;
        "KeyboardLayout Name" = "USInternational-PC";
      }
      {
        "Bundle ID" = "com.apple.PressAndHold";
        InputSourceKind = "Non Keyboard Input Method";
      }
    ];
    AppleSelectedInputSources = [
      {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout ID" = 15000;
        "KeyboardLayout Name" = "USInternational-PC";
      }
      {
        "Bundle ID" = "com.apple.PressAndHold";
        InputSourceKind = "Non Keyboard Input Method";
      }
    ];
  };

  # French guillemets with no-break spaces for smart double quotes.
  system.defaults.CustomUserPreferences.NSGlobalDomain = {
    NSUserQuotesArray = [ "«${nbsp}" "${nbsp}»" "‘" "’" ];
    KB_DoubleQuoteOption = "« abc »";
    KB_SingleQuoteOption = "‘abc’";
  };
}
