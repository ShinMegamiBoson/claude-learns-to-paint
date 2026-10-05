#!/usr/bin/env python3
"""Plan a pass of opaque brushstrokes (gouache) from what is still missing.

  paintplan.py RUN_DIR SPEC.json OUT.json [--render CURRENT.png] [--preview OUT.png]

A painter working big to small: for one brush, look over the sheet a
brush-width at a time; wherever the painting is still far from the
reference (colour difference, ΔE), start a stroke there in the reference's
colour (averaged over the brush's footprint) and carry it along the forms
(the reference's edge direction, or a fixed hand angle where there is no
clear direction) for as long as laying that colour keeps helping. Each
planned stroke is laid on a copy of the painting before the next is chosen,
so strokes do not pile up on the same spot. The strokes' colours are then
pooled into a few palette mixes (a painter mixes a handful of colours per
pass, not one per stroke) and ordered dark to light, so lights land on top.
Each stroke becomes a gesture (start, launch, turns) with a hand's
imprecision, to be drawn by the hand model.

SPEC (all optional except brush/size):
  brush, size          the brush (flat, filbert, round, rigger)
  width_mm             the mark's width (default: from the brush and pressure)
  pressure, load       (default 0.6, 0.8)
  box [x0,y0,x1,y1]    only this part of the sheet (fractions)
  grid_mm              spacing of the look-over (default 0.8 x width)
  threshold            ΔE a spot must miss by to get a stroke (default 10)
  max_len_mm, min_len_mm, step_mm
  trace_tol            ΔE the reference may drift from a stroke's colour along it (longer strokes)
  weights              [{"region": name, "w": 2}, {"box": [x0,y0,x1,y1], "w": 4}]: where error
                       counts more (where people look: the subject, its face), for greedy
  refine               greedy: before a stroke goes down, try it shifted, turned, shorter and
                       longer, and keep whichever takes off the most error (default true)
  field                "edges" (follow the reference's forms), or a number:
                       a fixed angle in degrees (0 = left to right)
  hand_deg             the hand's own direction where the forms give none (default -30)
  curve_deg_per_mm     how quickly a stroke may turn (default 4)
  mixes                how many palette mixes for the pass (default 12)
  order                "dark-first" (default), "light-first", "as-found"
  dry_between          dry the sheet between mixes (accents that must not smear)
  select               "sweep" (default: every spot over threshold gets a stroke) or
                       "greedy": as few strokes as possible: candidates from every spot,
                       then the one that takes the most error off the sheet goes down
                       first, again and again, until `budget` strokes or until the best
                       left would take off less than `min_gain` (ΔE·mm²); painted in that
                       order (the big wins first), each in the colour that best fits its
                       footprint
  speed                mm/s (default from the brush size)
  coverage             how fully a planned stroke counts as covering (0..1, default 0.85)
  only                 "darker" or "lighter": accents only where the painting must go that way
  regions              {"file": "roles.json", "use": [names]} or {"file": ..., "avoid": [names]}:
                       polygons (sheet fractions); strokes start inside and stop at the edge,
                       so a region is cut in with a clean silhouette
  px_per_mm            planning resolution (default 2; 4-6 for small brushes)
  imprecision          {heading_deg, wobble_deg, length_frac} (default small)
  seed, label
"""
import argparse
import json
import math
import random
import sys

import numpy as np
from PIL import Image, ImageDraw

W_MM, H_MM = 304.8, 228.6
PX_PER_MM = 2.0
FLAT_MM = [3.2, 6.4, 9.5, 12.7, 15.9, 19.1, 25.4, 31.8, 38.1, 50.8]
ROUND_NO = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24]
RIGGER_NO = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12]


# ------------------------------------------------------------ colour
def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lab_of(rgb):
    lin = srgb_to_lin(rgb.astype(np.float64))
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_hex(L):
    fy = (L[0] + 16) / 116; fx = fy + L[1] / 500; fz = fy - L[2] / 200
    inv = lambda t: t ** 3 if t ** 3 > 216 / 24389 else (116 * t - 16) / (24389 / 27)
    X, Y, Z = inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883
    r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z
    g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z
    b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
    gam = lambda c: 255 * (12.92 * c if c <= 0.0031308 else 1.055 * max(c, 0) ** (1 / 2.4) - 0.055)
    return '#' + ''.join('%02x' % int(round(min(255, max(0, gam(c))))) for c in (r, g, b))


