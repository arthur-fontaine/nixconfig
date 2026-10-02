{ config, lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  options.nixconfig = {
    defaultsData = mkOption {
      type = types.attrsOf (types.attrsOf types.anything);
      default = { };
      description = ''
        Preference keys written as plist data holding JSON, by domain. Some
        apps read prefs with `data(forKey:)`, and `targets.darwin.defaults`
        has no data type.
      '';
    };

    sync = mkOption {
      default = { };
      description = ''
        What scripts/config-drift.py compares against the live machine. It only
        describes the config; each module still installs its own files.
      '';
      type = types.attrsOf (types.submodule {
        options = {
          method = mkOption {
            type = types.enum [ "copy" "json-merge" "toml-merge" "defaults" ];
            description = ''
              copy: the live file should equal `managed` (a file).
              json-merge, toml-merge: every key in `managed` (a value) should
              match the live file; other live keys are reported as unmanaged.
              defaults: `live` is a domain, compared with the module's
              `targets.darwin.defaults` and `nixconfig.defaultsData` entries.
            '';
          };
          live = mkOption {
            type = types.str;
            description = "Live file path (`~` allowed) or defaults domain.";
          };
          managed = mkOption {
            type = types.nullOr types.anything;
            default = null;
          };
          repo = mkOption {
            type = types.str;
            description = "Repo file to edit when the live side changed.";
          };
          ignore = mkOption {
            type = types.listOf types.str;
            default = [ ];
            description = "Regexes for unmanaged keys that are app state, not settings.";
          };
        };
      });
    };
  };

  config.home.activation.writeDefaultsData = lib.hm.dag.entryAfter [ "setDarwinDefaults" ] (
    lib.concatStrings (lib.flatten (lib.mapAttrsToList (domain: keys:
      lib.mapAttrsToList (key: value: ''
        run /usr/bin/defaults write ${lib.escapeShellArg domain} ${lib.escapeShellArg key} -data \
          "$(printf '%s' ${lib.escapeShellArg (builtins.toJSON value)} | /usr/bin/xxd -p | tr -d '\n')"
      '') keys
    ) config.nixconfig.defaultsData))
  );
}
