import sys
from PIL import Image
# usage: <script> <shot prefix>: reads <prefix>-<state>-<theme>-panel.png (info-shots' crops).
PREFIX = sys.argv[1]
for th in ["dark","light"]:
    im=Image.open(f"{PREFIX}-back-{th}-panel.png").convert("RGB"); W,H=im.size; bg=im.getpixel((W//2,H-20))
    far=lambda p,d=40: sum(abs(a-b) for a,b in zip(p,bg))>d
    runs={x: sum(1 for y in range(240,H-40) if far(im.getpixel((x,y)))) for x in range(W-40,W-4)}
    tx=min(x for x,n in runs.items() if n>60)
    ys=[y for y in range(240,H-40) if far(im.getpixel((tx+2,y)))]
    y0,y1=min(ys),max(ys)
    # chevrons on the rows below the thumb (same column), so the thumb's edge isn't counted
    chev=max(x for x in range(W-90,tx) for y in range(y1+10,min(H-40,y1+400)) if far(im.getpixel((x,y))))
    print(f"{th}: chevron ink ends {chev/2:.1f} pt, thumb starts {tx/2:.1f} pt, gap {(tx-chev-1)/2:.1f} pt")
