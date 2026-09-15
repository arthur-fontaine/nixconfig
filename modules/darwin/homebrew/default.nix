{ config, username, homeDirectory, nixconfigDir, ... }:
let
  brew = "${config.homebrew.prefix}/bin/brew";
  brewLists = [
    (import ./brews-cli-shell.nix)
    (import ./brews-dev-workflow.nix)
    (import ./brews-language-toolchains.nix)
    (import ./brews-data-infra-media.nix)
  ];

  caskLists = [
    (import ./casks-security-ai.nix)
    (import ./casks-dev-browsers.nix)
    (import ./casks-productivity-media.nix)
    (import ./casks-system-peripherals.nix)
  ];
in
{
  # Runs before the homebrew step. Casks/ needs Homebrew 7, and stale cached
  # manifests make brew bundle fail with "Couldn't find manifest matching bottle checksum".
  system.activationScripts.extraActivation.text = ''
    (
      as_user() { sudo -u ${username} -H env PATH="${config.homebrew.prefix}/bin:$PATH" NONINTERACTIVE=1 "$@"; }
      brew_major() { { "${brew}" --version 2>/dev/null || true; } | awk 'NR == 1 { split($2, v, "."); print v[1] }'; }

      echo "checking Homebrew..." >&2
      if [ ! -x "${brew}" ]; then
        echo "installing Homebrew..." >&2
        as_user /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
          || echo "warning: the Homebrew installer failed" >&2
      fi
      major=$(brew_major)
      if [ -x "${brew}" ] && [ "''${major:-0}" -lt 7 ]; then
        echo "updating $("${brew}" --version | head -1) to Homebrew 7..." >&2
        as_user "${brew}" update --force || echo "warning: brew update failed" >&2
        major=$(brew_major)
      fi
      if [ "''${major:-0}" -lt 7 ]; then
        echo -e "\e[1;31merror: Homebrew 7 is required, found: $("${brew}" --version 2>/dev/null | head -1 || echo "nothing")\e[0m" >&2
        exit 1
      fi
    )

    sudo -u ${username} -H find "${homeDirectory}/Library/Caches/Homebrew/downloads" \
      -name '*.bottle_manifest.json' -delete 2>/dev/null || true
  '';

  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      # nix-darwin appends `--zap --force-cleanup` to `brew bundle` for this,
      # so unlisted formulae/casks are zapped non-interactively during activation.
      cleanup = "zap";
      upgrade = true;
    };

    taps = import ./taps.nix ++ [
      {
        name = "nixconfig/casks";
        clone_target = nixconfigDir;
        force_auto_update = true;
        trusted = true;
      }
    ];

    brews = builtins.concatLists brewLists;

    casks = builtins.concatLists caskLists;
  };
}
