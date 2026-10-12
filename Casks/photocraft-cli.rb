cask "photocraft-cli" do
  # The CLI has to come from the same release as the app, so follow the app
  # cask instead of pinning a version that homebrew/cask would leave behind.
  version ::Cask::CaskLoader.load("photocraft").version.to_s
  sha256 :no_check

  url "https://github.com/storytold/photocraft/releases/download/v#{version}/photocraft-cli-#{version}-macos-universal.zip"
  name "PhotoCraft CLI"
  desc "Command-line tool and MCP server for PhotoCraft"
  homepage "https://github.com/storytold/photocraft"

  depends_on cask: "photocraft"

  rename "photocraft-cli-*-macos-universal/photocraft-cli", "photocraft-cli"

  binary "photocraft-cli"
end
