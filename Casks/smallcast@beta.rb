cask "smallcast@beta" do
  version "0.4.0-beta.24"
  sha256 "7b98fceca866416f1a9456a39e37a6f85492c7b2502777e88efd274da53a49c9"

  url "https://github.com/arthur-fontaine/smallcast/releases/download/v#{version}/Smallcast-#{version}.dmg"
  name "Smallcast Beta"
  desc "Native launcher, hotkeys, and clipboard history (beta channel)"
  homepage "https://github.com/arthur-fontaine/smallcast"

  # The default strategy drops prereleases, and the beta channel ships only prereleases.
  livecheck do
    url :url
    regex(/^v?(\d+(?:\.\d+)+-beta\.\d+)$/i)
    strategy :github_releases do |json, regex|
      json.filter_map do |release|
        next if release["draft"] || !release["prerelease"]

        release["tag_name"]&.[](regex, 1)
      end
    end
  end

  # The app installs its own updates; without this brew would roll a self-updated copy back.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :tahoe

  app "Smallcast Beta.app"

  # Self-signed, not notarized: Gatekeeper refuses to launch it while quarantined.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Smallcast Beta.app"]
  end

  uninstall quit: "com.smallcast.app.beta"

  zap login_item: "Smallcast Beta",
      trash:      [
        "~/Library/Application Support/com.smallcast.app.beta",
        "~/Library/Caches/com.smallcast.app.beta",
        "~/Library/Preferences/com.smallcast.app.beta.plist",
        "~/Library/Saved Application State/com.smallcast.app.beta.savedState",
      ]
end
