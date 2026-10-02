{ lib }:
# Some apps read prefs with `data(forKey:)` and decode JSON from the bytes.
# `targets.darwin.defaults` has no data type, so write those keys in an
# activation step with `defaults write -data`.
domain: keys:
lib.hm.dag.entryAfter [ "setDarwinDefaults" ] (lib.concatStrings (lib.mapAttrsToList (key: value: ''
  run /usr/bin/defaults write ${domain} ${lib.escapeShellArg key} -data \
    "$(printf '%s' ${lib.escapeShellArg (builtins.toJSON value)} | /usr/bin/xxd -p | tr -d '\n')"
'') keys))
