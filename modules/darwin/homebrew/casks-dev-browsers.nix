# Developer apps, browsers, and terminals
[
  "android-commandlinetools"
  "claude-code@latest"
  "cyberduck"
  "datagrip"
  "gcloud-cli"
  "ghostty@tip"
  "google-chrome"
  # Herdr's desktop app, not the `herdr` terminal multiplexer formula.
  "herdr-app"
  "httpie-desktop"
  "llama-app"
  "orbstack"
  # Taps from its own repo; see ./default.nix. `version :latest` casks only
  # upgrade when greedy.
  { name = "arthur-fontaine/somebrowser/somebrowser"; greedy = true; }
  "zed@preview"
]
