"""Fusions of two end-of-turn detectors, from the scores eot_bench.py saved (same VAD, same query times).

    python eot_fuse.py [resultdir]

Tries fusion rules and fallback timeouts on voxturn+text and smart-turn-3.2.
"""

import json
import statistics
import sys
from pathlib import Path

results = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/k12-results")
A = json.loads((results / "eot-voxturn+text.json").read_text())["clips"]
B = json.loads((results / "eot-smart-turn-3.2.json").read_text())["clips"]

RULES = {
    "voxturn+text >= .5": lambda a, b: a >= 0.5,
    "smart-turn >= .5": lambda a, b: b >= 0.5,
    "sqrt(vox*smart) >= .5": lambda a, b: (a * b) ** 0.5 >= 0.5,
    "vox >= .5 or (smart >= .9 and vox >= .1)": lambda a, b: a >= 0.5 or (b >= 0.9 and a >= 0.1),
    "vox >= .5 or (smart >= .95 and vox >= .2)": lambda a, b: a >= 0.5 or (b >= 0.95 and a >= 0.2),
}


def evaluate(rule, timeout):
    cut = holds = 0
    lat = []
    for cid in A:
        for sa, sb in zip(A[cid]["silences"], B[cid]["silences"]):
            fire = next((ta for (ta, pa), (_, pb) in zip(sa["points"], sb["points"]) if ta < sa["start"] + timeout and rule(pa, pb)), None)
            if fire is None and sa["end"] >= sa["start"] + timeout:
                fire = sa["start"] + timeout
            if sa["is_end"]:
                lat.append((fire if fire is not None else sa["start"] + timeout) - A[cid]["eot"])
                break
            holds += 1
            cut += fire is not None
    return cut, holds, statistics.median(lat), max(lat), sum(l > timeout - 0.1 for l in lat)


print(f"{'rule':44s} {'timeout':>7s} {'cut':>6s} {'median':>7s} {'max':>6s} {'timeouts':>8s}")
for name, rule in RULES.items():
    for timeout in (3.0, 2.0, 1.5):
        cut, holds, med, mx, to = evaluate(rule, timeout)
        print(f"{name:44s} {timeout:7.1f} {cut:>3d}/{holds:<2d} {1000 * med:7.0f} {1000 * mx:6.0f} {to:8d}")
