#!/usr/bin/env python3
"""Hand lettering as strokes: skeletonize an image of brush lettering (dark
on light), prune the spurs, follow each stroke through junctions by good
continuation, order the strokes in reading order (line by line, left to
right; each from its upper-left end), and write a spec for signature.py,
which turns them into smooth timed gestures with a pen lift between.

  lettering.py IMAGE OUT_SPEC.json --width-mm 240 --at x,y [--preview P.png]
               [--brush round --size 2 --pigments '{"0": 1}' --speed 120]

--at is where the text block's centre lands (sheet fractions).
"""
import argparse, json, math, sys, os
from collections import deque
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from linecands import thin, fblur

NB8 = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def neighbours(sk, y, x):
    H, W = sk.shape
    return [(y + dy, x + dx) for dy, dx in NB8 if 0 <= y + dy < H and 0 <= x + dx < W and sk[y + dy, x + dx]]


def graph(sk):
    """nodes (ends and junction pixels) and the pixel paths between them"""
    ys, xs = np.nonzero(sk)
    deg = {(y, x): len(neighbours(sk, y, x)) for y, x in zip(ys, xs)}
    node = {p for p, d in deg.items() if d != 2}
    edges, seen = [], set()
    for n in node:
        for q in neighbours(sk, *n):
            if (n, q) in seen: continue
            path = [n, q]; prev, cur = n, q
            while cur not in node:
                nx = [r for r in neighbours(sk, *cur) if r != prev and r not in path[-3:]]
                if not nx: break
                prev, cur = cur, nx[0]; path.append(cur)
            seen.add((n, path[1])); seen.add((path[-1], path[-2]))
            edges.append(path)
    # closed loops with no node at all (an o)
    on_edge = {p for e in edges for p in e}
    for p in deg:
        if p in on_edge or p in node: continue
        loop = [p]; prev, cur = None, p
        while True:
            nx = [r for r in neighbours(sk, *cur) if r != prev and r not in loop[1:]]
            if not nx or (prev is not None and p in neighbours(sk, *cur) and len(loop) > 3): break
            prev, cur = cur, nx[0]; loop.append(cur)
        loop.append(p)
        on_edge |= set(loop)
        edges.append(loop)
    return edges, deg


def prune(sk, spur):
    for _ in range(3):
        edges, deg = graph(sk)
        changed = False
        for e in edges:
            a, b = e[0], e[-1]
            ends = (deg.get(a, 0) == 1) + (deg.get(b, 0) == 1)
            if ends == 1 and len(e) < spur:
                for p in e:
                    if deg.get(p, 0) <= 2 or p == (a if deg.get(a, 0) == 1 else b): sk[p] = 0
                changed = True
        if not changed: break
        sk = thin(sk)
    return sk


