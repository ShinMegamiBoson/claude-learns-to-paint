#!/usr/bin/env python3
"""Salience map from a colour-coded segmentation of the reference (made by an
image model asked to fill each part with a given colour): each pixel takes
the weight of the nearest part colour; cropped like the target.

  salience.py SEGMENTATION.png TARGET.png PARTS.json OUT_salience.png OUT_labels.png [--preview P.png]

PARTS.json: {"eye": {"rgb": [255,0,0], "w": 8}, ...}; unmatched pixels get w 1.
The salience PNG stores weight x 25 (grey); paintmulti reads it with "salience".
"""
import json, sys
import numpy as np
from PIL import Image

seg_f, tgt_f, parts_f, out_s, out_l = sys.argv[1:6]
prev = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
P = json.load(open(parts_f))
seg = Image.open(seg_f).convert('RGB')
tw, th = Image.open(tgt_f).size
# the target is the reference centre-cropped to the sheet's aspect
w, h = seg.size
if w / h > tw / th:
    nw = round(h * tw / th); x0 = (w - nw) // 2; seg = seg.crop((x0, 0, x0 + nw, h))
else:
    nh = round(w * th / tw); y0 = (h - nh) // 2; seg = seg.crop((0, y0, w, y0 + nh))
seg = seg.resize((tw, th), Image.NEAREST)
A = np.asarray(seg).astype(float)
names = list(P); cols = np.array([P[n]['rgb'] for n in names], float)
d = np.sqrt(((A[:, :, None, :] - cols[None, None]) ** 2).sum(-1))
k = d.argmin(-1); far = d.min(-1) > 90
weights = np.array([P[n]['w'] for n in names], float)
W = np.where(far, 1.0, weights[k])
lab = np.where(far, 255, k).astype(np.uint8)
Image.fromarray(np.clip(W * 25, 0, 255).astype(np.uint8)).save(out_s)
Image.fromarray(lab).save(out_l)
json.dump({'names': names}, open(out_l.replace('.png', '.json'), 'w'))
if prev:
    t = np.asarray(Image.open(tgt_f).convert('L')).astype(float)
    v = (W - 1) / (weights.max() - 1)
    Image.fromarray(np.clip(np.stack([t * 0.45 + v * 230, t * 0.45 + v * 90, t * 0.45], -1), 0, 255).astype(np.uint8)).save(prev)
print(json.dumps({n: round(float((k == i)[~far].mean()) if (~far).any() else 0, 4) for i, n in enumerate(names)}))
