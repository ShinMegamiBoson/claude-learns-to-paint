# snap a rough centreline to the reference's dark ridge, measure its width,
# and turn it back into motion (a start, a heading and turns).
import sys, json, math, numpy as np, warnings; warnings.filterwarnings('ignore')
from PIL import Image
W, H = 304.8, 228.6
_T = None
def Lmap(run):
    global _T
    if _T is None:
        a = np.asarray(Image.open(f'paintings/{run}/target.png').convert('RGB')).astype(float) / 255.
        lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
        Y = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
        L = 116 * np.cbrt(Y) - 16
        r = 2; c = np.cumsum(np.cumsum(np.pad(L, ((r + 1, r), (r + 1, r)), mode='edge'), 0), 1); k = 2 * r + 1
        _T = (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)
    return _T
def at(L, x, y):
    h, w = L.shape; i = min(h - 1, max(0, int(y / H * h))); j = min(w - 1, max(0, int(x / W * w))); return L[i, j]
def resample(P, step):
    out = [P[0]]; acc = 0
    for a, b in zip(P, P[1:]):
        d = math.dist(a, b); t = step - acc
        while t <= d: out.append((a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d)); t += step
        acc = (acc + d) % step
    if math.dist(out[-1], P[-1]) > step * 0.3: out.append(P[-1])
    return out
def snap(run, pts, search=5.0, step=2.0, thr=None):
    """pts in sheet fractions -> snapped mm centreline, widths (mm), mean L"""
    L = Lmap(run); P = resample([(x * W, y * H) for x, y in pts], step)
    O, N, Wd, Ls = [], [], [], []
    for i, (x, y) in enumerate(P):
        a, b = P[max(0, i - 1)], P[min(len(P) - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]; n = math.hypot(tx, ty) or 1; nx, ny = -ty / n, tx / n
        offs = np.arange(-search, search + 0.01, 0.2)
        prof = np.array([at(L, x + nx * o, y + ny * o) for o in offs])
        o0 = offs[int(np.argmin(prof + 0.8 * np.abs(offs)))]   # darkest, preferring near
        bg = max(np.percentile(prof, 90), prof.min() + 8); half = (prof.min() + bg) / 2
        j = int(np.argmin(np.abs(offs - o0))); lo = j; hi = j
        while lo > 0 and prof[lo - 1] < half: lo -= 1
        while hi < len(prof) - 1 and prof[hi + 1] < half: hi += 1
        O.append(float(o0)); N.append((nx, ny)); Wd.append((hi - lo + 1) * 0.2); Ls.append(float(prof[j]))
    # a blade does not jump sideways: median, then a wide mean, of the offsets
    O = np.array(O); k = 3
    med = np.array([np.median(O[max(0, i - k):i + k + 1]) for i in range(len(O))])
    sm = np.array([med[max(0, i - k):i + k + 1].mean() for i in range(len(O))])
    C = [(x + nx * o, y + ny * o) for (x, y), (nx, ny), o in zip(P, N, sm)]
    S = [C[0]] + [((C[i - 1][0] + 2 * C[i][0] + C[i + 1][0]) / 4, (C[i - 1][1] + 2 * C[i][1] + C[i + 1][1]) / 4) for i in range(1, len(C) - 1)] + [C[-1]]
    return S, Wd, Ls
def to_motion(C, v, seg=8.0):
    """mm centreline -> v0 heading and {turn, ms} pushes at speed v"""
    hd = [math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) for a, b in zip(C, C[1:])]
    for i in range(1, len(hd)):
        while hd[i] - hd[i - 1] > 180: hd[i] -= 360
        while hd[i] - hd[i - 1] < -180: hd[i] += 360
    ln = [math.dist(a, b) for a, b in zip(C, C[1:])]
    pushes, i = [], 0
    while i < len(ln):
        j, acc = i, 0
        while j < len(ln) and acc < seg: acc += ln[j]; j += 1
        h0 = hd[i] if i == 0 else 0.5 * (hd[i - 1] + hd[i]); h1 = hd[j - 1] if j >= len(ln) else 0.5 * (hd[j - 1] + hd[j])
        d = h1 - h0
        pushes.append({"turn": round(v * v * math.radians(d) / max(acc, 0.5)), "ms": round(1000 * acc / v)} if abs(d) > 0.5 else {"along": 0, "ms": round(1000 * acc / v)})
        i = j
    return round(hd[0], 1), pushes
