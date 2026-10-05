#!/usr/bin/env python3
"""Accents a painter puts down as single deliberate touches: an eye, a
catchlight, a highlight on a beak, the dark of a nostril. Finds small blobs
in the reference that stand out from their surroundings (darker or lighter
by `contrast` L*), which the painting does not have yet, and paints each as
one gesture sized to it: a round blob as a small spiral of a round brush
pressed to about the blob's width, an elongated one as a short stroke along
its length.

  dabs.py RUN_DIR SPEC.json OUT.json --render CURRENT.png [--preview P.png]

SPEC: kind "dark"|"light", box [x0,y0,x1,y1], contrast (L*, default 14),
max_mm (largest blob, default 7), min_mm (default 0.6), miss (ΔE the
painting must be off by, default 8), surround_mm (default 3), label, seed.
"""
import argparse, json, math, random, sys, os
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paintplan import lab_of, blur, to_gesture, lab_to_hex, W_MM, H_MM

ROUND_NO = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24]


def components(mask):
    from collections import deque
    H, W = mask.shape
    lab = np.zeros(mask.shape, int); out = []; k = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]: continue
        k += 1; q = deque([(y0, x0)]); lab[y0, x0] = k; pts = []
        while q:
            y, x = q.popleft(); pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = k; q.append((yy, xx))
        out.append(np.array(pts))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run'); ap.add_argument('spec'); ap.add_argument('out')
    ap.add_argument('--render', required=True); ap.add_argument('--preview')
    a = ap.parse_args()
    S = json.load(open(a.spec)); rnd = random.Random(S.get('seed', 1))
    ppm = S.get('px_per_mm', 8.0)
    x0, y0, x1, y1 = S.get('box', [0, 0, 1, 1])
    X0, Y0 = int(x0 * W_MM * ppm), int(y0 * H_MM * ppm)
    Wb, Hb = int((x1 - x0) * W_MM * ppm), int((y1 - y0) * H_MM * ppm)
    def crop(path):
        im = Image.open(path).convert('RGB')
        w, h = im.size
        box = (x0 * w, y0 * h, x1 * w, y1 * h)
        return lab_of(np.asarray(im.crop(box).resize((Wb, Hb), Image.LANCZOS)).astype(float))
    T = blur(crop(f'{a.run}/target.png'), 0.6)
    C = blur(crop(a.render), 0.6)
    sur = blur(T[..., 0], S.get('surround_mm', 3.0) * ppm)
    d = T[..., 0] - sur
    dark = S.get('kind', 'dark') == 'dark'
    con = S.get('contrast', 14.0)
    mask = (d < -con) if dark else (d > con)
    miss = S.get('miss', 8.0)
    acts, marks = [], []
    for P in components(mask):
        area_mm2 = len(P) / ppm ** 2
        eq = 2 * math.sqrt(area_mm2 / math.pi)
        if eq < S.get('min_mm', 0.6) or eq > S.get('max_mm', 7.0): continue
        ys, xs = P[:, 0], P[:, 1]
        col = T[ys, xs].mean(0) if not dark else np.percentile(T[ys, xs], 30, axis=0)
        have = C[ys, xs].mean(0)
        if np.sqrt(((have - col) ** 2).sum()) < miss: continue
        # shape: principal axes
        cy, cx = ys.mean(), xs.mean()
        cov = np.cov(np.stack([xs - cx, ys - cy]))
        ev, evec = np.linalg.eigh(cov)
        L = 4 * math.sqrt(max(ev[1], 1e-6)) / ppm      # length (mm), ~full extent
        Wd = 4 * math.sqrt(max(ev[0], 1e-6)) / ppm     # width (mm)
        u = evec[:, 1]
        c_mm = np.array([(X0 + cx) / ppm, (Y0 + cy) / ppm])
        hexc = lab_to_hex(col)
        # a round that, pressed, is about the blob's width
        width = max(0.5, min(Wd, 6.0))
        size = min(range(len(ROUND_NO)), key=lambda i: abs((0.9 + 0.62 * ROUND_NO[i]) * 0.75 - width))
        dmm = 0.9 + 0.62 * ROUND_NO[size]
        p = max(0.35, min(0.85, 0.5 + (width / dmm - 0.52) / 2.4))
        ex = {"brush": "round", "size": size, "pressure": round(p, 3), "load": 0.9, "color": hexc}
        if L / max(Wd, 1e-3) > 1.8:
            # elongated: one stroke along it
            Q = np.array([c_mm - u * L * 0.42, c_mm + u * L * 0.42])
            Q = np.vstack([Q[0], (Q[0] + Q[1]) / 2, Q[1]])
            acts.append(to_gesture(Q, f"{S.get('label', 'accent')} {hexc}", 60, max(0.6, L / 3), ex, rnd, {'heading_deg': 1.0, 'wobble_deg': 1.0, 'length_frac': 0.03}))
        else:
            # round: a small spiral from the centre out to fill it
            r_out = max(0.0, eq / 2 - width / 2)
            turns = 1.5 if r_out > 0.3 else 0.6
            n = 24
            Q = np.array([c_mm + (r_out * (k / n) ** 0.7) * np.array([math.cos(2 * math.pi * turns * k / n), math.sin(2 * math.pi * turns * k / n)]) for k in range(n + 1)])
            if r_out <= 0.3:
                Q = np.array([c_mm - u * 0.3, c_mm, c_mm + u * 0.3])
            acts.append(to_gesture(Q, f"{S.get('label', 'accent')} {hexc}", 30, max(0.3, eq / 6), ex, rnd, {'heading_deg': 0.5, 'wobble_deg': 0.5, 'length_frac': 0.02}))
        marks.append((c_mm, eq, L, Wd, u, hexc))
    # largest first: an eye before the catchlight that sits in it
    order = sorted(range(len(acts)), key=lambda i: -marks[i][1])
    acts = [acts[i] for i in order]
    out = ([{"type": "dry", "label": "let it dry"}] if S.get('dry_first', True) else []) + acts
    json.dump(out, open(a.out, 'w'))
    if a.preview:
        im = Image.open(f'{a.run}/target.png').convert('RGB'); w, h = im.size
        box = (int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h))
        im = im.crop(box).resize((Wb, Hb), Image.LANCZOS); dr = ImageDraw.Draw(im)
        for c_mm, eq, L, Wd, u, hexc in marks:
            cx, cy = c_mm[0] * ppm - X0, c_mm[1] * ppm - Y0
            r = eq / 2 * ppm
            dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 0, 255) if dark else (0, 200, 255), width=2)
        im.save(a.preview)
    print(json.dumps({'accents': len(acts)}))


if __name__ == '__main__':
    main()
