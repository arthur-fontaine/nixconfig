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

  home.file.".pi/agent/extensions/title.ts".source = ./extensions/title.ts;
  home.file.".pi/agent/extensions/home-dashboard.ts".source = ./extensions/home-dashboard.ts;
  home.file.".pi/agent/extensions/input-box.ts".source = ./extensions/input-box.ts;
  home.file.".pi/agent/extensions/message-timestamps.ts".source = ./extensions/message-timestamps.ts;
  home.file.".pi/agent/extensions/auto-theme.ts".source = ./extensions/auto-theme.ts;
  home.file.".pi/agent/extensions/pi-rtk-optimizer/config.json".source = ./extensions/pi-rtk-optimizer/config.json;

  home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
    ext_base="$HOME/.pi/agent/extensions"
    ext_dir="$ext_base/nono-sandbox"
    stamp="$HOME/.local/state/pi-nono-sandbox-hash"
    src="${./extensions/nono-sandbox}"
    src_hash=$(md5sum "$src/package.json"); src_hash="''${src_hash%% *}"

    # If the parent extensions dir is still a nix-store symlink from the old
    # home.file entry, replace it with a real directory first. Individual
    # extension symlinks will be (re)created by linkGenFiles afterwards.
    if [ -L "$ext_base" ]; then
      rm "$ext_base"
      mkdir -p "$ext_base"
    fi

    if [ ! -d "$ext_dir" ] || [ ! -f "$stamp" ] || [ "$src_hash" != "$(cat "$stamp")" ]; then
      [ -e "$ext_dir" ] && { chmod -R u+w "$ext_dir" 2>/dev/null || true; rm -rf "$ext_dir"; }
      cp -r "$src" "$ext_dir"
      chmod -R u+w "$ext_dir"
      run npm install --prefix "$ext_dir" --ignore-scripts
      mkdir -p "$(dirname "$stamp")"
      echo "$src_hash" > "$stamp"
    fi
  '';
}
