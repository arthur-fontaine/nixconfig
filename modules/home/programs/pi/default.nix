{ lib, ... }:
{
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    lastChangelogVersion = "0.66.1";
    defaultProvider = "openai-codex";
    defaultModel = "gpt-5.4";
    defaultThinkingLevel = "high";
    quietStartup = true;
    theme = "light";
    packages = [
      "git:github.com/MasuRii/pi-rtk-optimizer"
      "git:github.com/Aetherall/lmgrep"
      "git:github.com/jonjonrankin/pi-caveman"
    ];
  };

  home.file.".pi/agent/nono-sandbox.json".text = builtins.toJSON {
    enabled = true;
    readOnlyPaths = [
      "~/.config/git/ignore"
      "~/.config/gh/config.yml"
      "~/.config/gh/hosts.yml"
      "~/Library/Keychains"
    ];
    readWritePaths = [
      "~/.pi/agent/extensions/"
      "~/.local/state/lmgrep"
      "~/Library/Application Support/lmgrep"
      "~/Library/pnpm/.tools/pnpm"
    ];
  };

  home.file.".pi/agent/extensions".source = ./extensions;

  home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ext_dir="$HOME/.pi/agent/extensions/nono-sandbox"
    stamp="$ext_dir/.package-json-hash"
    if [ -f "$ext_dir/package.json" ]; then
      current_hash=$(md5sum "$ext_dir/package.json"); current_hash="''${current_hash%% *}"
      if [ ! -f "$stamp" ] || [ "$current_hash" != "$(cat "$stamp")" ]; then
        run npm install --prefix "$ext_dir" --ignore-scripts
        echo "$current_hash" > "$stamp"
      fi
    fi
  '';
}
