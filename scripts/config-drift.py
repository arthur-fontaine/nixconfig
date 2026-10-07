#!/usr/bin/env python3
"""Compare the config this repo manages with what is live on this Mac.

Reads the `nixconfig.sync` manifest that each home-manager module registers,
plus the nix-darwin `system.defaults` this repo sets, and reports:

  changed    a managed key or file whose live value differs from the repo
  missing    a managed file or key that is not on the machine
  unmanaged  a live key the repo does not list (filtered to likely settings)

Exit status is 1 when anything is changed or missing.

Usage: scripts/config-drift.py [--host NAME] [--only NAME[,NAME]] [--changed-only] [--json]
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import json
import os
import plistlib
import re
import socket
import subprocess
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Keys every macOS app writes on its own. Never worth porting.
NOISE = re.compile(
    r"^(NSWindow Frame |NSSplitView |NSNavPanel|NSOSPLastRootDirectory$|NSToolbar Configuration |"
    r"NSStatusItem |SU(LastCheckTime|LastProfileSubmissionDate|UpdateGroupIdentifier|HasLaunchedBefore)$|"
    r"AppleLanguages$|com\.apple\.SwiftUI)"
)

PLACEHOLDER = re.compile(r"^@[A-Z_]+@$")


def run(cmd: list[str], **kw) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout


def flake_ref(host: str) -> str:
    # path: so git-ignored hosts/local.nix is visible to the flake.
    return f"path:{REPO}#darwinConfigurations.{host}"


def load_manifest(host: str) -> dict:
    expr = """c: let hm = c.home-manager.users.${c.system.primaryUser}; in {
      sync = hm.nixconfig.sync;
      defaults = hm.targets.darwin.defaults;
      data = hm.nixconfig.defaultsData;
      activation = hm.home.activationPackage.drvPath;
      darwin = {
        custom = c.system.defaults.CustomUserPreferences;
        global = c.system.defaults.NSGlobalDomain;
        dock = c.system.defaults.dock;
      };
    }"""
    out = run(["nix", "eval", "--json", flake_ref(host) + ".config", "--apply", expr])
    manifest = json.loads(out)
    # Generated files only exist in the store once built; this is a no-op
    # after a rebuild.
    run(["nix", "build", "--no-link", manifest["activation"] + "^*"])
    return manifest


# ---------------------------------------------------------------- live reads

def read_defaults(domain: str) -> dict | None:
    proc = subprocess.run(["/usr/bin/defaults", "export", domain, "-"], capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        return None
    return plistlib.loads(proc.stdout)


def read_file(path: Path):
    text = path.read_text()
    try:
        if path.suffix == ".json":
            return json.loads(text)
        if path.suffix == ".toml":
            return tomllib.loads(text)
    except ValueError:
        pass  # JSONC (Zed) and the like: compare as text.
    return text


def load_jsonc(text: str):
    """JSON with comments and trailing commas, as Zed writes it."""
    out: list[str] = []
    i, n, in_string = 0, len(text), False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\":
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif text.startswith("//", i):
            i = text.find("\n", i)
            if i == -1:
                break
            continue
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 2
            continue
        elif c in "}]":
            while out and out[-1].isspace():
                out.pop()
            if out and out[-1] == ",":
                out.pop()
            out.append(c)
        else:
            out.append(c)
        i += 1
    return json.loads("".join(out))


def expand(path: str) -> Path:
    return Path(os.path.expanduser(path))


# ---------------------------------------------------------------- comparison

def same(managed, live) -> bool:
    if isinstance(managed, bool) or isinstance(live, bool):
        return managed is live or managed == live and type(managed) is type(live)
    if isinstance(managed, (int, float)) and isinstance(live, (int, float)):
        return abs(managed - live) < 1e-9
    if isinstance(managed, dict) and isinstance(live, dict):
        return all(k in live and same(v, live[k]) for k, v in managed.items())
    if isinstance(managed, list) and isinstance(live, list):
        # A list of records (LSHandlers, ssh-keys) may hold entries the repo
        # does not own; each managed record just has to be present.
        if managed and all(isinstance(m, dict) for m in managed):
            return all(any(same(m, l) for l in live) for m in managed)
        return len(managed) == len(live) and all(same(m, l) for m, l in zip(managed, live))
    return managed == live


def decode_data(value):
    if isinstance(value, bytes):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def show(value, limit: int = 120) -> str:
    if isinstance(value, bytes):
        return f"<data, {len(value)} bytes>"
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def walk(managed: dict, live: dict, prefix: str, report: dict) -> None:
    """Compare a managed dict with a live one, recording dotted key paths."""
    placeholders = [k for k in managed if PLACEHOLDER.match(k)]
    managed = dict(managed)
    for ph in placeholders:
        # e.g. OpenLogi's @DEVICE@, swapped for a per-machine id at activation.
        candidates = [k for k in live if k not in managed]
        value = managed.pop(ph)
        if len(candidates) == 1:
            managed[candidates[0]] = value
        else:
            report["changed"].append((prefix + ph, "could not match placeholder to one live key", show(candidates)))

    for key, want in managed.items():
        path = prefix + key
        if key not in live:
            report["missing"].append((path, show(want)))
        elif isinstance(want, dict) and isinstance(live[key], dict):
            walk(want, live[key], path + ".", report)
        elif not same(want, live[key]):
            report["changed"].append((path, show(want), show(live[key])))
    for key in live:
        if key not in managed:
            report["unmanaged"].append((prefix + key, show(live[key])))


def new_report() -> dict:
    return {"changed": [], "missing": [], "unmanaged": []}


def check_copy(entry: dict) -> dict:
    report = new_report()
    live_path, managed_path = expand(entry["live"]), Path(entry["managed"])
    if not live_path.exists():
        report["missing"].append((entry["live"], "file"))
        return report
    managed, live = read_file(managed_path), read_file(live_path)
    if isinstance(managed, str) or isinstance(live, str):
        if managed != live:
            diff = difflib.unified_diff(
                str(managed).splitlines(), str(live).splitlines(), "repo", "live", lineterm="", n=1
            )
            report["changed"].append(("(file)", "\n" + "\n".join(diff), ""))
        return report
    # Every key of a copied file is managed, so live-only keys count as changes.
    walk(managed, live, "", report)
    report["changed"] += [(path, "(not in repo)", value) for path, value in report["unmanaged"]]
    report["unmanaged"] = []
    return report


def check_merge(entry: dict) -> dict:
    report = new_report()
    live_path = expand(entry["live"])
    if not live_path.exists():
        report["missing"].append((entry["live"], "file"))
        return report
    walk(entry["managed"], read_file(live_path), "", report)
    return report


def check_dir_list(entry: dict) -> dict:
    """Folders in `live` against the names set to true under `key` in `file`."""
    report = new_report()
    live_path = expand(entry["live"])
    managed = entry["managed"]
    declared = {
        name for name, on in load_jsonc(Path(managed["file"]).read_text()).get(managed["key"], {}).items() if on
    }
    installed = (
        {p.name for p in live_path.iterdir() if p.is_dir() and not p.name.startswith(".")}
        if live_path.is_dir()
        else set()
    )
    report["missing"] += [(name, f"{managed['key']}: not installed") for name in sorted(declared - installed)]
    # Each folder is a deliberate install, so one the repo lacks is drift.
    report["changed"] += [(name, "(not in repo)", "installed") for name in sorted(installed - declared)]
    return report


def check_defaults(domain: str, managed: dict) -> dict:
    report = new_report()
    live = read_defaults(domain)
    if live is None:
        report["missing"].append((domain, "domain (app never launched?)"))
        return report
    live = {k: decode_data(v) for k, v in live.items()}
    walk(managed, live, "", report)
    return report


def filter_unmanaged(report: dict, ignore: list[str]) -> None:
    patterns = [re.compile(p) for p in ignore]
    report["unmanaged"] = [
        (key, value)
        for key, value in report["unmanaged"]
        if not NOISE.search(key) and not any(p.search(key) for p in patterns)
    ]


# ---------------------------------------------------------------- main

def darwin_entries(darwin: dict) -> list[tuple[str, str, dict]]:
    def scalars(attrs: dict) -> dict:
        return {k: v for k, v in attrs.items() if v is not None}

    domains: dict[str, dict] = {}
    for domain, keys in darwin["custom"].items():
        domains.setdefault(domain, {}).update(keys)
    domains.setdefault("NSGlobalDomain", {}).update(scalars(darwin["global"]))
    domains.setdefault("com.apple.dock", {}).update(scalars(darwin["dock"]))
    return [(f"macos:{d}", d, keys) for d, keys in domains.items() if keys]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=os.environ.get("NIXCONFIG_HOST") or socket.gethostname().split(".")[0])
    parser.add_argument("--only", help="comma-separated entry names (see nixconfig.sync)")
    parser.add_argument("--changed-only", action="store_true", help="hide unmanaged keys")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    try:
        manifest = load_manifest(args.host)
    except subprocess.CalledProcessError as err:
        sys.stderr.write(err.stderr or str(err))
        return 2

    results = []
    for name, entry in sorted(manifest["sync"].items()):
        method = entry["method"]
        if method == "copy":
            report = check_copy(entry)
        elif method in ("json-merge", "toml-merge"):
            report = check_merge(entry)
        elif method == "dir-list":
            report = check_dir_list(entry)
        else:
            domain = entry["live"]
            managed = dict(manifest["defaults"].get(domain, {}))
            managed.update(manifest["data"].get(domain, {}))
            report = check_defaults(domain, managed)
        filter_unmanaged(report, entry["ignore"])
        results.append((name, method, entry["live"], entry["repo"], report))

    # nix-darwin system defaults: only managed keys are checked, since these
    # domains hold hundreds of unrelated system settings.
    for name, domain, managed in darwin_entries(manifest["darwin"]):
        report = check_defaults(domain, managed)
        report["unmanaged"] = []
        results.append((name, "defaults", domain, "modules/darwin/core/defaults/", report))

    if args.only:
        wanted = set(args.only.split(","))
        results = [r for r in results if r[0] in wanted]
    if args.changed_only:
        for r in results:
            r[4]["unmanaged"] = []

    drift = any(r[4]["changed"] or r[4]["missing"] for r in results)

    if args.json:
        print(json.dumps([
            {"name": n, "method": m, "live": l, "repo": rp, **rep} for n, m, l, rp, rep in results
        ], indent=2, ensure_ascii=False))
        return 1 if drift else 0

    for name, method, live, repo, report in results:
        if not any(report.values()):
            print(f"ok         {name}")
            continue
        status = "DRIFT" if report["changed"] or report["missing"] else "unmanaged"
        print(f"{status:<10} {name}  ({method}: {live})  edit {repo}")
        for key, want, got in report["changed"]:
            print(f"    changed    {key}: repo={want} live={got}")
        for key, want in report["missing"]:
            print(f"    missing    {key}: repo={want}")
        for key, got in report["unmanaged"]:
            print(f"    unmanaged  {key} = {got}")
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
