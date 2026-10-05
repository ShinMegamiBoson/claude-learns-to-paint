#!/usr/bin/env python3
"""Where to look closer next. Zoom levels: 0 the whole sheet, 1 regions
(tiles about a third of the sheet across), 2 parts (head, wing, legs, each
bud... from the segmentation's labels), 3 features (eye, beak). For a level,
rank its tiles by how much salience-weighted error the painting still has in
them (at that level's sharpness) and print the worth-while ones as boxes.

  levels.py RUN_DIR --render CURRENT.png --level 1|2|3 [--top 6] [--min 0.0]
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paintplan import lab_of, blur, W_MM, H_MM

ap = argparse.ArgumentParser()
ap.add_argument('run'); ap.add_argument('--render', required=True); ap.add_argument('--level', type=int, required=True)
ap.add_argument('--top', type=int, default=6); ap.add_argument('--min', type=float, default=0.0)
a = ap.parse_args()
ppm = 2.0
Wp, Hp = int(W_MM * ppm), int(H_MM * ppm)
sharp = {1: 0.6, 2: 0.35, 3: 0.2}[a.level] * ppm
T = blur(lab_of(np.asarray(Image.open(f'{a.run}/target.png').convert('RGB').resize((Wp, Hp), Image.LANCZOS)).astype(float)), sharp)
C = blur(lab_of(np.asarray(Image.open(a.render).convert('RGB').resize((Wp, Hp), Image.LANCZOS)).astype(float)), sharp)
sal = np.asarray(Image.open(f'{a.run}/salience.png').convert('L').resize((Wp, Hp), Image.BILINEAR)).astype(float) / 25.0
E = np.sqrt(((T - C) ** 2).sum(-1)) * np.maximum(sal, 1.0)
lab = np.asarray(Image.open(f'{a.run}/labels.png').resize((Wp, Hp), Image.NEAREST))
names = json.load(open(f'{a.run}/labels.json'))['names']
tiles = []
if a.level == 1:
    tw, th = 0.34, 0.34
    for y0 in np.arange(0, 1 - th + 1e-9, th / 2):
        for x0 in np.arange(0, 1 - tw + 1e-9, tw / 2):
            tiles.append(('region', [round(x0, 3), round(y0, 3), round(x0 + tw, 3), round(y0 + th, 3)]))
else:
    want = {2: ['head', 'throat', 'breast', 'wing', 'tail', 'undertail', 'legs', 'buds', 'beak', 'branch'], 3: ['eye', 'eye ring', 'beak']}[a.level]
    from collections import deque
    for nm in want:
        if nm not in names: continue
        m = lab == names.index(nm)
        # each connected piece of a part (each bud, each leg) its own tile
        seen = np.zeros_like(m)
        for y, x in zip(*np.nonzero(m)):
            if seen[y, x]: continue
            q = deque([(y, x)]); seen[y, x] = True; ys, xs = [y], [x]
            while q:
                yy, xx = q.popleft()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    v, u = yy + dy, xx + dx
                    if 0 <= v < Hp and 0 <= u < Wp and m[v, u] and not seen[v, u]:
                        seen[v, u] = True; q.append((v, u)); ys.append(v); xs.append(u)
            if len(ys) < 12: continue
            pad = 3 * ppm
            b = [max(0, min(xs) - pad) / Wp, max(0, min(ys) - pad) / Hp, min(Wp, max(xs) + pad) / Wp, min(Hp, max(ys) + pad) / Hp]
            # big parts in pieces no larger than ~60 mm
            nx = max(1, int(np.ceil((b[2] - b[0]) * W_MM / 60))); ny = max(1, int(np.ceil((b[3] - b[1]) * H_MM / 60)))
            for i in range(nx):
                for j in range(ny):
                    bb = [b[0] + (b[2] - b[0]) * i / nx, b[1] + (b[3] - b[1]) * j / ny, b[0] + (b[2] - b[0]) * (i + 1) / nx, b[1] + (b[3] - b[1]) * (j + 1) / ny]
                    tiles.append((nm, [round(v, 4) for v in bb]))
out = []
for nm, b in tiles:
    x0, y0, x1, y1 = int(b[0] * Wp), int(b[1] * Hp), int(b[2] * Wp), int(b[3] * Hp)
    sub = E[y0:y1, x0:x1]
    if sub.size == 0: continue
    out.append({'part': nm, 'box': b, 'weighted_err': round(float(sub.sum()) / ppm ** 2 / 1000, 2), 'mean': round(float(sub.mean()), 2)})
out.sort(key=lambda t: -t['weighted_err'])
# skip tiles mostly covered by better-ranked ones
picked = []
for t in out:
    b = t['box']
    ov = max([max(0, min(b[2], p['box'][2]) - max(b[0], p['box'][0])) * max(0, min(b[3], p['box'][3]) - max(b[1], p['box'][1])) / ((b[2] - b[0]) * (b[3] - b[1])) for p in picked] or [0])
    if ov < 0.5 and t['weighted_err'] >= a.min: picked.append(t)
    if len(picked) >= a.top: break
print(json.dumps(picked))
