from PIL import Image
# Per file row: the x (pt) where the letter, the name, the + and − figures and the › ink lie.
def cols(path, th="dark"):
    im=Image.open(path).convert("RGB"); W,H=im.size; bg=im.getpixel((W//2,H-20))
    far=lambda p: sum(abs(a-b) for a,b in zip(p,bg))>60
    out=[]
    for y0 in range(140, 700, 2):
        xs=[x for x in range(0,W) if far(im.getpixel((x,y0)))]
        if len(xs)<20: continue
        runs=[]; 
        for x in xs:
            if runs and x-runs[-1][1]<=8: runs[-1][1]=x
            else: runs.append([x,x])
        if len(runs)>=4: out.append((y0, [(a/2,b/2) for a,b in runs]))
    return out
for name in ["files","changes"]:
    rows=cols(f"/tmp/r2/t-{name}-dark-panel.png")
    seen=set()
    print(name)
    for y,r in rows:
        k=round(y/52)
        if k in seen: continue
        seen.add(k); print(f"  y {y/2:.0f}: " + "  ".join(f"{a:.1f}-{b:.1f}" for a,b in r))
