import subprocess, sys, os
from PIL import Image
# info-loaded.py shot.png well_hex: exit 0 when the Info panel in the shot has loaded its session.
# A panel still loading shows its name, "Loading session…" and at most the limits (read apart, and
# often first); a loaded one has Recent calls under them. Exit 1 while loading.
here = os.path.dirname(os.path.abspath(__file__))
crop = sys.argv[1] + ".panel.png"
subprocess.run([sys.executable, os.path.join(here, "info-panel.py"), sys.argv[1], sys.argv[2], crop], capture_output=True)
im = Image.open(crop).convert("RGB"); os.remove(crop)
W, H = im.size
bg = im.getpixel((W // 2, H - 20))
ink = total = 0
for y in range(540, min(H, 900), 2):
    for x in range(30, W - 30, 2):
        total += 1
        if sum(abs(a - b) for a, b in zip(im.getpixel((x, y)), bg)) > 40: ink += 1
sys.exit(0 if total and ink / total > 0.01 else 1)
