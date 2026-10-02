{ config, lib, pkgs, username, homeDirectory, nixconfigDir, ... }:
let
  brew = "${config.homebrew.prefix}/bin/brew";
  declaredTaps = map (t: t.name) config.homebrew.taps;
  declaredCasks = map (c: c.name) config.homebrew.casks;
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
      # As root brew prints ">=4.6.0 (shallow or no git repository)" instead of its version.
      brew_version() { as_user "${brew}" --version 2>/dev/null | head -1 || true; }
      brew_major() { brew_version | sed -n '1s/^Homebrew[^0-9]*\([0-9][0-9]*\).*/\1/p'; }

      echo "checking Homebrew..." >&2
      if [ ! -x "${brew}" ]; then
        echo "installing Homebrew..." >&2
        as_user /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
          || echo "warning: the Homebrew installer failed" >&2
      fi
      major=$(brew_major)
      if [ -x "${brew}" ] && [ "''${major:-0}" -lt 7 ]; then
        echo "updating $(brew_version) to Homebrew 7..." >&2
        as_user "${brew}" update --force || echo "warning: brew update failed" >&2
        major=$(brew_major)
      fi
      if [ "''${major:-0}" -lt 7 ]; then
        echo -e "\e[1;31merror: Homebrew 7 is required, found: $(brew_version)\e[0m" >&2
        exit 1
      fi
    )

    sudo -u ${username} -H find "${homeDirectory}/Library/Caches/Homebrew/downloads" \
      -name '*.bottle_manifest.json' -delete 2>/dev/null || true

    # `brew bundle cleanup` resets the trust store to the Brewfile, then silently
    # skips any installed formula it can't load (untrusted, or no longer parseable),
    # and its final `brew cleanup` aborts activation on that same formula. Remove
    # what was installed from taps this config doesn't list before bundle runs.
    (
      brew_user() { sudo -u ${username} -H "${brew}" "$@"; }
      is_undeclared() {
        local tap=''${1,,}
        local declared=${lib.escapeShellArg (lib.toLower (lib.concatStringsSep " " declaredTaps))}
        case "$tap" in "" | homebrew/*) return 1 ;; esac
        case " $declared " in *" $tap "*) return 1 ;; esac
      }

      # Read the tap from each keg's install receipt so kegs whose tap is already
      # gone are found too. Uninstall them by bare name: a `tap/name` reference
      # makes brew evaluate the formula file, which fails if it no longer parses.
      formulae=()
      for rack in "${config.homebrew.prefix}"/Cellar/*/; do
        for receipt in "$rack"*/INSTALL_RECEIPT.json; do
          tap=$(plutil -extract source.tap raw -o - "$receipt" 2>/dev/null) || continue
          if is_undeclared "$tap"; then
            formulae+=("$(basename "$rack")")
            break
          fi
        done
      done
      if [ "''${#formulae[@]}" -gt 0 ]; then
        echo "uninstalling formulae from taps this config doesn't list: ''${formulae[*]}" >&2
        brew_user uninstall --formula --force "''${formulae[@]}" || echo "warning: could not uninstall ''${formulae[*]}" >&2
      fi

      # Casks have to be loaded to be zapped, so trust each tap just for that.
      mapfile -t taps < <(brew_user tap 2>/dev/null || true)
      for tap in "''${taps[@]}"; do
        is_undeclared "$tap" || continue
        echo "removing $tap and what was installed from it..." >&2
        brew_user trust --tap "$tap" >/dev/null || true
        mapfile -t casks < <(brew_user list --cask --full-name 2>/dev/null | grep -i "^$tap/" || true)
        if [ "''${#casks[@]}" -gt 0 ]; then
          brew_user uninstall --cask --zap --force "''${casks[@]}" || echo "warning: could not zap ''${casks[*]}" >&2
        fi
        brew_user untap "$tap" || echo "warning: could not untap $tap" >&2
        brew_user untrust --tap "$tap" >/dev/null 2>&1 || true
      done
    )

    # An app deleted by hand leaves its Caskroom record, so brew bundle treats
    # the cask as installed and never puts the app back. Drop the record of any
    # declared cask whose app is gone, and the bundle step installs it again.
    (
      brew_user() { sudo -u ${username} -H "${brew}" "$@"; }
      declared=" ${lib.concatStringsSep " " declaredCasks} "
      brew_user info --cask --json=v2 --installed 2>/dev/null \
        | ${pkgs.jq}/bin/jq -r '.casks[] | .full_token as $t
            | [.artifacts[] | .app? // empty] | flatten
            # An app entry is a source name, optionally followed by {target}.
            | reduce .[] as $x ([]; if ($x | type) == "object" then .[:-1] + [$x.target] else . + [$x] end)
            | .[] | [$t, .] | @tsv' \
        | while IFS=$'\t' read -r cask app; do
            case "$declared" in *" $cask "*) ;; *) continue ;; esac
            case "$app" in /*) path="$app" ;; *) path="/Applications/$app" ;; esac
            [ -e "$path" ] && continue
            echo "$cask is installed but $path is missing, reinstalling it..." >&2
            brew_user uninstall --cask --force "$cask" >/dev/null || echo "warning: could not reset $cask" >&2
          done
    )
  '';

  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      # nix-darwin appends `--zap --force-cleanup` to `brew bundle` for this,
      # so unlisted formulae/casks are zapped non-interactively during activation.
      cleanup = "zap";
      upgrade = true;
      extraFlags = [ "--verbose" ];
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
