cask "effectcraft-cli" do
  # The CLI has to come from the same release as the app, so follow the app
  # cask instead of pinning a version that homebrew/cask would leave behind.
  version ::Cask::CaskLoader.load("effectcraft").version.to_s
  sha256 :no_check

  url "https://github.com/storytold/effectcraft/releases/download/v#{version}/effectcraft-cli-#{version}-macos-universal.zip"
  name "EffectCraft CLI"
  desc "Command-line tool and MCP server for EffectCraft"
  homepage "https://github.com/storytold/effectcraft"

  depends_on cask: "effectcraft"

  rename "effectcraft-cli-*-macos-universal/effectcraft-cli", "effectcraft-cli"

  binary "effectcraft-cli"
end
