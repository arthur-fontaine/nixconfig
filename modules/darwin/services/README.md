# Darwin services module

This directory contains system-level launchd services managed by nix-darwin.

Currently it owns:
- `dnsmasq.nix` — resolves `*.localhost` domains to `127.0.0.1` (works in Safari too)
