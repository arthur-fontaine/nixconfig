import subprocess, sys, os
from PIL import Image
# info-loaded.py shot.png well_hex: exit 0 when the Info overview in the shot has loaded its session.
# Only a loaded overview draws the divider above Recent calls, across the panel's full width:
# nothing else reaches the column 10 pt in from its left edge below the header (text, meters and
# rows start at 18 pt). Loading, it shows the name, "Loading session…" and maybe the limits.
here = os.path.dirname(os.path.abspath(__file__))
crop = sys.argv[1] + ".panel.png"
subprocess.run([sys.executable, os.path.join(here, "info-panel.py"), sys.argv[1], sys.argv[2], crop], capture_output=True)
im = Image.open(crop).convert("RGB"); os.remove(crop)
W, H = im.size
bg = im.getpixel((W // 2, H - 20))
far = lambda p: sum(abs(a - b) for a, b in zip(p, bg)) > 6
divider = any(far(im.getpixel((20, y))) and far(im.getpixel((W - 20, y))) for y in range(140, min(H, 1100)))
sys.exit(0 if divider else 1)
