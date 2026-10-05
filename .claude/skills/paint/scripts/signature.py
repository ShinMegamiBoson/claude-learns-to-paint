#!/usr/bin/env python3
"""A signature as a recorded motion: trace an image of one (brush or pen)
into the strokes that wrote it, in writing order, with the pressure from
the ink's width and the timing of a practised hand (fast on the straights,
slower through the turns: the two-thirds power law), then write them as
stroke actions placed on a sheet. Saved with `ink strokes save`, the same
motion signs any painting, moved and scaled onto a baseline.

  signature.py IMAGE SPEC.json OUT.json [--preview P.png]

SPEC: {
  "strokes": [{"name": "C", "pts": [[x, y], ...]}, ...]   waypoints in image px,
        in writing order; the trace follows the darkest ink between them
  "baseline": [[x, y], [x, y]]     image px: the anchor saved as from→to
  "at": [x, y]                     sheet fraction where the baseline starts
  "width_mm": 50                   the baseline's length on the sheet
  "sheet_mm": [304.8, 228.6]
  "brush": "round", "size": 1, "pigments": {"1": 0.75, ...}, "load": 0.9,
  "speed": 90                      mm/s on a straight (curves go slower)
  "lift_ms": 380                   pen up between strokes
  each stroke can set its own brush, size, load, water, speed, pmin, pmax
  and lift_ms (the pause before it): a long name in a small brush is split
  at natural pen lifts, where the brush is reloaded
}
"""
import argparse, heapq, json, math, sys, os
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from linecands import fblur
from paintplan import mark_width


def chamfer(mask):
    """distance (px) to the nearest pixel outside the mask, 3-4 chamfer"""
    H, W = mask.shape
    INF = 1e9
    d = np.where(mask, INF, 0.0)
    for y in range(H):
        row = d[y]
        up = d[y - 1] if y else None
        for x in range(W):
            if row[x] == 0: continue
            v = row[x]
            if x: v = min(v, row[x - 1] + 3)
            if up is not None:
                v = min(v, up[x] + 3)
                if x: v = min(v, up[x - 1] + 4)
                if x + 1 < W: v = min(v, up[x + 1] + 4)
            row[x] = v
    for y in range(H - 1, -1, -1):
        row = d[y]
        dn = d[y + 1] if y + 1 < H else None
        for x in range(W - 1, -1, -1):
            if row[x] == 0: continue
            v = row[x]
            if x + 1 < W: v = min(v, row[x + 1] + 3)
            if dn is not None:
                v = min(v, dn[x] + 3)
                if x + 1 < W: v = min(v, dn[x + 1] + 4)
                if x: v = min(v, dn[x - 1] + 4)
            row[x] = v
    return d / 3.0


def route(cost, a, b):
    """cheapest 8-connected path from a to b (x, y) over the cost grid"""
    H, W = cost.shape
    ax, ay = a; bx, by = b
    dist = np.full((H, W), np.inf); prev = np.full((H, W), -1, np.int64)
    dist[ay, ax] = 0
    q = [(0.0, ay, ax)]
    steps = [(-1, 0, 1), (1, 0, 1), (0, -1, 1), (0, 1, 1), (-1, -1, 1.414), (-1, 1, 1.414), (1, -1, 1.414), (1, 1, 1.414)]
    while q:
        d, y, x = heapq.heappop(q)
        if (y, x) == (by, bx): break
        if d > dist[y, x]: continue
        for dy, dx, w in steps:
            Y, X = y + dy, x + dx
            if 0 <= Y < H and 0 <= X < W:
                nd = d + w * 0.5 * (cost[y, x] + cost[Y, X])
                if nd < dist[Y, X]:
                    dist[Y, X] = nd; prev[Y, X] = y * W + x
                    heapq.heappush(q, (nd, Y, X))
    out = [(bx, by)]
    i = prev[by, bx]
    while i >= 0:
        y, x = divmod(int(i), W); out.append((x, y)); i = prev[y, x]
    return out[::-1]