def blur(a, sigma):
    if sigma <= 0.3:
        return a
    r = max(1, int(math.ceil(sigma * 3)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    out = a
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim; pad[axis] = (r, r)
        p = np.pad(out, pad, mode='edge')
        acc = np.zeros_like(out, dtype=np.float64)
        n = out.shape[axis]
        for i, w in enumerate(k):
            sl = [slice(None)] * out.ndim; sl[axis] = slice(i, i + n)
            acc += w * p[tuple(sl)]
        out = acc
    return out


def load_lab(path, size):
    return lab_of(np.asarray(Image.open(path).convert('RGB').resize(size, Image.LANCZOS)).astype(np.float64))


# ------------------------------------------------------------ direction field
def edge_field(L, sigma):
    """Direction along the forms (perpendicular to the gradient) and how
    clear it is (coherence 0..1), from the structure tensor of L*."""
    gy, gx = np.gradient(L)
    J = [blur(v, sigma) for v in (gx * gx, gx * gy, gy * gy)]
    th = 0.5 * np.arctan2(2 * J[1], J[0] - J[2]) + math.pi / 2   # along edges
    lam = np.sqrt((J[0] - J[2]) ** 2 + 4 * J[1] ** 2)
    coh = lam / (J[0] + J[2] + 1e-6)
    return th, np.clip(coh, 0, 1)


# ------------------------------------------------------------ gesture
def to_gesture(P, label, speed, seg, extra, rnd, imp):
    P = np.asarray(P, float)
    d = np.diff(P, axis=0); s = np.concatenate([[0], np.cumsum(np.hypot(d[:, 0], d[:, 1]))])
    total = max(s[-1], 1e-3)
    n = max(1, round(total / seg)); Lsg = total / n
    knots = np.linspace(0, total, n + 1)

    def tangent(t):
        a = np.interp(max(0, t - 1.0), s, P[:, 0]), np.interp(max(0, t - 1.0), s, P[:, 1])
        b = np.interp(min(total, t + 1.0), s, P[:, 0]), np.interp(min(total, t + 1.0), s, P[:, 1])
        return math.atan2(b[1] - a[1], b[0] - a[0])
    phi = [tangent(t) for t in knots]
    for i in range(1, len(phi)):
        while phi[i] - phi[i - 1] > math.pi: phi[i] -= 2 * math.pi
        while phi[i] - phi[i - 1] < -math.pi: phi[i] += 2 * math.pi
    size = min(2.0, max(0.5, math.sqrt(total / 10.0)))
    h0 = math.radians(rnd.gauss(0, imp.get('heading_deg', 0)) * size)
    wsd = math.radians(imp.get('wobble_deg', 0)) * math.sqrt(Lsg / 3.0) * size
    wob = [rnd.gauss(0, wsd) for _ in range(n)]
    lf = max(0.7, 1 + rnd.gauss(0, imp.get('length_frac', 0)))
    v = speed
    pushes = [{"turn": round(v * v * (phi[i + 1] - phi[i] + wob[i]) / Lsg), "ms": round(1000 * Lsg * lf / v, 1)} for i in range(n)]
    a = {"type": "lib", "stroke": "gesture", "label": label,
         "start": [round(P[0][0] / W_MM, 5), round(P[0][1] / H_MM, 5)],
         "aim": [round(P[-1][0] / W_MM, 5), round(P[-1][1] / H_MM, 5)],
         "v0": {"dir": round(math.degrees(phi[0] + h0), 2), "speed": v}, "pushes": pushes}
    a.update(extra)
    return a


def mark_width(brush, size, p):
    if brush == 'flat':
        return 1.08 * FLAT_MM[size]
    if brush == 'filbert':
        # measured at 2048 cells: a filbert pressed at 0.65 lays about its full flat width
        return 1.04 * FLAT_MM[size] * min(1.0, max(0.35, (p - 0.2) / 0.42))
    if brush == 'rigger':
        d = 0.7 + 0.28 * RIGGER_NO[size]
        return d * (0.5 + 1.6 * max(0, p - 0.4))
    d = 0.9 + 0.62 * ROUND_NO[size]
    return d * max(0.25, 0.52 + 2.4 * (p - 0.5))


# The brush settles onto the paper over the first few tens of milliseconds
# and lifts off early, so a mark starts about 2 mm after its path begins and
# stops 1-3 mm before it ends (measured on scrap at 2048 cells); paths are
# carried that far past both ends so the mark covers what was planned.
LAG = {'flat': (2.0, 2.5), 'filbert': (2.1, 2.4), 'round': (1.8, 1.0), 'rigger': (1.8, 1.0)}


def extend_path(P, a, b):
    P = np.asarray(P, float)
    def tang(i, j):
        v = P[j] - P[i]; n = np.hypot(*v); return v / n if n > 1e-9 else np.array([1.0, 0.0])
    k = min(len(P) - 1, 3)
    return np.vstack([P[0] - tang(0, k) * a, P, P[-1] + tang(-1 - k, -1) * b])


def kmeans(X, k, iters=20, seed=1):
    rng = np.random.default_rng(seed)
    k = min(k, len(X))
    C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(iters):
        d = ((X[:, None, :] - C[None]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(k):
            if (lab == j).any(): C[j] = X[lab == j].mean(0)
    return C, lab


# ------------------------------------------------------------ planning
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run'); ap.add_argument('spec'); ap.add_argument('out')
    ap.add_argument('--render'); ap.add_argument('--preview')
    a = ap.parse_args()
    S = json.load(open(a.spec))
    global PX_PER_MM
    PX_PER_MM = float(S.get('px_per_mm', 2.0))   # finer for small brushes (a closer look)
    rnd = random.Random(S.get('seed', 1))
    brush, size = S['brush'], int(S['size'])
    pressure, load = S.get('pressure', 0.6), S.get('load', 0.8)
    width = S.get('width_mm') or mark_width(brush, size, pressure)
    Wp, Hp = int(W_MM * PX_PER_MM), int(H_MM * PX_PER_MM)
    T = load_lab(f'{a.run}/target.png', (Wp, Hp))
    C = load_lab(a.render or f'{a.run}/blank.png', (Wp, Hp))
    sig = max(1.0, width * PX_PER_MM / 3)
    Tb = blur(T, sig)                    # what one stroke of this brush can say
    Cb = blur(C, max(1.0, sig * 0.5))
    field = S.get('field', 'edges')
    th, coh = edge_field(T[..., 0], max(2.0, width * PX_PER_MM * 0.6))
    hand = math.radians(S.get('hand_deg', -30))
    x0, y0, x1, y1 = S.get('box', [0, 0, 1, 1])
    X0, Y0, X1, Y1 = int(x0 * Wp), int(y0 * Hp), int(x1 * Wp), int(y1 * Hp)
    grid = S.get('grid_mm', 0.8 * width) * PX_PER_MM
    thr = S.get('threshold', 10.0)
    step = S.get('step_mm', max(1.0, width * 0.25)) * PX_PER_MM
    max_len = S.get('max_len_mm', max(12.0, width * 4)) * PX_PER_MM
    min_len = S.get('min_len_mm', max(2.0, width * 0.5)) * PX_PER_MM
    turn = math.radians(S.get('curve_deg_per_mm', 4)) / PX_PER_MM * step
    cover = S.get('coverage', 0.85)
    trace_tol = S.get('trace_tol', thr * 1.6)   # how far the colour along a stroke may drift from its own
    only = S.get('only')   # "darker" / "lighter": accents only where the painting must go that way
    allowed = np.ones((Hp, Wp), bool)
    if S.get('regions'):
        G = S['regions']
        polys = json.load(open(G['file'] if G['file'].startswith('/') else f"{a.run}/{G['file']}"))
        m = Image.new('L', (Wp, Hp), 0); dr = ImageDraw.Draw(m)
        names = G.get('use') or G.get('avoid') or []
        for nm in names: dr.polygon([(x * Wp, y * Hp) for x, y in polys[nm]], fill=255)
        inside = np.asarray(m) > 127
        allowed = inside if G.get('use') else ~inside
        # a region's colours come from that region only: the blur that says
        # what one stroke can carry must not pull in the other side's
        mf = allowed.astype(np.float64)[..., None]
        bm = blur(mf, sig)
        Tb = np.where(bm > 0.05, blur(T * mf, sig) / np.maximum(bm, 1e-6), Tb)
        # keep the stroke's body inside, not just its centre line: a flat
        # cutting in runs with its side along the edge
        r = int(round(G.get('inset', 0.6) * width * PX_PER_MM / 2))
        for _ in range(r):
            e = allowed.copy()
            e[1:, :] &= allowed[:-1, :]; e[:-1, :] &= allowed[1:, :]; e[:, 1:] &= allowed[:, :-1]; e[:, :-1] &= allowed[:, 1:]
            allowed = e
    canvas = Cb.copy()
    rad = width * PX_PER_MM / 2
    Wt = np.ones((Hp, Wp))
    if S.get('weights'):
        polys_w = None
        for wspec in S['weights']:
            m = Image.new('L', (Wp, Hp), 0); dr = ImageDraw.Draw(m)
            if 'region' in wspec:
                if polys_w is None:
                    f = (S.get('regions') or {}).get('file', 'roles.json')
                    polys_w = json.load(open(f if f.startswith('/') else f"{a.run}/{f}"))
                dr.polygon([(x * Wp, y * Hp) for x, y in polys_w[wspec['region']]], fill=255)
            else:
                bx = wspec['box']; dr.rectangle([bx[0] * Wp, bx[1] * Hp, bx[2] * Wp, bx[3] * Hp], fill=255)
            Wt = np.where(np.asarray(m) > 127, np.maximum(Wt, wspec.get('w', 2.0)), Wt)
        Wt = blur(Wt, 3 * PX_PER_MM)            # no hard seam where the weighting changes

    def dE(A, B): return np.sqrt(((A - B) ** 2).sum(-1))

    def direction(p, prev):
        i, j = int(min(Hp - 1, max(0, p[1]))), int(min(Wp - 1, max(0, p[0])))
        if isinstance(field, (int, float)):
            t = math.radians(field)
        else:
            c = coh[i, j]
            t = th[i, j] if c > 0.15 else hand
            if 0.15 < c < 0.35:   # weak direction: lean toward the hand's
                w = (c - 0.15) / 0.2
                vx = w * math.cos(2 * t) + (1 - w) * math.cos(2 * hand); vy = w * math.sin(2 * t) + (1 - w) * math.sin(2 * hand)
                t = 0.5 * math.atan2(vy, vx)
        d = np.array([math.cos(t), math.sin(t)])
        if prev is not None and d @ prev < 0: d = -d
        return d

    strokes = []
    greedy = S.get('select') == 'greedy'
    if greedy:
        grid = S.get('grid_mm', 0.5 * width) * PX_PER_MM
        max_len = S.get('max_len_mm', max(15.0, width * 6)) * PX_PER_MM
    xs = np.arange(X0, X1, grid); ys = np.arange(Y0, Y1, grid)
    cells = [(x, y) for y in ys for x in xs]
    rnd.shuffle(cells)
    E = dE(Tb, canvas)
    cands = []

    def footprint(P):
        lo = np.floor(P.min(0) - rad - 2).astype(int); hi = np.ceil(P.max(0) + rad + 2).astype(int)
        lo = np.maximum(lo, 0); hi = np.minimum(hi, [Wp, Hp])
        m = Image.new('L', (int(hi[0] - lo[0]), int(hi[1] - lo[1])), 0); d = ImageDraw.Draw(m)
        Q = [tuple(q - lo) for q in P]
        if len(Q) > 1: d.line(Q, fill=255, width=max(1, int(2 * rad)), joint='curve')
        for q in (Q[0], Q[-1]): d.ellipse([q[0] - rad, q[1] - rad, q[0] + rad, q[1] + rad], fill=255)
        return (int(lo[1]), int(hi[1]), int(lo[0]), int(hi[0])), np.asarray(m).astype(np.float64) / 255 * cover

    def gain_of(c, cv):
        (a0, a1, b0, b1), mk = c['fp']
        t, cn = Tb[a0:a1, b0:b1], cv[a0:a1, b0:b1]
        before = dE(t, cn)
        after = dE(t, cn * (1 - mk[..., None]) + c['col'] * mk[..., None])
        g = (before - after) * Wt[a0:a1, b0:b1]
        if S.get('regions'):
            g = np.where(allowed[a0:a1, b0:b1], g, np.minimum(g, 0))   # spilling outside costs, never pays
        return float(g.sum()) / PX_PER_MM ** 2

    def fit(P):
        fp = footprint(P)
        (a0_, a1_, b0_, b1_), mk = fp
        wsum = mk.sum()
        col = (Tb[a0_:a1_, b0_:b1_] * mk[..., None]).sum((0, 1)) / wsum if wsum > 0 else Tb[int(P[0][1]) % Hp, int(P[0][0]) % Wp]
        return {'P': P, 'col': col, 'fp': fp}

    def refine(c, cv):
        best, bg = c, gain_of(c, cv)
        P = c['P']; ctr = P.mean(0)
        ch = P[-1] - P[0]; n = np.hypot(*ch)
        u = ch / n if n > 1e-6 else np.array([1.0, 0.0]); v = np.array([-u[1], u[0]])
        sh = 0.3 * rad * 2
        variants = [P + v * sh, P - v * sh, P + u * sh, P - u * sh]
        for ang in (-0.2, -0.1, 0.1, 0.2):
            ca, sa = math.cos(ang), math.sin(ang)
            Rm = np.array([[ca, -sa], [sa, ca]])
            variants.append((P - ctr) @ Rm.T + ctr)
        if len(P) > 2:
            k = max(1, len(P) // 5)
            variants += [P[k:-k] if len(P) > 2 * k + 1 else P, extend_path(P, 0.2 * n / PX_PER_MM * PX_PER_MM, 0.2 * n)]
        for V in variants:
            V = np.clip(V, [0, 0], [Wp - 1, Hp - 1])
            if len(V) < 2: continue
            cv_ = fit(V)
            g = gain_of(cv_, cv)
            if g > bg: best, bg = cv_, g
        return best, bg

    for (cx, cy) in cells:
        a0, a1 = int(cy), int(min(Hp, cy + grid)); b0, b1 = int(cx), int(min(Wp, cx + grid))
        if a1 <= a0 or b1 <= b0: continue
        sub = dE(Tb[a0:a1, b0:b1], canvas[a0:a1, b0:b1])
        if only == 'darker': sub = sub * (canvas[a0:a1, b0:b1, 0] - Tb[a0:a1, b0:b1, 0] > 3)
        elif only == 'lighter': sub = sub * (Tb[a0:a1, b0:b1, 0] - canvas[a0:a1, b0:b1, 0] > 3)
        sub = sub * allowed[a0:a1, b0:b1]
        if sub.mean() < thr * (0.35 if only else 1) * (allowed[a0:a1, b0:b1].mean() if S.get('regions') else 1) or not sub.any(): continue
        k = np.unravel_index(sub.argmax(), sub.shape)
        p0 = np.array([b0 + k[1] + 0.5, a0 + k[0] + 0.5])
        col = Tb[int(p0[1]), int(p0[0])].copy()
        # trace both ways from the start along the forms
        halves = []
        for sgn in (1, -1):
            pts, d, p, L = [], None, p0.copy(), 0.0
            d0 = direction(p, None) * sgn
            d = d0
            while L < max_len / 2:
                nd = direction(p, d)
                ang = math.atan2(d[0] * nd[1] - d[1] * nd[0], d @ nd)
                ang = max(-turn, min(turn, ang))
                ca, sa = math.cos(ang), math.sin(ang)
                d = np.array([ca * d[0] - sa * d[1], sa * d[0] + ca * d[1]])
                q = p + d * step
                if not (0 <= q[0] < Wp and 0 <= q[1] < Hp): break
                i, j = int(q[1]), int(q[0])
                if not allowed[i, j]: break
                here = Tb[i, j]
                # keep going while this colour helps more than what is there
                if dE(here, col) > dE(here, canvas[i, j]) + 1.0 or dE(here, col) > trace_tol: break
                p = q; L += step
                pts.append(p.copy())
            halves.append(pts)
        P = halves[1][::-1] + [p0] + halves[0]
        P = np.array(P)
        length = float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0.0
        if length < min_len:
            # a dab: at least a short stroke along the field
            d = direction(p0, None)
            P = np.array([p0 - d * min_len / 2, p0 + d * min_len / 2])
        if greedy:
            fp = footprint(P)
            (a0_, a1_, b0_, b1_), mk = fp
            wsum = mk.sum()
            if wsum > 0:
                # the colour that best fits the whole footprint
                col = (Tb[a0_:a1_, b0_:b1_] * mk[..., None]).sum((0, 1)) / wsum
            cands.append({'P': P, 'col': col, 'fp': fp})
            continue
        # lay it on the planning canvas
        m = Image.new('L', (Wp, Hp), 0)
        ImageDraw.Draw(m).line([tuple(q) for q in P], fill=255, width=max(1, int(2 * rad)), joint='curve')
        for q in (P[0], P[-1]):
            ImageDraw.Draw(m).ellipse([q[0] - rad, q[1] - rad, q[0] + rad, q[1] + rad], fill=255)
        mk = np.asarray(m).astype(np.float64)[..., None] / 255 * cover
        canvas = canvas * (1 - mk) + col * mk
        strokes.append({'P': P / PX_PER_MM, 'col': col})
    if greedy:
        import heapq
        budget, min_gain = S.get('budget', 300), S.get('min_gain', 30.0)
        heap = [(-gain_of(c, canvas), k) for k, c in enumerate(cands)]
        heapq.heapify(heap)
        curve = []
        while heap and len(strokes) < budget:
            ng, k = heapq.heappop(heap)
            g = gain_of(cands[k], canvas)
            if heap and g < -heap[0][0] * 0.97:
                heapq.heappush(heap, (-g, k)); continue      # stale: it is worth less now
            if g < min_gain: break
            c = cands[k]
            if S.get('refine', True):
                c, g = refine(c, canvas)
            (a0_, a1_, b0_, b1_), mk = c['fp']
            canvas[a0_:a1_, b0_:b1_] = canvas[a0_:a1_, b0_:b1_] * (1 - mk[..., None]) + c['col'] * mk[..., None]
            strokes.append({'P': c['P'] / PX_PER_MM, 'col': c['col'], 'gain': g})
            if len(strokes) % 25 == 0: curve.append((len(strokes), round(float(dE(Tb, canvas)[Y0:Y1, X0:X1].mean()), 2), round(g)))
        S['order'] = 'as-found'
        print(f'greedy: {len(cands)} candidates; ' + ' '.join(f'{n}:{e}(+{g})' for n, e, g in curve), file=sys.stderr)
    if not strokes:
        json.dump([], open(a.out, 'w'))
        print(json.dumps({'strokes': 0}))
        return
    # pool the colours into palette mixes: a stroke joins a mix already on
    # the palette if it is within mix_tol ΔE of it, otherwise it gets its own
    # (extremes such as the darkest darks keep their colour)
    cols = np.array([s['col'] for s in strokes])
    tol = S.get('mix_tol', 4.0)
    centres, members = [], []
    for k in np.argsort(cols[:, 0]):
        c = cols[k]
        if centres:
            d = np.sqrt(((np.array(centres) - c) ** 2).sum(-1))
            j = int(d.argmin())
            if d[j] <= tol:
                members[j].append(k); continue
        centres.append(c.copy()); members.append([k])
    lab = np.zeros(len(cols), int)
    for j, ms in enumerate(members):
        for k in ms: lab[k] = j
        # the mix is the members' mean, kept within tol of each
        centres[j] = cols[ms].mean(0)
    C_ = np.array(centres)
    order = list(range(len(C_)))
    if S.get('order', 'dark-first') == 'dark-first': order.sort(key=lambda j: C_[j][0])
    elif S.get('order') == 'light-first': order.sort(key=lambda j: -C_[j][0])
    imp = S.get('imprecision', {'heading_deg': 2.0, 'wobble_deg': 1.5, 'length_frac': 0.05})
    speed = S.get('speed', 110 + 3 * width)
    acts = [{"type": "dry", "label": "let it dry"}] if S.get('dry_first') else []
    label = S.get('label', f'{brush}{size}')
    pref = np.array([math.cos(hand), math.sin(hand)])
    pause = S.get('pause_s', 15)
    # greedy: the strokes go down in the order they were chosen (that is the
    # layering the plan counted on); a new mix only when the colour changes
    groups = [(j, [s]) for s, j in zip(strokes, lab)] if greedy else [(j, [s for s, l in zip(strokes, lab) if l == j]) for j in order]
    if greedy:
        merged = []
        for j, ms in groups:
            if merged and merged[-1][0] == j: merged[-1][1].extend(ms)
            else: merged.append((j, list(ms)))
        groups = merged
    for n_mix, (j, mine) in enumerate(groups):
        hexc = lab_to_hex(C_[j])
        if n_mix and S.get('dry_between'):
            # small accents go on dry paint, or they smear into what is under them
            acts.append({"type": "dry", "label": f"dry, mix {hexc}"})
        elif n_mix and pause and len(mine) >= 1:
            # mixing the next colour takes a little while; what is down sets meanwhile
            acts.append({"type": "wait", "s": pause, "label": f"mix {hexc}"})
        # within a mix, work across the sheet rather than jumping about
        if not greedy: mine.sort(key=lambda s: (round(s['P'][0][1] / 30), s['P'][0][0]))
        for s in mine:
            P = s['P']
            # the hand pulls strokes toward itself: down and to the right
            if (P[-1] - P[0]) @ np.array([0.45, 0.89]) < 0 and abs((P[-1] - P[0]) @ np.array([1, 0])) < 0.98 * np.hypot(*(P[-1] - P[0])) or (P[-1][0] < P[0][0] and abs(P[-1][1] - P[0][1]) < abs(P[-1][0] - P[0][0])):
                P = P[::-1]
            ex = {"brush": brush, "size": size, "pressure": pressure, "load": load, "color": hexc}
            if brush in ('flat', 'filbert'):
                d = P[-1] - P[0]
                phi = math.atan2(d[1], d[0]) if np.hypot(*d) > 1e-6 else 0.0
                ex["flatAngle"] = round(-phi + math.pi / 2, 3)   # sim y is up; the wide side across the stroke
            if S.get('water') is not None: ex['water'] = S['water']
            if S.get('marble') is not None: ex['marble'] = S['marble']
            if S.get('lag', True):
                la, lb = LAG.get(brush, (1.8, 1.5))
                P = extend_path(P, la, lb)
            acts.append(to_gesture(P, f'{label} {hexc}', speed, max(2.0, width * 0.6), ex, rnd, imp))
    json.dump(acts, open(a.out, 'w'))
    if a.preview:
        def to_rgb(Lab):
            out = np.zeros(Lab.shape)
            fy = (Lab[..., 0] + 16) / 116; fx = fy + Lab[..., 1] / 500; fz = fy - Lab[..., 2] / 200
            inv = lambda t: np.where(t ** 3 > 216 / 24389, t ** 3, (116 * t - 16) / (24389 / 27))
            X, Y, Z = inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883
            rgb = np.stack([3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z], -1)
            rgb = np.clip(rgb, 0, 1)
            return (255 * np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)).astype(np.uint8)
        im = Image.new('RGB', (Wp * 2 + 8, Hp), (255, 255, 255))
        im.paste(Image.fromarray(to_rgb(Tb)), (0, 0)); im.paste(Image.fromarray(to_rgb(canvas)), (Wp + 8, 0))
        dr = ImageDraw.Draw(im)
        for s in strokes:
            dr.line([(q[0] * PX_PER_MM + Wp + 8, q[1] * PX_PER_MM) for q in s['P']], fill=(255, 0, 0), width=1)
        im.save(a.preview)
    before = float(dE(Tb, Cb)[Y0:Y1, X0:X1].mean()); after = float(dE(Tb, canvas)[Y0:Y1, X0:X1].mean())
    print(json.dumps({'strokes': sum(1 for x in acts if x.get('type') == 'lib'), 'actions': len(acts), 'mixes': len(C_), 'width_mm': round(width, 1), 'planned_dE': [round(before, 1), round(after, 1)]}))


if __name__ == '__main__':
    main()
