{ username, ... }:
{
  # Must run in extraActivation: it comes before the homebrew step, and brew
  # bundle refuses every install while Xcode or the Command Line Tools are outdated.
  system.activationScripts.extraActivation.text = ''
    (
      xcodes=/opt/homebrew/bin/xcodes

      echo "checking Command Line Tools..." >&2
      installed_clt=$(pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null \
        | awk '/^version:/ { split($2, v, "."); print v[1] "." v[2] }')
      placeholder=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      touch "$placeholder"
      clt_label=$(softwareupdate --list 2>/dev/null \
        | sed -n 's/^\* Label: \(Command Line Tools for Xcode .*[^[:space:]]\)[[:space:]]*$/\1/p' \
        | sort -V | tail -1)
      rm -f "$placeholder"
      if [ -n "$clt_label" ]; then
        clt_version=$(printf '%s' "$clt_label" | sed 's/.*Xcode \([0-9.]*\).*/\1/')
        newest=$(printf '%s\n' "$installed_clt" "$clt_version" | sort -V | tail -1)
        if [ "$newest" != "$installed_clt" ]; then
          echo "installing $clt_label..." >&2
          softwareupdate --install "$clt_label" \
            || echo "warning: could not install $clt_label; run: sudo softwareupdate --install '$clt_label'" >&2
        fi
      fi

      if [ -x "$xcodes" ]; then
        echo "checking Xcode..." >&2
        run_as_user() { sudo -u ${username} -H env PATH="/opt/homebrew/bin:$PATH" "$xcodes" "$@"; }
        latest_xcode=$(run_as_user update 2>/dev/null | grep -E '^[0-9.]+ \(' | tail -1 | awk '{ print $1 }')
        if [ -n "$latest_xcode" ]; then
          if ! run_as_user installed 2>/dev/null | grep -q "^$latest_xcode ("; then
            echo "installing Xcode $latest_xcode..." >&2
            run_as_user install "$latest_xcode" --no-superuser --experimental-unxip --empty-trash \
              || echo "warning: could not install Xcode $latest_xcode; run: xcodes install $latest_xcode --select" >&2
          fi
          xcode_path=$(run_as_user installed 2>/dev/null | awk -F'\t' -v v="$latest_xcode" 'index($1, v " (") == 1 { print $NF }')
          if [ -n "$xcode_path" ] && [ "$(xcode-select -p 2>/dev/null)" != "$xcode_path/Contents/Developer" ]; then
            echo "selecting $xcode_path..." >&2
            xcode-select -s "$xcode_path" \
              && xcodebuild -license accept \
              && xcodebuild -runFirstLaunch \
              || echo "warning: could not select $xcode_path" >&2
          fi
        fi
      fi
    )
  '';
}
