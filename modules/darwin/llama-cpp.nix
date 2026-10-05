{ pkgs, lib, homeDirectory, ... }:
let
  # Llama.app runs the llama.cpp build it pins, which predates decision model
  # support (/v1/systemone, llama.cpp #29818, first in b11361). While the
  # installed app is `appVersion`, use a dev build from GitHub releases instead;
  # once the app updates, go back to its own build.
  appVersion = "0.43.0";
  devBuild = {
    tag = "b11406";
    hash = "sha256-5D9QHJQcyOksa0Rp9OCMjqqfQhPbK4hZeDk/cS+TYxE=";
  };

  llamaCpp = pkgs.stdenvNoCC.mkDerivation {
    pname = "llama-cpp-bin";
    version = devBuild.tag;
    src = pkgs.fetchurl {
      url = "https://github.com/ggml-org/llama.cpp/releases/download/${devBuild.tag}/llama-${devBuild.tag}-bin-macos-arm64.tar.gz";
      inherit (devBuild) hash;
    };
    # The binaries are ad-hoc signed and find their dylibs via @loader_path;
    # stripping would invalidate the signatures.
    dontFixup = true;
    installPhase = ''
      mkdir -p $out/libexec $out/bin
      cp -R . $out/libexec/llama-cpp
      ln -s $out/libexec/llama-cpp/llama $out/bin/llama
    '';
  };

  link = "/usr/local/bin/llama";
  # Llama.app prefers its own copy and resets it to its pinned build at launch.
  # Only when it's missing does the app fall back to /usr/local/bin, and it
  # never modifies a binary there. ~/.local/bin/llama is the app's CLI copy.
  appCopies = map (p: "${homeDirectory}/${p}") [
    ".llama-app/llama"
    ".llama-app/llama.staged"
    ".local/bin/llama"
  ];
in
{
  # The app picks its engine at launch, so quit it when the engine changes. The
  # llama home module reopens it, later in the same activation.
  system.activationScripts.extraActivation.text = ''
    (
      plist=/Applications/Llama.app/Contents/Info.plist
      [ -f "$plist" ] || exit 0
      version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist" || true)
      if [ "$version" != ${appVersion} ]; then
        case "$(readlink ${link})" in
          /nix/store/*)
            echo "Llama.app is now $version, switching back to its own llama.cpp..." >&2
            rm -f ${link}
            pkill -x Llama || true
            ;;
        esac
      elif [ "$(readlink ${link})" != ${llamaCpp}/bin/llama ] || [ -e ${lib.head appCopies} ]; then
        echo "Switching Llama.app $version to llama.cpp ${devBuild.tag}..." >&2
        mkdir -p /usr/local/bin
        ln -sfn ${llamaCpp}/bin/llama ${link}
        rm -f ${lib.escapeShellArgs appCopies}
        pkill -x Llama || true
      fi
    )
  '';
}
