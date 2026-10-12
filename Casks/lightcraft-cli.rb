cask "lightcraft-cli" do
  # The CLI has to come from the same release as the app, so follow the app
  # cask instead of pinning a version that homebrew/cask would leave behind.
  version ::Cask::CaskLoader.load("lightcraft").version.to_s
  sha256 :no_check

  url "https://github.com/storytold/lightcraft/releases/download/v#{version}/lightcraft-cli-#{version}-macos-universal.zip"
  name "LightCraft CLI"
  desc "Command-line tool and MCP server for LightCraft"
  homepage "https://github.com/storytold/lightcraft"

  depends_on cask: "lightcraft"

  rename "lightcraft-cli-*-macos-universal/lightcraft-cli", "lightcraft-cli"

  binary "lightcraft-cli"
end
