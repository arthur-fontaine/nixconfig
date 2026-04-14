{ pkgs, username, ... }:
{
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.primaryUser = username;
  users.users.${username}.shell = pkgs.zsh;

  environment.shells = [ pkgs.zsh ];
  environment.systemPackages = with pkgs; [ git ];

  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };
    taps = [
      "anomalyco/tap"
      "chase/tap"
      "lihaoyun6/tap"
      "mongodb/brew"
      "oven-sh/bun"
  ];
    brews = [
      { name = "powershell"; link = false; }
      "act"
      "agent-browser"
      "antidote"
      "aria2"
      "awscli"
      "bacon"
      "bash"
      "bat"
      "beads"
      "chezmoi"
      "ruby"
      "cocoapods"
      "coreutils"
      "duckdb"
      "eza"
      "fd"
      "tesseract"
      "ffmpeg"
      "firebase-cli"
      "fx"
      "fzf"
      "gh"
      "git-delta"
      "git-lfs"
      "gitingest"
      "glow"
      "gnupg"
      "go"
      "graphviz"
      "helix"
      "httpie"
      "hyperfine"
      "jupyterlab"
      "just"
      "lazygit"
      "mongosh"
      "neovim"
      "nmap"
      "openjdk"
      "poppler"
      "pyenv"
      "qrencode"
      "rtk"
      "sem-cli"
      "terminal-notifier"
      "thefuck"
      "tmate"
      "tree"
      "xcodes"
      "zellij"
      "anomalyco/tap/opencode"
      "chase/tap/awrit"
      "mongodb/brew/mongodb-database-tools"
    ];
    casks = [
      "1password"
      "1password-cli"
      "lihaoyun6/tap/airbattery"
      "alcove"
      "athas"
      "bruno"
      "chatgpt"
      "codex"
      "codex-app"
      "cyberduck"
      "datagrip"
      "discord"
      "figma-agent"
      "gcloud-cli"
      "ghostty@tip"
      "google-chrome"
      "handy"
      "httpie-desktop"
      "jordanbaird-ice@beta"
      "karabiner-elements"
      "keka"
      "kekaexternalhelper"
      "kitlangton-hex"
      "lm-studio"
      "logi-options+"
      "lunar"
      "macmediakeyforwarder"
      "obsidian"
      "opencode-desktop"
      "orbstack"
      "powershell"
      "protonvpn"
      "raycast"
      "sony-ps-remote-play"
      "spotify"
      "visual-studio-code"
      "whatsapp"
      "zed@preview"
      "zen"
  ];
  };

  system.defaults = {
    NSGlobalDomain.NSPreferredExternalTerminalApp = "Ghostty";
    trackpad.NaturalScrolling = false;
  };

  system.stateVersion = 6;
}
