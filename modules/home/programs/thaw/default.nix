{ ... }:
let
  domain = "com.stonerl.Thaw";
in
{
  nixconfig.sync.thaw = {
    method = "defaults";
    live = domain;
    repo = "modules/home/programs/thaw/default.nix";
  };

  # Hidden section, imported from Bartender 7's GoldenGateHiddenItemOrderKeys.
  # Entries are `<bundle id>:<status item autosave name>`, right to left, the
  # order Thaw saves them in. When the menu bar doesn't match this, Thaw moves
  # items back. Items missing from the list stay where they are, and new items
  # go to hidden by default.
  #
  # Bartender's `slot:` entries had no item name to map, so they are left out:
  # LM Studio, a System UI Server item, the screen capture indicator, and
  # Smallcast dev and test builds.
  targets.darwin.defaults.${domain}."MenuBarItemManager.savedSectionOrder" = {
    hidden = [
      "fyi.lunar.Lunar:Item-0"
      "com.FluidApp.app:Item-0"
      "com.pais.handy:Item-0"
      "pro.betterdisplay.BetterDisplay:Item-0"
      "ch.protonvpn.mac:Item-0"
      "dev.kdrag0n.MacVirt:Item-0"
      "com.hnc.Discord:699e423d-73da-42ba-b94e-881ff8672467"
      "app.llama.Llama:Item-0"
      "notion.id:Item-0"
      "org.openlogi.agent:Item-0"
      "com.microsoft.teams2:Item-0"
      "com.anthropic.claudefordesktop:Item-0"
      "fleet-desktop:Item-0"
      "com.apple.campo:Item-0"
      # 1Password renamed its item since Bartender saved Item-0; keep both.
      "com.1password.1password:bb3cc23c-6950-4e96-8b40-850e09f46934"
      "com.1password.1password:Item-0"
      "com.smallcast.app.beta:Item-0"
      "org.pqrs.Karabiner-Console-User-Server:Item-0"
      "iordv.Droppy:Item-0"
      "com.sentinelone.SentinelAgent:Item-0"
    ];
  };
}
