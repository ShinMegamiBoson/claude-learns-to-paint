#!/usr/bin/env python3
"""As few strokes as possible, with any brush: every brush on the list
proposes strokes (each traced along the forms in the colour its footprint
should be), and the one that takes the most error off the sheet goes down
next, whichever brush it is, until `budget` strokes or until none is worth
`min_gain`. Error is measured against the reference as the score sees it
(about a millimetre of blur), weighted by where people look, and doubled on
bare board (a painter covers the board). Plan a batch, paint it, plan the
next from the real result (runloop.sh).

  paintmulti.py RUN_DIR SPEC.json OUT.json --render CURRENT.png [--preview P.png]

SPEC: brushes [{"brush", "size", "pressure", "coverage"?}, ...], px_per_mm (3),
weights may be {"region": name}, {"box": [...]}, {"line": [[x,y],...], "width_mm"} or
{"dots": [[x,y],...], "width_mm"}, each with "w" (overlaps take the larger);
budget (60), min_gain (ΔE·mm², 2), weights [{"region"|"box", "w"}], regions
file for weights (roles.json), threshold (ΔE a spot must miss by to get a
candidate, 4), trace_tol (8), mix_tol (6), pause_s (2), bare_weight (2),
refine (true), seed, label, dry_first (true), salience (a weight map PNG, weight x 25),
box [x0,y0,x1,y1] (strokes start only there: a closer look at one part; the planner
then works on that box plus margin_mm (25) only, so px_per_mm can be high),
target_blur_mm (0.5: how sharp a target the strokes are scored against),
lines [{"polarity": "light"|"dark", "contrast", "fine_mm", "bg_mm", "min_len_mm"}]
(thin lines in the reference proposed as strokes too, each with the line_brushes
brush nearest its width), line_brushes [...], protect [{"ellipse"|"box": [...]}]
(no stroke may touch these: an eye already painted)
"""
import argparse, heapq, json, math, os, random, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paintplan as PP
import linecands as LC
from paintplan import lab_of, blur, edge_field, to_gesture, mark_width, extend_path, LAG, lab_to_hex, W_MM, H_MM

