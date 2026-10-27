# System and peripheral utilities
[
  "lihaoyun6/tap/airbattery"
  "betterdisplay"
  "karabiner-elements"
  "macmediakeyforwarder"
  "openlogi"
  # Taps from its own repo; see ./default.nix. `version :latest` casks only
  # upgrade when greedy.
  { name = "arthur-fontaine/mixologist/mixologist"; greedy = true; }
]
