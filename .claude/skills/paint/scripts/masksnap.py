#!/usr/bin/env python3
"""Snap a rough outline to the reference: the region polygon drawn by eye is
only trusted away from its edge; in a band around it each pixel joins
whichever side its colour matches better, judged against the colours of the
two sides nearby. Writes the refined outline back as a polygon.

  masksnap.py TARGET ROLES.json NAME OUT.json [--band-mm 4] [--preview P.png]
"""
import argparse, json, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W_MM = 304.8


def lab_of(rgb):
    c = rgb / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def box(a, r):
    """mean over a (2r+1)^2 box, via integral images"""
    pad = np.pad(a, [(r + 1, r)] + [(r + 1, r)] + [(0, 0)] * (a.ndim - 2), mode='edge')
    c = pad.cumsum(0).cumsum(1)
    n = 2 * r + 1
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n * n)


def grow(m, r):
    for _ in range(r):
        e = m.copy(); e[1:] |= m[:-1]; e[:-1] |= m[1:]; e[:, 1:] |= m[:, :-1]; e[:, :-1] |= m[:, 1:]; m = e
    return m


def trace(mask):
    """outer boundary of the largest blob, as a polygon (pixel coords), simplified"""
    from collections import deque
    H, W = mask.shape
    lab = np.zeros(mask.shape, int); best, bn = 0, 0; k = 0
    for y0 in range(H):
        for x0 in range(W):
            if mask[y0, x0] and not lab[y0, x0]:
                k += 1; q = deque([(y0, x0)]); lab[y0, x0] = k; n = 0
                while q:
                    y, x = q.popleft(); n += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        yy, xx = y + dy, x + dx
                        if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not lab[yy, xx]:
                            lab[yy, xx] = k; q.append((yy, xx))
                if n > bn: bn, best = n, k
    m = lab == best
    # Moore neighbour tracing
    ys, xs = np.nonzero(m)
    start = (ys[0], xs[0])
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    pts = [start]; cur = start; d = 6
    for _ in range(200000):
        for i in range(8):
            nd = (d + i) % 8
            y, x = cur[0] + dirs[nd][0], cur[1] + dirs[nd][1]
            if 0 <= y < H and 0 <= x < W and m[y, x]:
                cur = (y, x); d = (nd + 5) % 8; pts.append(cur); break
        if cur == start and len(pts) > 2: break
    P = np.array([(x, y) for y, x in pts], float)
    # Douglas–Peucker
    def rdp(P, tol):
        if len(P) < 3: return P
        a, b = P[0], P[-1]; ab = b - a; L = np.hypot(*ab) or 1
        d = np.abs(ab[0] * (P[:, 1] - a[1]) - ab[1] * (P[:, 0] - a[0])) / L
        i = int(d.argmax())
        if d[i] > tol: return np.vstack([rdp(P[:i + 1], tol)[:-1], rdp(P[i:], tol)])
        return np.array([a, b])
    # a closed loop: split at the point farthest from the start
    k = int(np.hypot(*(P - P[0]).T).argmax())
    return np.vstack([rdp(P[:k + 1], 1.0)[:-1], rdp(P[k:], 1.0)]), m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target'); ap.add_argument('roles'); ap.add_argument('name'); ap.add_argument('out')
    ap.add_argument('--band-mm', type=float, default=4.0); ap.add_argument('--preview')
    a = ap.parse_args()
    im = Image.open(a.target).convert('RGB')
    W0, H0 = im.size
    s = 2.0                                   # px per mm
    W, H = int(W_MM * s), int(W_MM * s * H0 / W0)
    T = lab_of(np.asarray(im.resize((W, H), Image.LANCZOS)).astype(float))
    T = box(T, 1)
    R = json.load(open(a.roles))
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon([(x * W, y * H) for x, y in R[a.name]], fill=255)
    rough = np.asarray(m) > 127
    band = int(a.band_mm * s)
    inside = ~grow(~rough, band)              # trusted bird
    outside = ~grow(rough, band)              # trusted background
    lab = rough.copy()
    for it in range(4):
        fg = (lab & ~(grow(~lab, 1))) | inside
        bg = (~lab & ~grow(lab, 1)) | outside
        r = 3 * band
        mf = box(T * fg[..., None], r); nf = box(fg[..., None].astype(float), r)
        mb = box(T * bg[..., None], r); nb = box(bg[..., None].astype(float), r)
        cf = mf / np.maximum(nf, 1e-3); cb = mb / np.maximum(nb, 1e-3)
        df = np.sqrt(((T - cf) ** 2).sum(-1)); db = np.sqrt(((T - cb) ** 2).sum(-1))
        new = df < db
        free = ~inside & ~outside
        lab = np.where(free, new, rough)
        # smooth the decision a little (majority over 5x5)
        lab = box(lab[..., None].astype(float), 2)[..., 0] > 0.5
        lab |= inside; lab &= ~outside
    P, blob = trace(lab)
    poly = [[round(x / W, 4), round(y / H, 4)] for x, y in P]
    R2 = dict(R); R2[a.name] = poly
    json.dump(R2, open(a.out, 'w'))
    if a.preview:
        pv = im.copy(); d = ImageDraw.Draw(pv)
        d.line([(x * W0, y * H0) for x, y in R[a.name]] + [(R[a.name][0][0] * W0, R[a.name][0][1] * H0)], fill=(255, 0, 255), width=2)
        d.line([(x * W0, y * H0) for x, y in poly] + [(poly[0][0] * W0, poly[0][1] * H0)], fill=(0, 255, 0), width=3)
        pv.save(a.preview)
    print(json.dumps({'points': len(poly), 'area': round(float(blob.mean()), 4)}))


if __name__ == '__main__':
    main()
