{ pkgs, lib, config, ... }:
let
  # Placeholder; the merge script swaps it for the unit id OpenLogi assigns to
  # this machine's MX Master 3.
  devicePlaceholder = "@DEVICE@";
  productId = "b023";

  zoomIn = {
    CustomShortcut = "Cmd+=";
  };
  zoomOut = {
    CustomShortcut = "Cmd+-";
  };
  browserNav = {
    Back = "BrowserBack";
    Forward = "BrowserForward";
    ThumbwheelScrollUp = zoomIn;
    ThumbwheelScrollDown = zoomOut;
  };

  toml = pkgs.formats.toml { };
  configFile = toml.generate "openlogi-config.toml" {
    schema_version = 7;

    app_settings = {
      launch_at_login = true;
      check_for_updates = false;
      appearance = "system";
    };

    devices.${devicePlaceholder} = {
      enabled = true;
      invert_scroll = false;

      smartshift.mode = "ratchet";

      bindings = {
        MiddleClick = "MiddleClick";
        Back = "MouseBack";
        Forward = "MouseForward";
        DpiToggle = {
          CustomShortcut = "Ctrl+Shift+]";
        };
        GestureButton = {
          Click = "MissionControl";
          Up = "MissionControl";
          Down = "AppExpose";
          Left = "PreviousDesktop";
          Right = "NextDesktop";
        };
      };

      per_app_bindings = {
        "com.apple.Safari" = browserNav;
        "com.google.Chrome" = browserNav;
        "com.figma.Desktop" = {
          ThumbwheelScrollUp = zoomIn;
          ThumbwheelScrollDown = zoomOut;
        };
      };
    };
  };

  mergeScript = pkgs.writeScript "merge-openlogi-config.py" ''
    #!${pkgs.python3.withPackages (ps: [ ps.toml ])}/bin/python3
    import os, re, subprocess, sys, toml

    dest, src = sys.argv[1], sys.argv[2]
    placeholder, product_id = "${devicePlaceholder}", "${productId}"

    def deep_merge(base, overlay):
        merged = dict(base)
        for key, value in overlay.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = deep_merge(merged[key], value)
            else:
                merged[key] = value
        return merged

    def key_from_config(devices):
        model_id = int(product_id, 16)
        for key, device in devices.items():
            links = device.get("links", {})
            if any(link.split(":")[1:3] == ["046d", product_id] for link in links):
                return key
            model_info = device.get("identity", {}).get("model_info", {})
            if model_id in model_info.get("model_ids", []):
                return key
        return None

    def key_from_cli():
        for candidate in ("/Applications/OpenLogi.app/Contents/MacOS/openlogi", "openlogi"):
            try:
                listing = subprocess.run(
                    [candidate, "list"], capture_output=True, text=True, timeout=30
                ).stdout
            except (OSError, subprocess.SubprocessError):
                continue
            for block in listing.split("device:" if "device:" in listing else "\n\n"):
                if "pid=" + product_id not in block:
                    continue
                unit = re.search(r"unit_id=([0-9a-f]+)", block)
                if unit:
                    return "unit:" + unit.group(1)
        return None

    with open(src) as f:
        nix_config = toml.load(f)

    existing = {}
    if os.path.exists(dest) and not os.path.islink(dest):
        try:
            with open(dest) as f:
                existing = toml.load(f)
        except Exception:
            existing = {}

    device_settings = nix_config["devices"].pop(placeholder)
    device_key = key_from_config(existing.get("devices", {})) or key_from_cli()
    if device_key:
        nix_config["devices"][device_key] = device_settings
    else:
        print("openlogi: no mouse matching pid " + product_id + " yet, skipping its bindings")

    merged = deep_merge(existing, nix_config)

    tmp = dest + ".tmp"
    with open(tmp, "w") as f:
        toml.dump(merged, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, dest)
  '';
in
{
  home.activation.openlogiConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    config_dir="${config.xdg.configHome}/openlogi"
    $DRY_RUN_CMD mkdir -p "$config_dir"
    $DRY_RUN_CMD ${mergeScript} "$config_dir/config.toml" ${configFile}
  '';
}
