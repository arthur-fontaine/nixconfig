import sys
from PIL import Image
# info-panel.py shot.png well_hex crop.png: finds the panel island (the rightmost island at
# mid-height, by the well colour around it), saves it alone, and checks its corners like k31's
# inner.py: the island's own corner (3 px in = well) and the content's corner just inside the
# 10 px padding (13 px in on the diagonal = the padding's colour, if the content is rounded).
# A content corner whose fill is the padding's colour anyway can't tell: "same fill".
im = Image.open(sys.argv[1]).convert("RGB"); W, H = im.size
well = tuple(int(sys.argv[2][i:i + 2], 16) for i in (1, 3, 5))
near = lambda p, q, d=2: all(abs(a - b) <= d for a, b in zip(p, q))
cy = H // 2
x1 = W - 1
while x1 > 0 and near(im.getpixel((x1, cy)), well): x1 -= 1
if not near(im.getpixel((W - 4, 4)), well, 6):
    print(f"the window's corner isn't the well {sys.argv[2]}: {im.getpixel((W - 4, 4))}"); sys.exit(2)
# The left edge is where 4 well pixels in a row start (one antialiased text pixel can match).
x0 = x1
while x0 > 3 and not all(near(im.getpixel((x0 - 1 - k, cy)), well) for k in range(4)): x0 -= 1
# The edge is where 4 well pixels in a row start: one antialiased pixel inside can match the well.
# Three columns clear of the corners; the tightest box wins (a long tab strip, a toast or the panel
# buttons can touch the island at one of them).
wellrun = lambda x, y, d: all(0 <= y + d * k < H and near(im.getpixel((x, y + d * k)), well) for k in range(4))
def edges(x):
    a = cy
    while a > 0 and not wellrun(x, a - 1, -1): a -= 1
    b = cy
    while b < H - 1 and not wellrun(x, b + 1, 1): b += 1
    return a, b
found = [edges(x) for x in (x0 + 40, (x0 + x1) // 2, x1 - 40)]
y0 = max(a for a, _ in found); y1 = min(b for _, b in found)
print(f"panel x{x0}-{x1} y{y0}-{y1} ({x1 - x0 + 1}x{y1 - y0 + 1} px)")
im.crop((x0, y0, x1 + 1, y1 + 1)).save(sys.argv[3])
bad = 0
for c, (x, y, dx, dy) in {"tl": (x0, y0, 1, 1), "tr": (x1, y0, -1, 1), "bl": (x0, y1, 1, -1), "br": (x1, y1, -1, -1)}.items():
    outer = near(im.getpixel((x + 3 * dx, y + 3 * dy)), well)
    ring = im.getpixel((x + 6 * dx, y + 40 * dy))      # the padding, beside the content
    edge = im.getpixel((x + 13 * dx, y + 13 * dy))     # the content's corner
    fill = im.getpixel((x + 24 * dx, y + 24 * dy))     # the content itself
    same = near(fill, ring, 3)
    inner = near(edge, ring, 3)
    ok = outer and inner; bad += not ok
    verdict = "same fill (can't tell)" if same else ("round" if inner else "SQUARE")
    print(f"{c} island {'round' if outer else 'SQUARE'}; content {verdict} (corner {edge}, content {fill}, padding {ring})")
sys.exit(1 if bad else 0)
