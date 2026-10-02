{ pkgs }:
# Deep-merge a managed JSON file into one the app also writes, so keys the
# module does not list survive. Returns an activation snippet.
src: dest: ''
  if [ ! -e "${dest}" ]; then
    $DRY_RUN_CMD mkdir -p "$(dirname "${dest}")"
    $DRY_RUN_CMD cp ${src} "${dest}"
    $DRY_RUN_CMD chmod u+w "${dest}"
  elif ${pkgs.jq}/bin/jq -e . "${dest}" > /dev/null 2>&1; then
    merged="$(${pkgs.coreutils}/bin/mktemp "${dest}.XXXXXX")"
    if ${pkgs.jq}/bin/jq -s '.[0] * .[1]' "${dest}" ${src} > "$merged"; then
      $DRY_RUN_CMD mv -f "$merged" "${dest}"
    fi
    rm -f "$merged"
  else
    echo "warning: ${dest} is not valid JSON, skipping" >&2
  fi
''
