cask "vectorcraft-cli" do
  # The CLI has to come from the same release as the app, so follow the app
  # cask instead of pinning a version that homebrew/cask would leave behind.
  version ::Cask::CaskLoader.load("vectorcraft").version.to_s
  sha256 :no_check

  url "https://github.com/storytold/vectorcraft/releases/download/v#{version}/vectorcraft-cli-#{version}-macos-universal.zip"
  name "VectorCraft CLI"
  desc "Command-line tool and MCP server for VectorCraft"
  homepage "https://github.com/storytold/vectorcraft"

  depends_on cask: "vectorcraft"

  rename "vectorcraft-cli-*-macos-universal/vectorcraft-cli", "vectorcraft-cli"

  binary "vectorcraft-cli"
end
