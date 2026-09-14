cask "bartender@7" do
  version "7.0.0"
  sha256 "86418c9bc7c93aac1df7c34605cb9b419a48a4619814e3b41aeec058cca66769"

  url "https://downloads.macbartender.com/Bartender7/updates/#{version.dots_to_hyphens}/Bartender%20#{version.major}.zip"
  name "Bartender"
  desc "Menu bar icon organiser"
  homepage "https://www.macbartender.com/"

  livecheck do
    url "https://downloads.macbartender.com/Bartender7/updates/AppcastB7.xml"
    strategy :sparkle, &:short_version
  end

  auto_updates true
  conflicts_with cask: "bartender"
  depends_on macos: :sonoma

  app "Bartender 7.app"

  zap trash: [
    "~/Library/Application Scripts/com.surteesstudios.Bartender",
    "~/Library/Application Support/Bartender",
    "~/Library/Caches/com.surteesstudios.Bartender",
    "~/Library/Containers/com.surteesstudios.Bartender",
    "~/Library/HTTPStorages/com.surteesstudios.Bartender",
    "~/Library/Preferences/com.surteesstudios.Bartender.plist",
  ]
end