ORDER = {'flat': 0, 'filbert': 1, 'round': 2, 'rigger': 3}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run'); ap.add_argument('spec'); ap.add_argument('out')
    ap.add_argument('--render', required=True); ap.add_argument('--preview')
    a = ap.parse_args()
    S = json.load(open(a.spec)); rnd = random.Random(S.get('seed', 1))
    ppm = float(S.get('px_per_mm', 3.0)); PP.PX_PER_MM = ppm
    # the part of the sheet planned on: a box (and a margin round it) for a close look
    if S.get('box') and S.get('crop', True):
        mg = S.get('margin_mm', 25.0)
        b = S['box']
        crop = [max(0.0, b[0] - mg / W_MM), max(0.0, b[1] - mg / H_MM), min(1.0, b[2] + mg / W_MM), min(1.0, b[3] + mg / H_MM)]
    else:
        crop = [0.0, 0.0, 1.0, 1.0]
    cx0, cy0, cx1, cy1 = crop
    Wp, Hp = int((cx1 - cx0) * W_MM * ppm), int((cy1 - cy0) * H_MM * ppm)
    def load_rgb(path):
        im = Image.open(path).convert('RGB'); w, h = im.size
        return np.asarray(im.crop((cx0 * w, cy0 * h, cx1 * w, cy1 * h)).resize((Wp, Hp), Image.LANCZOS)).astype(np.float64)
    tx = lambda x, y: ((x - cx0) / (cx1 - cx0) * Wp, (y - cy0) / (cy1 - cy0) * Hp)   # sheet fractions → crop px
    T_rgb = load_rgb(f'{a.run}/target.png')
    T = lab_of(T_rgb)
    C = lab_of(load_rgb(a.render))
    sg = S.get('target_blur_mm', 0.5) * ppm
    Tg, canvas = blur(T, sg), blur(C, sg)
    paper = lab_of(np.array([[[245.0, 243.0, 238.0]]]))[0, 0]
    dE = lambda A, B: np.sqrt(((A - B) ** 2).sum(-1))
    # where error counts: the subject and its face more, bare board double
    Wt = np.ones((Hp, Wp))
    polys = None
    for w in S.get('weights', []):
        m = Image.new('L', (Wp, Hp), 0); dr = ImageDraw.Draw(m)
        if 'region' in w:
            if polys is None: polys = json.load(open(f"{a.run}/{S.get('regions', 'roles.json')}"))
            dr.polygon([tx(x, y) for x, y in polys[w['region']]], fill=255)
        elif 'line' in w:
            dr.line([tx(x, y) for x, y in w['line']], fill=255, width=int(w.get('width_mm', 12) * ppm), joint='curve')
        elif 'dots' in w:
            r = w.get('width_mm', 18) * ppm / 2
            for x, y in w['dots']: q = tx(x, y); dr.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=255)
        else:
            b = w['box']; q0, q1 = tx(b[0], b[1]), tx(b[2], b[3]); dr.rectangle([q0[0], q0[1], q1[0], q1[1]], fill=255)
        mm = np.asarray(m) > 127
        if 'within' in w:
            # only where it overlaps a region (grown a little): a face box must not light up the sky beside it
            if polys is None: polys = json.load(open(f"{a.run}/{S.get('regions', 'roles.json')}"))
            r_ = Image.new('L', (Wp, Hp), 0); ImageDraw.Draw(r_).polygon([tx(x, y) for x, y in polys[w['within']]], fill=255)
            inside = np.asarray(r_) > 127
            for _ in range(int(2 * ppm)):
                e = inside.copy(); e[1:] |= inside[:-1]; e[:-1] |= inside[1:]; e[:, 1:] |= inside[:, :-1]; e[:, :-1] |= inside[:, 1:]; inside = e
            mm &= inside
        Wt = np.where(mm, np.maximum(Wt, w.get('w', 2.0)), Wt)
    Wt = blur(Wt, 3 * ppm)
    if S.get('salience'):
        # a salience map (weight x 25, grey), e.g. from a segmentation of the reference
        si = Image.open(f"{a.run}/{S['salience']}").convert('L'); sw, sh = si.size
        sal = np.asarray(si.crop((cx0 * sw, cy0 * sh, cx1 * sw, cy1 * sh)).resize((Wp, Hp), Image.BILINEAR)).astype(np.float64) / 25.0
        Wt = np.maximum(Wt, blur(np.maximum(sal, 1.0), 1.5 * ppm))
    bare = (dE(canvas, paper) < 4) & (dE(Tg, paper) > 6)
    Wt = Wt * np.where(bare, S.get('bare_weight', 2.0), 1.0)
    thr, ttol = S.get('threshold', 4.0), S.get('trace_tol', 8.0)
    cands = []
    # no stroke may touch what is protected (an eye already painted)
    prot = np.zeros((Hp, Wp), bool)
    for pr in S.get('protect', []):
        m = Image.new('L', (Wp, Hp), 0); dr = ImageDraw.Draw(m)
        b = pr.get('ellipse') or pr.get('box'); q0, q1 = tx(b[0], b[1]), tx(b[2], b[3])
        (dr.ellipse if 'ellipse' in pr else dr.rectangle)([q0[0], q0[1], q1[0], q1[1]], fill=255)
        prot |= np.asarray(m) > 127

    def footprint(P, rad, cover):
        lo = np.maximum(np.floor(P.min(0) - rad - 2).astype(int), 0); hi = np.minimum(np.ceil(P.max(0) + rad + 2).astype(int), [Wp, Hp])
        m = Image.new('L', (int(hi[0] - lo[0]), int(hi[1] - lo[1])), 0); d = ImageDraw.Draw(m)
        Q = [tuple(q - lo) for q in P]
        if len(Q) > 1: d.line(Q, fill=255, width=max(1, int(2 * rad)), joint='curve')
        for q in (Q[0], Q[-1]): d.ellipse([q[0] - rad, q[1] - rad, q[0] + rad, q[1] + rad], fill=255)
        return (int(lo[1]), int(hi[1]), int(lo[0]), int(hi[0])), np.asarray(m).astype(np.float64) / 255 * cover

    def fit(P, bi):
        B = brushes[bi]
        fp = footprint(P, B['rad'], B['cover'])
        (a0, a1, b0, b1), mk = fp
        ws = mk.sum()
        col = (Tg[a0:a1, b0:b1] * mk[..., None]).sum((0, 1)) / ws if ws > 0 else Tg[int(P[0][1]) % Hp, int(P[0][0]) % Wp]
        return {'P': P, 'col': col, 'fp': fp, 'b': bi}

    def gain_of(c, cv):
        (a0, a1, b0, b1), mk = c['fp']
        if prot[a0:a1, b0:b1][mk > 0.05].any(): return -1e9
        t, cn = Tg[a0:a1, b0:b1], cv[a0:a1, b0:b1]
        after = cn * (1 - mk[..., None]) + c['col'] * mk[..., None]
        return float(((dE(t, cn) - dE(t, after)) * Wt[a0:a1, b0:b1]).sum()) / ppm ** 2

    brushes = []
    for B in S['brushes']:
        B = dict(B); B.setdefault('pressure', 0.6)
        B['width'] = mark_width(B['brush'], int(B['size']), B['pressure'])
        B['rad'] = B['width'] * ppm / 2
        B['cover'] = B.get('coverage', 0.85 if B['brush'] != 'round' else 0.75)
        brushes.append(B)
    for bi, B in enumerate(brushes):
        w = B['width']
        Tb = blur(T, max(1.0, w * ppm / 3))
        th, coh = edge_field(T[..., 0], max(2.0, w * ppm * 0.6))
        hand = math.radians(-30)
        grid = 0.5 * w * ppm; step = max(1.0, w * 0.25) * ppm
        max_len = B.get('max_len_mm', max(15.0, w * 6)) * ppm; min_len = max(2.0, w * 0.5) * ppm
        turn = math.radians(4) / ppm * step
        E = dE(Tb, canvas)

        def direction(p, prev):
            i, j = int(min(Hp - 1, max(0, p[1]))), int(min(Wp - 1, max(0, p[0])))
            t = th[i, j] if coh[i, j] > 0.15 else hand
            d = np.array([math.cos(t), math.sin(t)])
            return -d if prev is not None and d @ prev < 0 else d
        bx = S.get('box', [0, 0, 1, 1]); q0, q1 = tx(bx[0], bx[1]), tx(bx[2], bx[3])
        for y in np.arange(max(0, q0[1]), min(Hp, q1[1]), grid):
            for x in np.arange(max(0, q0[0]), min(Wp, q1[0]), grid):
                a0, a1, b0, b1 = int(y), int(min(Hp, y + grid)), int(x), int(min(Wp, x + grid))
                sub = E[a0:a1, b0:b1] * Wt[a0:a1, b0:b1]
                if sub.size == 0 or sub.mean() < thr: continue
                k = np.unravel_index(sub.argmax(), sub.shape)
                p0 = np.array([b0 + k[1] + 0.5, a0 + k[0] + 0.5]); col = Tb[int(p0[1]), int(p0[0])]
                halves = []
                for sgn in (1, -1):
                    pts, p, L = [], p0.copy(), 0.0
                    d = direction(p, None) * sgn
                    while L < max_len / 2:
                        nd = direction(p, d)
                        ang = max(-turn, min(turn, math.atan2(d[0] * nd[1] - d[1] * nd[0], d @ nd)))
                        d = np.array([math.cos(ang) * d[0] - math.sin(ang) * d[1], math.sin(ang) * d[0] + math.cos(ang) * d[1]])
                        q = p + d * step
                        if not (0 <= q[0] < Wp and 0 <= q[1] < Hp): break
                        here = Tb[int(q[1]), int(q[0])]
                        if dE(here, col) > dE(here, canvas[int(q[1]), int(q[0])]) + 1.0 or dE(here, col) > ttol: break
                        p = q; L += step; pts.append(p.copy())
                    halves.append(pts)
                P = np.array(halves[1][::-1] + [p0] + halves[0])
                if len(P) < 2 or np.hypot(*np.diff(P, axis=0).T).sum() < min_len:
                    d = direction(p0, None); P = np.array([p0 - d * min_len / 2, p0 + d * min_len / 2])
                cands.append(fit(P, bi))

    # thin lines in the reference (feather edges, streaks, twigs) as strokes too
    if S.get('lines'):
        lb0 = len(brushes)
        for B in S.get('line_brushes', [{"brush": "round", "size": 0, "pressure": 0.45}, {"brush": "round", "size": 0, "pressure": 0.6}, {"brush": "round", "size": 2, "pressure": 0.55}]):
            B = dict(B); B['width'] = mark_width(B['brush'], int(B['size']), B['pressure']); B['rad'] = B['width'] * ppm / 2
            B['cover'] = B.get('coverage', 0.75); B['line'] = True; brushes.append(B)
        bx = S.get('box', [0, 0, 1, 1]); q0, q1 = tx(bx[0], bx[1]), tx(bx[2], bx[3])
        Tsharp = blur(T, 0.15 * ppm)
        nl = 0
        for L_ in S['lines']:
            for Q, wmm, col in LC.extract(T_rgb, 1.0 / ppm, L_, Tsharp):
                P = Q * ppm
                ctr = P.mean(0)
                if not (q0[0] <= ctr[0] <= q1[0] and q0[1] <= ctr[1] <= q1[1]): continue
                bi = min(range(lb0, len(brushes)), key=lambda i: abs(brushes[i]['width'] - wmm))
                c = fit(P, bi)
                if col is not None: c['col'] = col
                cands.append(c); nl += 1
        print(f'{nl} line candidates', file=sys.stderr)

    def refine(c, cv):
        best, bg = c, gain_of(c, cv)
        P = c['P']; ctr = P.mean(0); rad = brushes[c['b']]['rad']
        ch = P[-1] - P[0]; n = np.hypot(*ch)
        u = ch / n if n > 1e-6 else np.array([1.0, 0.0]); v = np.array([-u[1], u[0]])
        sh = 0.6 * rad
        vs = [P + v * sh, P - v * sh, P + u * sh, P - u * sh]
        for ang in (-0.2, -0.1, 0.1, 0.2):
            R = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]]); vs.append((P - ctr) @ R.T + ctr)
        k = max(1, len(P) // 5)
        if len(P) > 2 * k + 1: vs.append(P[k:-k])
        vs.append(extend_path(P, 0.2 * n, 0.2 * n))
        for V in vs:
            V = np.clip(V, [0, 0], [Wp - 1, Hp - 1])
            cv_ = fit(V, c['b'])
            if brushes[c['b']].get('line'): cv_['col'] = c['col']   # a line keeps its own colour
            g = gain_of(cv_, cv)
            if g > bg: best, bg = cv_, g
        return best, bg

    budget, min_gain = S.get('budget', 60), S.get('min_gain', 2.0)
    heap = [(-gain_of(c, canvas), k) for k, c in enumerate(cands)]
    heapq.heapify(heap)
    chosen = []
    while heap and len(chosen) < budget:
        ng, k = heapq.heappop(heap)
        g = gain_of(cands[k], canvas)
        if heap and g < -heap[0][0] * 0.97:
            heapq.heappush(heap, (-g, k)); continue
        if g < min_gain: break
        c = cands[k]
        if S.get('refine', True): c, g = refine(c, canvas)
        (a0, a1, b0, b1), mk = c['fp']
        canvas[a0:a1, b0:b1] = canvas[a0:a1, b0:b1] * (1 - mk[..., None]) + c['col'] * mk[..., None]
        chosen.append(dict(c, gain=g))
    # palette mixes, then emit in the order chosen
    cols = np.array([c['col'] for c in chosen]) if chosen else np.zeros((0, 3))
    tol = S.get('mix_tol', 6.0); centres, lab = [], []
    for c in cols:
        if centres:
            d = np.sqrt(((np.array(centres) - c) ** 2).sum(-1)); j = int(d.argmin())
            if d[j] <= tol: lab.append(j); continue
        centres.append(c); lab.append(len(centres) - 1)
    imp = S.get('imprecision', {'heading_deg': 2.0, 'wobble_deg': 1.5, 'length_frac': 0.05})
    acts = [{"type": "dry", "label": "let it dry"}] if S.get('dry_first', True) else []
    last_mix, last_b = None, None
    for c, j in zip(chosen, lab):
        B = brushes[c['b']]; hexc = lab_to_hex(centres[j])
        if last_b is not None and (ORDER[B['brush']], -B['width']) > (ORDER[brushes[last_b]['brush']], -brushes[last_b]['width']) and B['width'] < 0.6 * brushes[last_b]['width']:
            acts.append({"type": "dry", "label": "dry before the smaller brush"})
        elif last_mix is not None and j != last_mix and S.get('pause_s', 2):
            acts.append({"type": "wait", "s": S.get('pause_s', 2), "label": f"mix {hexc}"})
        last_mix, last_b = j, c['b']
        P = c['P'] / ppm + np.array([cx0 * W_MM, cy0 * H_MM])
        if (P[-1][0] < P[0][0] and abs(P[-1][1] - P[0][1]) < abs(P[-1][0] - P[0][0])) or (P[-1][1] < P[0][1] and abs(P[-1][0] - P[0][0]) < abs(P[-1][1] - P[0][1])):
            P = P[::-1]   # the hand pulls toward itself: rightward and downward
        ex = {"brush": B['brush'], "size": int(B['size']), "pressure": B['pressure'], "load": B.get('load', 0.85), "color": hexc}
        if B['brush'] in ('flat', 'filbert'):
            d = P[-1] - P[0]; phi = math.atan2(d[1], d[0]) if np.hypot(*d) > 1e-6 else 0.0
            ex['flatAngle'] = round(-phi + math.pi / 2, 3)
        P = extend_path(P, *LAG.get(B['brush'], (1.8, 1.5)))
        acts.append(to_gesture(P, f"{S.get('label', 'stroke')} {B['brush']}{B['size']} {hexc}", B.get('speed', 110 + 3 * B['width']), max(2.0, B['width'] * 0.6), ex, rnd, imp))
    json.dump(acts, open(a.out, 'w'))
    if a.preview:
        def rgb(L):
            fy = (L[..., 0] + 16) / 116; fx = fy + L[..., 1] / 500; fz = fy - L[..., 2] / 200
            inv = lambda t: np.where(t ** 3 > 216 / 24389, t ** 3, (116 * t - 16) / (24389 / 27))
            X, Y, Z = inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883
            c = np.clip(np.stack([3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z], -1), 0, 1)
            return (255 * np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)).astype(np.uint8)
        im = Image.new('RGB', (2 * Wp + 8, Hp), (255, 255, 255)); im.paste(Image.fromarray(rgb(Tg)), (0, 0)); im.paste(Image.fromarray(rgb(canvas)), (Wp + 8, 0))
        dr = ImageDraw.Draw(im)
        for c in chosen: dr.line([(q[0] + Wp + 8, q[1]) for q in c['P']], fill=[(255, 0, 0), (255, 140, 0), (0, 160, 0), (0, 0, 255)][ORDER[brushes[c['b']]['brush']]], width=1)
        im.save(a.preview)
    used = {}
    for c in chosen: k = f"{brushes[c['b']]['brush']}{brushes[c['b']]['size']}"; used[k] = used.get(k, 0) + 1
    print(json.dumps({'strokes': len(chosen), 'candidates': len(cands), 'brushes': used, 'mixes': len(centres),
                      'weighted_err': [round(float((dE(Tg, blur(C, sg)) * Wt).mean()), 2), round(float((dE(Tg, canvas) * Wt).mean()), 2)],
                      'last_gain': round(chosen[-1]['gain'], 1) if chosen else 0}))


if __name__ == '__main__':
    main()
