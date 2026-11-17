import sys
from PIL import Image
def lum(c):
    def ch(v):
        v/=255; return v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
    r,g,b=c[:3]; return 0.2126*ch(r)+0.7152*ch(g)+0.0722*ch(b)
def cr(a,b):
    x,y=sorted([lum(a),lum(b)],reverse=True); return (x+0.05)/(y+0.05)
def hexc(c): return "#%02x%02x%02x"%c[:3]
out=[]
for th in ["dark","light"]:
    ov=Image.open(f"/tmp/r2/t-overview-{th}-panel.png").convert("RGB"); W,H=ov.size
    isl=ov.getpixel((W//2,H-20))
    # bars: rows where x=40 differs from the island, under the status block
    bars=[]; y=200
    while y<520:
        if cr(ov.getpixel((40,y)),isl)>1.15:
            top=y
            while cr(ov.getpixel((40,y)),isl)>1.15: y+=1
            if 6<=y-top<=10: bars.append((top,y))
        y+=1
    # the 5-hour bar: the first bar with a notch showing 2 pt (4 px) above it
    for top,bot in bars:
        xs=[x for x in range(40,W-40) if cr(ov.getpixel((x,top-3)),isl)>1.5] if 6<=bot-top<=10 else []
        if xs: break
    mid=(top+bot)//2; nx=xs[0]
    fill=ov.getpixel((40,mid)); track=ov.getpixel((W-60,mid)); notch=ov.getpixel((nx,top-3))
    out.append(f"== {th} (island {hexc(isl)})")
    out.append(f"meter track vs island   {cr(track,isl):.2f}:1  ({hexc(track)})   target >= 1.25")
    out.append(f"meter fill vs track     {cr(fill,track):.2f}:1  ({hexc(fill)})   target >= 3.5")
    out.append(f"pace notch vs island    {cr(notch,isl):.2f}:1  ({hexc(notch)}, 2 pt above the bar at x={nx/2:.1f} pt)   target >= 3")
    # trailing chevrons: the most contrasting pixel in the › column of the Recent calls rows
    best=max((ov.getpixel((x,y)) for x in range(655,690) for y in range(600,900)), key=lambda p: cr(p,isl))
    out.append(f"trailing chevron        {cr(best,isl):.2f}:1  ({hexc(best)}, darkest stroke pixel)   target >= 3")
    # tree guide: a 1-2 px vertical run left of step rows
    cs=Image.open(f"/tmp/r2/t-calls-{th}-panel.png").convert("RGB")
    guide=None
    for x in range(30,120):
        col=[cs.getpixel((x,y)) for y in range(400,1000)]
        runs=[p for p in col if 1.15<cr(p,isl)<2.0]
        if len(runs)>200: guide=max(set(runs),key=runs.count); gx=x; break
    out.append(f"tree guide vs island    {cr(guide,isl):.2f}:1  ({hexc(guide)}, x={gx/2:.1f} pt)   target ~1.4" if guide else "tree guide: not found")
    sc=Image.open(f"/tmp/r2/t-call-script-{th}-panel.png").convert("RGB")
    code=sc.getpixel((60,260))
    out.append(f"code block vs island    {cr(code,isl):.2f}:1  ({hexc(code)}, {'lighter' if lum(code)>lum(isl) else 'darker'} than the island)   rule: one step above, border in light only")
print("\n".join(out))