def strokes(sk, junction_r=6):
    edges, deg = graph(sk)
    # junction pixels that touch, as one junction
    J = [p for p, d in deg.items() if d >= 3]
    jid = {}
    for p in J:
        hit = next((jid[q] for q in jid if abs(q[0] - p[0]) + abs(q[1] - p[1]) <= junction_r), None)
        jid[p] = hit if hit is not None else len(set(jid.values()))
    key = lambda p: ('j', jid[p]) if p in jid else ('p', p)
    E = [np.array([(x, y) for y, x in e], float) for e in edges if len(e) >= 2]
    ends = [(key((int(e[0][1]), int(e[0][0]))), key((int(e[-1][1]), int(e[-1][0])))) for e in E]
    # the bits inside a junction (both ends in it, short) are not strokes
    used = [ends[i][0] == ends[i][1] and ends[i][0][0] == 'j' and len(E[i]) < 1.5 * junction_r for i in range(len(E))]
    def heading(P, at_end):
        k = min(len(P) - 1, 8)
        return (P[-1] - P[-1 - k]) if at_end else (P[0] - P[k])
    out = []
    while not all(used):
        # start: the unused edge end highest-leftmost, preferring free ends
        best = None
        for i, e in enumerate(E):
            if used[i]: continue
            for at_end in (False, True):
                p = e[-1] if at_end else e[0]
                free = ends[i][1 if at_end else 0][0] == 'p'
                score = (0 if free else 1, p[0] + 2 * p[1])
                if best is None or score < best[0]: best = (score, i, at_end)
        _, i, at_end = best
        P = E[i][::-1] if at_end else E[i]
        tail = ends[i][0] if at_end else ends[i][1]
        used[i] = True
        path = [P]
        # carry on through junctions along the straightest unused edge
        while tail[0] == 'j':
            h = heading(path[-1], True); h = h / (np.hypot(*h) or 1)
            cand = None
            for k, e in enumerate(E):
                if used[k]: continue
                for rev in (False, True):
                    if (ends[k][1] if rev else ends[k][0]) != tail: continue
                    Q = e[::-1] if rev else e
                    g = -heading(Q, False); g = g / (np.hypot(*g) or 1)
                    turn = math.degrees(math.acos(max(-1, min(1, float(h @ g)))))
                    if turn < 55 and (cand is None or turn < cand[0]): cand = (turn, k, rev)
            if cand is None: break
            _, k, rev = cand
            Q = E[k][::-1] if rev else E[k]
            used[k] = True; path.append(Q)
            tail = ends[k][0] if rev else ends[k][1]
        out.append(np.vstack(path))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image'); ap.add_argument('out')
    ap.add_argument('--width-mm', type=float, default=240); ap.add_argument('--at', default='0.5,0.5')
    ap.add_argument('--brush', default='round'); ap.add_argument('--size', type=int, default=2)
    ap.add_argument('--pigments', default='{"0": 1}'); ap.add_argument('--load', type=float, default=0.95)
    ap.add_argument('--speed', type=float, default=120); ap.add_argument('--pmin', type=float, default=0.4)
    ap.add_argument('--pmax', type=float, default=0.8); ap.add_argument('--smooth', type=float, default=1e-3)
    ap.add_argument('--preview')
    a = ap.parse_args()
    L = np.asarray(Image.open(a.image).convert('L')).astype(float)
    ink = fblur(L, 1.5) < 128
    ys, xs = np.nonzero(ink)
    sk = thin(ink)
    width = float(ink.sum() / max(1, sk.sum()))      # pen width: ink area over centreline length
    sk = prune(sk, spur=int(width * 0.9))
    S = strokes(sk, junction_r=max(3, int(width * 0.3)))
    # fragments shorter than the pen is wide are dropped, unless they stand
    # alone (the dot of an i)
    def length(P): return float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0.0
    def alone(i):
        P = S[i]; c = P.mean(0)
        return all(np.hypot(*(Q - c).T).min() > 1.2 * width for j, Q in enumerate(S) if j != i)
    S = [P for i, P in enumerate(S) if length(P) >= 0.3 * width or alone(i)]
    # coverage: centreline the strokes leave more than 0.45 pen widths away
    # (pieces lost at junctions) is painted too, as strokes of its own
    from collections import deque
    pts = np.vstack(S) if S else np.zeros((0, 2))
    sy, sx = np.nonzero(sk)
    left = np.zeros_like(sk, bool)
    for y, x in zip(sy, sx):
        if not len(pts) or np.min((pts[:, 0] - x) ** 2 + (pts[:, 1] - y) ** 2) > (0.45 * width) ** 2: left[y, x] = True
    seen = np.zeros_like(left)
    for y, x in zip(*np.nonzero(left)):
        if seen[y, x]: continue
        comp = []; q = deque([(y, x)]); seen[y, x] = True
        while q:
            cy_, cx_ = q.popleft(); comp.append((cy_, cx_))
            for dy, dx in NB8:
                yy, xx = cy_ + dy, cx_ + dx
                if 0 <= yy < left.shape[0] and 0 <= xx < left.shape[1] and left[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True; q.append((yy, xx))
        if len(comp) < 0.3 * width: continue
        # order the piece along its longer extent, from its upper-left end
        C = np.array([(cx_, cy_) for cy_, cx_ in comp], float)
        c0 = C.mean(0); u, sv, vt = np.linalg.svd(C - c0, full_matrices=False)
        t = (C - c0) @ vt[0]
        P = C[np.argsort(t)]
        if P[0][0] + 2 * P[0][1] > P[-1][0] + 2 * P[-1][1]: P = P[::-1]
        S.append(P)
    # strokes whose ends nearly meet, heading the same way, are one stroke
    # (a c or an o the skeleton broke at a junction)
    def dirn(P, at_end):
        k = min(len(P) - 1, max(2, int(width * 0.5)))
        d = (P[-1] - P[-1 - k]) if at_end else (P[k] - P[0])
        return d / (np.hypot(*d) or 1)
    merged = True
    while merged:
        merged = False
        best = None
        for i, P in enumerate(S):
            for j, Q in enumerate(S):
                if i == j or len(P) < 3 or len(Q) < 3: continue
                for rq in (False, True):
                    Qo = Q[::-1] if rq else Q
                    gap = float(np.hypot(*(Qo[0] - P[-1])))
                    if gap > 1.1 * width: continue
                    turn = math.degrees(math.acos(max(-1, min(1, float(dirn(P, True) @ dirn(Qo, False))))))
                    if turn < 65 and (best is None or gap < best[0]): best = (gap, i, j, rq)
        if best:
            _, i, j, rq = best
            Qo = S[j][::-1] if rq else S[j]
            S[i] = np.vstack([S[i], Qo]); del S[j]; merged = True
    # reading order: text lines from the empty rows between them, then left to right
    rows = ink.any(1)
    bands, y = [], 0
    while y < len(rows):
        if rows[y]:
            y0 = y
            while y < len(rows) and (rows[y] or (y + 1 < len(rows) and rows[min(len(rows) - 1, y + int(width))])): y += 1
            bands.append((y0, y))
        y += 1
    def line_of(P):
        c = P[:, 1].mean()
        return min(range(len(bands)), key=lambda k: 0 if bands[k][0] <= c <= bands[k][1] else min(abs(c - bands[k][0]), abs(c - bands[k][1])))
    S = sorted(S, key=lambda P: (line_of(P), P[:, 0].min()))
    x0, x1 = xs.min(), xs.max(); y0, y1 = ys.min(), ys.max()
    cx, cyb = (x0 + x1) / 2, (y0 + y1) / 2
    at = [float(v) for v in a.at.split(',')]
    sheet = [304.8, 228.6]
    mmpp = a.width_mm / (x1 - x0)
    # baseline = the block's horizontal extent through its centre: from→to
    fx0 = at[0] - (cx - x0) * mmpp / sheet[0]
    spec = {"strokes": [], "baseline": [[float(x0), float(cyb)], [float(x1), float(cyb)]],
            "at": [round(fx0, 5), at[1]], "width_mm": a.width_mm, "sheet_mm": sheet,
            "brush": a.brush, "size": a.size, "pigments": json.loads(a.pigments), "load": a.load,
            "speed": a.speed, "lift_ms": 260, "pmin": a.pmin, "pmax": a.pmax, "smooth": a.smooth,
            "via_mm": 2.5, "p_smooth_mm": 3.0}
    step = max(4, int(width * 0.5))
    for k, P in enumerate(S):
        idx = list(range(0, len(P), step))
        if idx[-1] != len(P) - 1: idx.append(len(P) - 1)
        pts = [[int(P[i][0]), int(P[i][1])] for i in idx]
        if len(pts) < 2: pts = [pts[0], [pts[0][0] + 2, pts[0][1] + 2]]
        spec["strokes"].append({"name": f"s{k + 1}", "pts": pts})
    json.dump(spec, open(a.out, 'w'), indent=1)
    print(json.dumps({"strokes": len(S), "stroke_px": round(width, 1), "mm_per_px": round(mmpp, 4), "stroke_mm": round(width * mmpp, 2)}))
    if a.preview:
        im = Image.open(a.image).convert('RGB')
        im = Image.blend(im, Image.new('RGB', im.size, (255, 255, 255)), 0.6)
        d = ImageDraw.Draw(im)
        for k, P in enumerate(S):
            u = k / max(1, len(S) - 1)
            col = (int(230 * u), 60, int(230 * (1 - u)))
            d.line([tuple(p) for p in P], fill=col, width=3)
            d.ellipse([P[0][0] - 5, P[0][1] - 5, P[0][0] + 5, P[0][1] + 5], fill=col)
            d.text((P[0][0] + 6, P[0][1] - 14), str(k + 1), fill=(0, 0, 0))
        im.save(a.preview)


if __name__ == '__main__':
    main()
