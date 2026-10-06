{ config, lib, homeDirectory, ... }:
let
  # Llama.app runs the llama.cpp build it pins, which predates decision model
  # support (/v1/systemone, llama.cpp #29818, first released in v0.6.0). While
  # the installed app is `appVersion`, use Homebrew's llama.cpp instead, which
  # `brew upgrade` keeps on the latest release; once the app updates, go back
  # to its own build.
  appVersion = "0.43.0";

  brewPrefix = config.homebrew.prefix;
  llama = "${brewPrefix}/opt/llama.cpp/bin/llama";

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
  # After the homebrew step, which installs the llama.cpp formula, and before
  # the llama home module reopens the app. The app picks its engine at launch,
  # so quit it when the engine changes.
  system.activationScripts.postActivation.text = lib.mkBefore ''
    (
      plist=/Applications/Llama.app/Contents/Info.plist
      [ -f "$plist" ] || exit 0
      version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist" || true)
      if [ "$version" != ${appVersion} ]; then
        case "$(readlink ${link})" in
          /nix/store/* | ${brewPrefix}/*)
            echo "Llama.app is now $version, switching back to its own llama.cpp..." >&2
            rm -f ${link}
            pkill -x Llama || true
            ;;
        esac
      elif [ ! -x ${llama} ]; then
        echo "warning: ${llama} is missing, leaving Llama.app on its own llama.cpp" >&2
      elif [ "$(readlink ${link})" != ${llama} ] || [ -e ${lib.head appCopies} ]; then
        echo "Switching Llama.app $version to Homebrew's llama.cpp..." >&2
        mkdir -p /usr/local/bin
        ln -sfn ${llama} ${link}
        rm -f ${lib.escapeShellArgs appCopies}
        pkill -x Llama || true
      fi
    )
  '';
}
