require "utils/github"

# Homebrew 7 has no `url do` block, and GitHub has no redirect for the newest prerelease.
class SmallcastBetaDownloadStrategy < CurlDownloadStrategy
  RELEASES = "https://api.github.com/repos/arthur-fontaine/smallcast/releases?per_page=100".freeze

  def initialize(_url, name, version, **meta)
    super(self.class.newest_beta_dmg, name, version, **meta)
  end

  def self.newest_beta_dmg
    candidates = GitHub::API.open_rest(RELEASES).filter_map do |release|
      next if release["draft"] || !release["prerelease"]

      semver = release["tag_name"][/\Av?(\d+(?:\.\d+)+-beta\.\d+)\z/, 1]
      dmg = release["assets"]&.find { |asset| asset["name"].end_with?(".dmg") }
      [Gem::Version.new(semver), dmg["browser_download_url"]] if semver && dmg
    end
    candidates.max_by(&:first)&.last || raise(Cask::CaskError, "no Smallcast beta release ships a DMG")
  end
end

cask "smallcast@beta" do
  version :latest
  sha256 :no_check

  url "https://github.com/arthur-fontaine/smallcast/releases",
      using: SmallcastBetaDownloadStrategy
  name "Smallcast Beta"
  desc "Native launcher, hotkeys, and clipboard history (beta channel)"
  homepage "https://github.com/arthur-fontaine/smallcast"

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