def resample(P, step):
    d = np.hypot(*np.diff(P, axis=0).T); s = np.concatenate([[0], np.cumsum(d)])
    t = np.arange(0, s[-1] + 1e-9, step)
    if t[-1] < s[-1]: t = np.append(t, s[-1])
    return np.stack([np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], 1)


def smooth(P, k, passes=2):
    for _ in range(passes):
        Q = P.copy()
        for i in range(1, len(P) - 1):
            a, b = max(0, i - k), min(len(P), i + k + 1); Q[i] = P[a:b].mean(0)
        P = Q
    return P


def gsmooth(A, sigma):
    """Gaussian smoothing along the first axis (sigma in samples), ends held"""
    if sigma <= 0: return A
    r = int(3 * sigma) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    pad = np.concatenate([np.repeat(A[:1], r, 0), A, np.repeat(A[-1:], r, 0)])
    if A.ndim == 1: return np.convolve(pad, k, mode='valid')
    return np.stack([np.convolve(pad[:, i], k, mode='valid') for i in range(A.shape[1])], 1)


def gesture(Pm, ts, to_mm, sheet, push_ms=10, dt=2.0, smooth_w=None, vias=None, via_mm=None):
    """start / v0 / pushes [{dir, mag, ms}] for one smooth motion along the
    path Pm (mm) timed by ts (ms). The integrated position (strokes.mjs
    gestureMotion + hand.mjs integrate, looseness 0: semi-implicit Euler at
    2 ms, a push acting on the steps that end in [its start, its end)) is
    linear in the pushes and the starting velocity, so all of them are
    solved at once: least squares on the miss from a few targets plus a
    penalty on the change from each push to the next (jerk). The targets are
    sparse: the via points (indices into Pm, weighted most) and the trace
    every via_mm, so between them the hand takes the minimum-jerk way, as a
    practised hand does, instead of every wobble of the scan. With neither,
    every step of the trace is a target."""
    X = np.array([to_mm(q) for q in Pm])
    T = float(ts[-1])
    J = int(math.ceil(T / push_ms))
    K = int(round(J * push_ms / dt))                 # steps (the integrator runs to t <= T)
    tk = np.arange(1, K + 1) * dt
    x0 = X[0]
    h = dt / 1000
    push_of = np.minimum(J - 1, (tk / push_ms + 1e-9).astype(int))
    # x_k = x0 + k h v0 + h^2 sum_{l<=k} (k-l+1) a_push(l)
    M = np.zeros((K, J + 1))
    M[:, J] = np.arange(1, K + 1) * h
    for k in range(K):
        l = np.arange(k + 1)
        np.add.at(M[k], push_of[l], h * h * (k - l + 1))
    # targets: (step index, position, weight)
    if vias is None and via_mm is None:
        rows = [(k, np.array([np.interp(min(tk[k], T), ts, X[:, 0]), np.interp(min(tk[k], T), ts, X[:, 1])]), 1.0) for k in range(K)]
    else:
        rows = []
        s_ = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(X, axis=0).T))])
        idx = set()
        if via_mm:
            for sv in np.arange(via_mm, s_[-1], via_mm): idx.add(int(np.searchsorted(s_, sv)))
        idx.add(len(X) - 1)
        for i in sorted(idx):
            rows.append((max(0, int(round(ts[i] / dt)) - 1), X[i], 0.4))
        for i in (vias or []):
            if i > 0: rows.append((max(0, int(round(ts[i] / dt)) - 1), X[i], 1.0))
    R = np.array([M[k] * w for k, _, w in rows])
    D = np.zeros((J - 1, J + 1))
    for j in range(J - 1): D[j, j], D[j, j + 1] = -1, 1
    lam = smooth_w if smooth_w is not None else 3e-4
    A_ = np.vstack([R, lam * D])
    sol = np.zeros((J + 1, 2))
    for ax in range(2):
        rhs = np.concatenate([np.array([(xx[ax] - x0[ax]) * w for _, xx, w in rows]), np.zeros(J - 1)])
        sol[:, ax] = np.linalg.lstsq(A_, rhs, rcond=None)[0]
    acc, v0 = sol[:J], sol[J]
    pushes = []
    for a_ in acc:
        mag = round(float(np.hypot(*a_)), 1); d = round(math.degrees(math.atan2(a_[1], a_[0])), 2)
        pushes.append({"dir": d, "mag": mag, "ms": push_ms})
    v0 = np.round(v0, 2)
    ar = np.array([[p['mag'] * math.cos(math.radians(p['dir'])), p['mag'] * math.sin(math.radians(p['dir']))] for p in pushes])
    with np.errstate(all='ignore'):
        xs = x0 + M[:, J:J + 1] * v0 + M[:, :J] @ ar
    Xd = np.stack([np.interp(np.minimum(tk, T), ts, X[:, 0]), np.interp(np.minimum(tk, T), ts, X[:, 1])], 1)
    miss = float(np.hypot(*(xs - Xd).T).max())
    return {"start": [round(x0[0] / sheet[0], 5), round(x0[1] / sheet[1], 5)], "v0": [float(v0[0]), float(v0[1])], "pushes": pushes, "_miss": miss, "_xs": xs, "_tk": tk}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image'); ap.add_argument('spec'); ap.add_argument('out')
    ap.add_argument('--preview')
    a = ap.parse_args()
    S = json.load(open(a.spec))
    L = np.asarray(Image.open(a.image).convert('L')).astype(float)
    Lb = fblur(L, 1.2)
    dark = np.clip((235 - Lb) / 200, 0, 1)
    ink = fblur(L, 2.5) < 175
    dt = chamfer(ink)
    cost = 1 + 25 * (1 - dark) ** 2 + np.where(ink, 0, 60) + 6 / (1 + dt)
    (bx0, by0), (bx1, by1) = S['baseline']
    base_len = math.hypot(bx1 - bx0, by1 - by0)
    mm_per_px = S['width_mm'] / base_len
    sheet = S.get('sheet_mm', [304.8, 228.6])
    th = math.atan2(by1 - by0, bx1 - bx0)
    cs, sn = math.cos(-th), math.sin(-th)
    at = S['at']
    def to_sheet(x, y):
        u, v = (x - bx0) * mm_per_px, (y - by0) * mm_per_px
        u, v = u * cs - v * sn, u * sn + v * cs
        return at[0] + u / sheet[0], at[1] + v / sheet[1]
    def to_sheet_mm(q):   # signature mm (image axes) -> sheet mm
        u, v = q[0] - bx0 * mm_per_px, q[1] - by0 * mm_per_px
        return np.array([at[0] * sheet[0] + u * cs - v * sn, at[1] * sheet[1] + u * sn + v * cs])
    brush, size = S.get('brush', 'round'), S.get('size', 1)
    # pressure for a width: invert the calibrated mark width
    ps = np.linspace(0.2, 1.0, 81)
    ws = np.array([mark_width(brush, size, p) for p in ps])
    def pressure(w_mm):
        return float(np.interp(w_mm, ws, ps))
    v_straight = S.get('speed', 90.0)   # mm/s
    acts, traces = [], []
    t_total = 0.0
    for st in S['strokes']:
        # per stroke: its own brush size, load, speed and lightest touch
        brush, size = st.get('brush', S.get('brush', 'round')), st.get('size', S.get('size', 1))
        ws = np.array([mark_width(brush, size, p) for p in ps])
        def pressure(w_mm, lo=st.get('pmin', S.get('pmin', 0.34)), hi=st.get('pmax', S.get('pmax', 1.0))):
            return min(hi, max(lo, float(np.interp(w_mm, ws, ps))))
        v_straight = st.get('speed', S.get('speed', 90.0))
        way = [tuple(int(round(c)) for c in p) for p in st['pts']]
        path = []
        for p, q in zip(way, way[1:]):
            seg = route(cost, p, q)
            path += seg if not path else seg[1:]
        P = smooth(resample(np.array(path, float), 1.0), 3)
        P = resample(P, 1.0)
        # width along the stroke: twice the distance to the ink's edge,
        # thinned where the ink is broken (dry brush) by its darkness
        Wd = np.array([2 * dt[min(dt.shape[0] - 1, int(round(y))), min(dt.shape[1] - 1, int(round(x)))] for x, y in P])
        Dk = np.array([dark[min(dark.shape[0] - 1, int(round(y))), min(dark.shape[1] - 1, int(round(x)))] for x, y in P])
        Wd = np.convolve(np.pad(Wd, 6, mode='edge'), np.ones(13) / 13, mode='valid')
        Dk = np.convolve(np.pad(Dk, 6, mode='edge'), np.ones(13) / 13, mode='valid')
        w_mm = np.maximum(Wd, 1.0) * mm_per_px * (0.55 + 0.45 * Dk)
        # timing: v = k R^(1/3) (the two-thirds power law), capped at the straight speed
        Pm = P * mm_per_px
        # one continuous motion: the trace smoothed along its length (about
        # 0.5 mm, small enough to keep the loops of the letters)
        Pm = gsmooth(Pm, 0.5 / mm_per_px)
        Ps = gsmooth(Pm, 1.0 / mm_per_px)
        seg = np.hypot(*np.diff(Pm, axis=0).T)
        hd = np.unwrap(np.arctan2(*np.diff(Ps, axis=0).T[::-1]))
        curv = np.abs(np.gradient(hd)) / np.maximum(seg, 1e-6)          # 1/mm
        curv = np.convolve(np.pad(curv, 4, mode='edge'), np.ones(9) / 9, mode='valid')
        R = 1 / np.maximum(curv, 1e-3)
        v = np.clip(v_straight * (R / 12.0) ** (1 / 3), v_straight * st.get('vmin', S.get('vmin', 0.25)), v_straight)
        sfe = np.minimum(np.cumsum(seg), np.cumsum(seg[::-1])[::-1])     # mm from the nearer end
        # easing in and out: a careful hand starts slow (0.45); a practised one
        # is already moving when the brush touches and leaves at speed (0.8+)
        e0, emm = st.get('ease', S.get('ease', [0.45, 8.0]))
        v = v * np.minimum(1.0, e0 + sfe / emm)
        v = gsmooth(v, 4.0 / mm_per_px)          # speed changes over a few mm, never abruptly
        ts = np.concatenate([[0], np.cumsum(1000 * seg / v)])
        pr = np.array([pressure(w) for w in w_mm])
        if st.get('p_smooth_mm', S.get('p_smooth_mm')):
            pr = gsmooth(pr, st.get('p_smooth_mm', S.get('p_smooth_mm')) / mm_per_px)
        pr[:3] = np.minimum(pr[:3], 0.45)  # land light, press after a few mm
        pr[-1] = min(pr[-1], 0.3)          # and lift off
        # the motion that writes it: a gesture (start, velocity, pushes) whose
        # integration lands on the trace, solved with the integrator's own steps
        vias = [int(np.argmin(np.hypot(*(P - np.array(w)).T))) for w in way] if st.get('via_mm', S.get('via_mm')) else None
        g = gesture(Pm, ts, to_sheet_mm, sheet, smooth_w=st.get('smooth', S.get('smooth')), vias=vias, via_mm=st.get('via_mm', S.get('via_mm')))
        miss = g.pop('_miss')
        xs, tkk = g.pop('_xs'), g.pop('_tk')
        # the pressure along the motion as it will run: from the ink's width,
        # smoothed over a few mm, with a writer's rhythm (heavier going down,
        # lighter going up) when asked
        rh = st.get('rhythm', S.get('rhythm', 0.0))
        if rh:
            vel = np.gradient(xs, tkk / 1000, axis=0)
            down = gsmooth(vel[:, 1] / np.maximum(np.hypot(*vel.T), 1e-6), 25.0)
            pt = np.interp(tkk, ts, pr) + rh * down
            lo, hi = st.get('pmin', S.get('pmin', 0.34)), st.get('pmax', S.get('pmax', 1.0))
            pt = np.clip(pt, lo, hi)
            # entering and leaving in motion: pressure tapers in over entry_mm
            # and out to a hairline over exit_mm (the flick off the paper)
            sl = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xs, axis=0).T))])
            ent, ex = st.get('entry_mm', S.get('entry_mm', 0)), st.get('exit_mm', S.get('exit_mm', 0))
            if ent:
                u = np.clip(sl / ent, 0, 1); pt = np.minimum(pt, 0.26 + (pt - 0.26) * np.sin(u * np.pi / 2))
            else:
                pt[:5] = np.minimum(pt[:5], np.linspace(0.3, pt[5], 5))
            if ex:
                u = np.clip((sl[-1] - sl) / ex, 0, 1); pt = np.minimum(pt, 0.2 + (pt - 0.2) * np.sin(u * np.pi / 2))
            else:
                pt[-3:] = np.minimum(pt[-3:], 0.3)
            prof_t, prof_p = tkk[::4], pt[::4]
        else:
            prof_t, prof_p = ts[::4], pr[::4]
        prof = [[round(float(t), 1), round(float(q), 3)] for t, q in zip(prof_t, prof_p)] + [[round(float(ts[-1]), 1), round(float(min(0.3, prof_p[-1])), 3)]]
        act = {"type": "lib", "stroke": "gesture", "label": f"signature: {st['name']}", **g, "pressure": prof,
               "looseness": 0, "brush": brush, "size": size, "load": st.get('load', S.get('load', 0.9))}
        if 'pigments' in S: act['pigments'] = S['pigments']
        else: act['color'] = S.get('color', '#2a2019')
        if 'water' in st or 'water' in S: act['water'] = st.get('water', S.get('water'))
        acts.append(act)
        t_total += ts[-1] + (st.get('lift_ms', S.get('lift_ms', 380)) if acts else 0)
        print(f"{st['name']}: {float(seg.sum()):.0f} mm, {ts[-1] / 1000:.2f} s, {len(g['pushes'])} pushes, pressure {pr.min():.2f}-{pr.max():.2f}, worst miss {miss:.3f} mm", file=sys.stderr)
        traces.append((P, w_mm / mm_per_px))
    # pen up between strokes: a pause so the motion keeps its rhythm
    out = []
    for i, (act, st) in enumerate(zip(acts, S['strokes'])):
        if i: out.append({"type": "wait", "s": st.get('lift_ms', S.get('lift_ms', 380)) / 1000, "label": "signature: pen up"})
        out.append(act)
    json.dump(out, open(a.out, 'w'))
    f0, f1 = to_sheet(bx0, by0), to_sheet(bx1, by1)
    print(json.dumps({"strokes": len(acts), "seconds": round(t_total / 1000, 2), "from": [round(f0[0], 5), round(f0[1], 5)], "to": [round(f1[0], 5), round(f1[1], 5)], "mm_per_px": round(mm_per_px, 4)}))
    if a.preview:
        im = Image.open(a.image).convert('RGB')
        im = Image.blend(im, Image.new('RGB', im.size, (255, 255, 255)), 0.6)
        d = ImageDraw.Draw(im)
        n_all = sum(len(P) for P, _ in traces); k = 0
        for (P, w), st in zip(traces, S['strokes']):
            for i in range(1, len(P)):
                u = k / max(1, n_all - 1); k += 1
                col = (int(255 * u), int(80 + 100 * (1 - abs(2 * u - 1))), int(255 * (1 - u)))
                d.line([tuple(P[i - 1]), tuple(P[i])], fill=col, width=max(1, int(w[i] * 0.35)))
            for x, y in st['pts']:
                d.ellipse([x - 4, y - 4, x + 4, y + 4], outline=(0, 0, 0))
        d.line([tuple(S['baseline'][0]), tuple(S['baseline'][1])], fill=(0, 160, 0), width=1)
        im.save(a.preview)


if __name__ == '__main__':
    main()
