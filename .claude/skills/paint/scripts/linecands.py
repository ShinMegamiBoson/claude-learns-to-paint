"""Thin lines in the reference as polylines (mm): dark lines (darker than
their surroundings) or light ones (pale feather edges, highlights on bark,
throat streaks). The image at fine_mm against its blur at bg_mm, thresholded
by contrast, thinned to centrelines (Zhang-Suen), cut at junctions and sharp
corners, smoothed. Also each line's width (mm) and colour (L*a*b* along it).
Adapted from an earlier pencil line tool, generalised."""
import math
import numpy as np
from PIL import Image

NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def lstar(rgb):
    c = rgb.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    Y = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    return np.where(Y > 0.008856, 116 * np.cbrt(Y) - 16, 903.3 * Y)


def fblur(a, s):
    if s <= 0: return a
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(w)[None, :]
    return np.real(np.fft.ifft2(np.fft.fft2(a) * np.exp(-2 * math.pi ** 2 * s * s * (fx * fx + fy * fy))))


def thin(mask):
    img = mask.astype(np.uint8).copy()
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4, p5 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:]
            p6, p7, p8, p9 = P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]
            B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            A = sum(((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.uint8) for k in range(8))
            if step == 0: c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else: c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any(): img[rm] = 0; changed = True
        if not changed: return img


def trace(skel):
    H, W = skel.shape
    P = np.pad(skel, 1)
    ring = [P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:], P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2], P[:-2, 1:-1]]
    A = sum(((ring[k] == 0) & (ring[k + 1] == 1)).astype(np.uint8) for k in range(8))
    segm = (skel == 1) & (A <= 2)
    seen = np.zeros_like(segm)
    lines = []
    ys, xs = np.nonzero(segm)
    count = {(y, x): sum(1 for dy, dx in NB if 0 <= y + dy < H and 0 <= x + dx < W and segm[y + dy, x + dx]) for y, x in zip(ys, xs)}
    for y, x in [p for p, c in count.items() if c <= 1] + [p for p, c in count.items() if c == 2]:
        if seen[y, x]: continue
        line = [(y, x)]; seen[y, x] = True
        while True:
            yy, xx = line[-1]
            nxt = next(((yy + dy, xx + dx) for dy, dx in NB if 0 <= yy + dy < H and 0 <= xx + dx < W and segm[yy + dy, xx + dx] and not seen[yy + dy, xx + dx]), None)
            if nxt is None: break
            seen[nxt] = True; line.append(nxt)
        lines.append(line)
    return lines


def resample(P, step):
    d = np.hypot(*np.diff(P, axis=0).T); s = np.concatenate([[0], np.cumsum(d)])
    if s[-1] < step: return P
    t = np.arange(0, s[-1] + 1e-9, step)
    return np.stack([np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], 1)


def smooth(P, k):
    if len(P) < 3 or k < 1: return P
    Q = P.copy()
    for i in range(1, len(P) - 1):
        a, b = max(0, i - k), min(len(P), i + k + 1); Q[i] = P[a:b].mean(0)
    return Q


def split(P, corner_deg, max_len, step):
    out, cur = [], [P[0]]
    win = max(2, int(1.0 / step))
    for i in range(1, len(P)):
        cur.append(P[i])
        if win <= i < len(P) - win:
            a = P[i] - P[i - win]; b = P[i + win] - P[i]
            if math.degrees(abs(math.atan2(a[0] * b[1] - a[1] * b[0], a @ b))) > corner_deg and len(cur) > 2: out.append(np.array(cur)); cur = [P[i]]
        if (len(cur) - 1) * step >= max_len: out.append(np.array(cur)); cur = [P[i]]
    if len(cur) > 1: out.append(np.array(cur))
    return out


def extract(rgb, mmpx, S, lab=None):
    """rgb: the (cropped) reference; mmpx: mm per pixel. Returns [(P mm, width mm, colour Lab)]."""
    L = lstar(rgb)
    fine = fblur(L, S.get('fine_mm', 0.25) / mmpx); bg = fblur(L, S.get('bg_mm', 1.8) / mmpx)
    d = (fine - bg) if S.get('polarity', 'dark') == 'light' else (bg - fine)
    mask = d > S.get('contrast', 8)
    skel = thin(mask)
    step = 0.4
    out = []
    for line in trace(skel):
        if len(line) < 3: continue
        P = np.array([(x * mmpx, y * mmpx) for y, x in line], float)
        P = smooth(resample(P, step), S.get('smooth', 2))
        for Q in split(P, S.get('corner_deg', 50), S.get('max_len_mm', 30), step):
            if (len(Q) - 1) * step < S.get('min_len_mm', 1.5): continue
            # width: mask pixels near the line over its length
            px = (Q / mmpx).round().astype(int)
            px[:, 0] = px[:, 0].clip(0, mask.shape[1] - 1); px[:, 1] = px[:, 1].clip(0, mask.shape[0] - 1)
            r = max(1, int(round(1.2 / mmpx)))
            ys0, ys1 = max(0, px[:, 1].min() - r), min(mask.shape[0], px[:, 1].max() + r + 1)
            xs0, xs1 = max(0, px[:, 0].min() - r), min(mask.shape[1], px[:, 0].max() + r + 1)
            area = mask[ys0:ys1, xs0:xs1].sum() * mmpx * mmpx
            length = max(step, (len(Q) - 1) * step)
            width = float(np.clip(area / length * 0.6, 0.4, 3.0))
            col = lab[px[:, 1], px[:, 0]].mean(0) if lab is not None else None
            out.append((Q, width, col))
    return out
