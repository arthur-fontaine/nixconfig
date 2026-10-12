cask "filmcraft-cli" do
  # The CLI has to come from the same release as the app, so follow the app
  # cask instead of pinning a version that homebrew/cask would leave behind.
  version ::Cask::CaskLoader.load("filmcraft").version.to_s
  sha256 :no_check

  url "https://github.com/storytold/filmcraft/releases/download/v#{version}/filmcraft-cli-#{version}-macos-universal.zip"
  name "FilmCraft CLI"
  desc "Command-line tool and MCP server for FilmCraft"
  homepage "https://github.com/storytold/filmcraft"

  depends_on cask: "filmcraft"

  rename "filmcraft-cli-*-macos-universal/filmcraft-cli", "filmcraft-cli"

  binary "filmcraft-cli"
end
