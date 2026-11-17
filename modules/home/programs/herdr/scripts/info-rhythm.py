import sys
from PIL import Image
# Ink blocks down the overview's text column (x 30..560 px of the 2x panel crop), as pt, and
# the gaps between them; label left edges for the meters.
for th in sys.argv[2:] or ["dark"]:
    im=Image.open(f"{sys.argv[1]}-{th}-panel.png").convert("RGB"); W,H=im.size; bg=im.getpixel((W//2,H-20))
    far=lambda p,d=24: sum(abs(a-b) for a,b in zip(p,bg))>d
    rows=[y for y in range(80,700) if any(far(im.getpixel((x,y))) for x in range(30,560,2))]
    blocks=[]; 
    for y in rows:
        if blocks and y-blocks[-1][1]<=2: blocks[-1][1]=y
        else: blocks.append([y,y])
    print(th)
    for i,(a,b) in enumerate(blocks):
        left=min((x for x in range(0,560) for y in range(a,b+1,1) if far(im.getpixel((x,y)))), default=-1)
        gap = f"gap {(a-blocks[i-1][1]-1)/2:.1f}" if i else ""
        print(f"  {a/2:6.1f}-{b/2:6.1f} pt  left {left/2:5.1f} pt  {gap}")
