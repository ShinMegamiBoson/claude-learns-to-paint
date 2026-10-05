#!/usr/bin/env python3
"""Image helpers for the paint skill: prepare a reference as a painting
target, score a render against it, and extract palettes, value bands and
region outlines to plan strokes from. Needs numpy and Pillow.

  imgtool.py prepare REF BLANK OUT [--fit crop|pad]   crop/resize REF to the sheet, match its paper to BLANK
  imgtool.py grid IMG OUT                             overlay a labelled 0..1 coordinate grid
  imgtool.py score TARGET RENDER [--eval OUT.png] [--prev JSON]   metrics as JSON (+ visual comparison)
  imgtool.py palette TARGET [--k 8] [--out OUT.png]   dominant colours with coverage and position
  imgtool.py regions TARGET --by value|color [--levels 4 | --k 6] --out REGIONS.json [--overlay OUT.png]
  imgtool.py judge TARGET PARENT_DRY CHILD_DRY [--parent-wet P.png --footprints a1.png a2.png ...] [--labels JSON]
                                                     did this batch improve the sheet where it painted?

All coordinates are sheet fractions: x right, y down, 0..1.
"""
import argparse
import json
import math
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

WORK_W = 384  # analysis width; height follows the sheet aspect
OPAQUE = False  # set by --opaque (gouache): scoring forgives too-dark, the judge works on colour


# ------------------------------------------------------------ colour
def srgb_to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055) * 255.0


def rgb_to_lab(rgb):
    lin = srgb_to_linear(rgb.astype(np.float64))
    np.seterr(all="ignore")  # numpy 2 + Accelerate can warn spuriously in matmul
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def gauss_blur(a, sigma):
    if sigma <= 0:
        return a
    r = max(1, int(math.ceil(sigma * 3)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = a
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out, dtype=np.float64)
        n = out.shape[axis]
        for i, w in enumerate(k):
            sl = [slice(None)] * out.ndim
            sl[axis] = slice(i, i + n)
            acc += w * p[tuple(sl)]
        out = acc
    return out


def load_rgb(path, size=None):
    im = Image.open(path).convert("RGB")
    if size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float64)


def work_size(path):
    w, h = Image.open(path).size
    return WORK_W, max(8, round(WORK_W * h / w))


# ------------------------------------------------------------ prepare
def paper_colour(rgb):
    """Median colour of the brightest, least saturated tenth of the image."""
    lab = rgb_to_lab(rgb)
    L, C = lab[..., 0], np.hypot(lab[..., 1], lab[..., 2])
    score = L - 0.5 * C
    thr = np.percentile(score, 90)
    m = score >= thr
    return np.median(rgb[m], axis=0)


def cmd_prepare(a):
    ref = Image.open(a.ref).convert("RGB")
    blank = Image.open(a.blank).convert("RGB")
    W, H = blank.size
    aspect = W / H
    rw, rh = ref.size
    if a.fit == "crop":
        if rw / rh > aspect:
            nw = round(rh * aspect)
            x0 = (rw - nw) // 2
            ref = ref.crop((x0, 0, x0 + nw, rh))
        else:
            nh = round(rw / aspect)
            y0 = (rh - nh) // 2
            ref = ref.crop((0, y0, rw, y0 + nh))
        ref = ref.resize((W, H), Image.LANCZOS)
    else:
        scale = min(W / rw, H / rh)
        sm = ref.resize((round(rw * scale), round(rh * scale)), Image.LANCZOS)
        pc = tuple(int(v) for v in paper_colour(np.asarray(sm).astype(np.float64)))
        canvas = Image.new("RGB", (W, H), pc)
        canvas.paste(sm, ((W - sm.width) // 2, (H - sm.height) // 2))
        ref = canvas
    rgb = np.asarray(ref).astype(np.float64)
    brgb = np.asarray(blank).astype(np.float64)
    # white-balance: map the reference's paper onto the simulation's paper
    # in linear light, so bare paper scores as bare paper
    src = srgb_to_linear(paper_colour(rgb))
    dst = srgb_to_linear(np.median(brgb.reshape(-1, 3), axis=0))
    gain = dst / np.maximum(src, 1e-4)
    if a.no_balance:
        # opaque paint covers the whole sheet: no paper shows, nothing to match
        gain = np.ones(3)
    out = linear_to_srgb(srgb_to_linear(rgb) * gain)
    Image.fromarray(out.round().astype(np.uint8)).save(a.out)
    print(json.dumps({"target": a.out, "size": [W, H], "paper_ref": [round(v) for v in paper_colour(rgb)],
                      "paper_sim": [round(v) for v in np.median(brgb.reshape(-1, 3), axis=0)], "gain": [round(v, 3) for v in gain]}))


# ------------------------------------------------------------ grid
def font(size):
    for name in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
                 "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_grid(im, step=0.05, labels=True):
    im = im.convert("RGB")
    W, H = im.size
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    f = font(max(11, W // 90))
    n = round(1 / step)
    for i in range(n + 1):
        t = i * step
        major = i % 2 == 0
        col = (30, 90, 200, 150 if major else 70)
        x, y = round(t * (W - 1)), round(t * (H - 1))
        d.line([(x, 0), (x, H)], fill=col, width=1)
        d.line([(0, y), (W, y)], fill=col, width=1)
        if labels and major and 0 < i < n:
            d.text((x + 2, 2), f"{t:.1f}", fill=(20, 60, 170, 230), font=f)
            d.text((2, y + 1), f"{t:.1f}", fill=(20, 60, 170, 230), font=f)
    return Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")


def cmd_grid(a):
    draw_grid(Image.open(a.img)).save(a.out)
    print(a.out)


# ------------------------------------------------------------ score
def ssim(x, y, sigma=1.5, L=100.0):
    C1, C2 = (0.01 * L) ** 2, (0.03 * L) ** 2
    mx, my = gauss_blur(x, sigma), gauss_blur(y, sigma)
    sxx = gauss_blur(x * x, sigma) - mx * mx
    syy = gauss_blur(y * y, sigma) - my * my
    sxy = gauss_blur(x * y, sigma) - mx * my
    s = ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx * mx + my * my + C1) * (sxx + syy + C2))
    return float(s.mean())


GRID_R, GRID_C = 6, 8


def analyse(target_path, render_path, paper=None):
    size = work_size(target_path)
    T = rgb_to_lab(load_rgb(target_path, size))
    R = rgb_to_lab(load_rgb(render_path, size))
    Tb, Rb = gauss_blur(T, 1.5), gauss_blur(R, 1.5)
    dE = np.sqrt(((Tb - Rb) ** 2).sum(-1))
    Tc, Rc = gauss_blur(T, 6), gauss_blur(R, 6)
    dEc = np.sqrt(((Tc - Rc) ** 2).sum(-1))
    dL = Rb[..., 0] - Tb[..., 0]              # + render lighter than target
    tol = 4.0
    dark = np.maximum(0, -dL - tol)           # paint where the target is lighter: hard to undo
    light = np.maximum(0, dL - tol)           # still to be painted
    dab = np.sqrt(((Tb[..., 1:] - Rb[..., 1:]) ** 2).sum(-1))
    chroma = np.maximum(np.hypot(Tb[..., 1], Tb[..., 2]), np.hypot(Rb[..., 1], Rb[..., 2]))
    hue_mask = chroma > 8
    # bare paper in the target: close to the simulation's paper colour
    if paper is not None:
        pl = rgb_to_lab(np.array(paper, dtype=np.float64)[None, None])[0, 0]
        paper_T = np.sqrt(((Tb - pl) ** 2).sum(-1)) < 6
    else:
        paper_T = Tb[..., 0] > np.percentile(Tb[..., 0], 97) - 3
    m = {
        "error": round(float(dE.mean()), 2),
        "error_coarse": round(float(dEc.mean()), 2),
        "too_dark": round(float(dark.mean()), 2),
        "too_light": round(float(light.mean()), 2),
        "colour": round(float(dab[hue_mask].mean()) if hue_mask.any() else 0.0, 2),
        "ssim": round(ssim(Tb[..., 0], Rb[..., 0]), 3),
        "matched": round(float((dE < 8).mean()), 3),
        "whites_lost": round(float((paper_T & (dL < -6)).sum() / paper_T.sum()), 3) if paper_T.mean() > 0.002 else 0.0,
        "paper_share": round(float(paper_T.mean()), 3),
    }
    h, w = dE.shape
    cells = []
    for r in range(GRID_R):
        for c in range(GRID_C):
            ys, ye = r * h // GRID_R, (r + 1) * h // GRID_R
            xs, xe = c * w // GRID_C, (c + 1) * w // GRID_C
            cd = float(dL[ys:ye, xs:xe].mean())
            ce = float(dE[ys:ye, xs:xe].mean())
            cab = float(dab[ys:ye, xs:xe].mean())
            kind = "too dark" if cd < -tol else "too light" if cd > tol else "hue/colour" if cab > 8 else "texture/edges"
            cells.append({"cell": f"r{r}c{c}", "x": [round(c / GRID_C, 3), round((c + 1) / GRID_C, 3)],
                          "y": [round(r / GRID_R, 3), round((r + 1) / GRID_R, 3)], "error": round(ce, 1),
                          "dL": round(cd, 1), "kind": kind,
                          "target_L": round(float(Tb[ys:ye, xs:xe, 0].mean()), 1),
                          "render_L": round(float(Rb[ys:ye, xs:xe, 0].mean()), 1)})
    cells.sort(key=lambda z: -z["error"])
    m["worst"] = cells[:6]
    # paint that only darkens (watercolor, ink, pencil) cannot take back what
    # went too dark; opaque paint can, so it pays no extra for it
    m["score"] = round(m["error"] + 0.5 * m["error_coarse"] + (0.0 if OPAQUE else 2.0) * m["too_dark"], 2)
    maps = {"dark": dark, "light": light, "dab": dab, "dE": dE}
    return m, maps


def cmd_score(a):
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    m, maps = analyse(a.target, a.render, paper)
    if a.prev:
        try:
            p = json.loads(open(a.prev).read()) if not a.prev.strip().startswith("{") else json.loads(a.prev)
            m["delta"] = {k: round(m[k] - p[k], 3) for k in ("score", "error", "error_coarse", "too_dark", "too_light", "colour", "ssim", "whites_lost") if k in p}
        except Exception as e:  # noqa: BLE001
            m["delta_error"] = str(e)
    if a.eval:
        make_eval(a.target, a.render, maps, m, a.eval, a.title or "")
        m["eval"] = a.eval
    print(json.dumps(m))


def make_eval(target_path, render_path, maps, m, out, title):
    PW = 640
    t = Image.open(target_path).convert("RGB")
    PH = round(PW * t.height / t.width)
    t = t.resize((PW, PH), Image.LANCZOS)
    r = Image.open(render_path).convert("RGB").resize((PW, PH), Image.LANCZOS)
    # error map: render in faded grey; red = darker than target (hard to undo),
    # blue = lighter (still to paint), magenta = wrong hue at right value
    g = np.asarray(r.convert("L")).astype(np.float64)
    base = 170 + g * 0.33
    up = lambda x: np.asarray(Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).resize((PW, PH), Image.BILINEAR)).astype(np.float64)
    dk = up(maps["dark"] * 8) / 255
    lt = up(maps["light"] * 8) / 255
    hu = up(np.maximum(0, maps["dab"] - 8) * 10) / 255 * (1 - np.maximum(dk, lt))
    rgb = np.stack([base, base, base], -1)
    rgb = rgb * (1 - dk[..., None]) + np.array([215, 30, 30]) * dk[..., None]
    rgb = rgb * (1 - lt[..., None]) + np.array([30, 80, 220]) * lt[..., None]
    rgb = rgb * (1 - hu[..., None]) + np.array([200, 40, 200]) * hu[..., None]
    e = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    head = 54
    W = PW * 3 + 16
    im = Image.new("RGB", (W, PH + head + 8), (246, 244, 240))
    d = ImageDraw.Draw(im)
    f, fs = font(17), font(14)
    d.text((8, 6), title, fill=(20, 20, 20), font=f)
    delta = m.get("delta", {})
    def fmt(k, sign=True):
        v = m[k]
        dv = delta.get(k)
        return f"{k} {v}" + (f" ({dv:+.2f})" if dv is not None and sign else "")
    d.text((8, 30), "   ".join(fmt(k) for k in ("score", "error", "error_coarse", "too_dark", "too_light", "colour", "ssim", "whites_lost")), fill=(60, 60, 60), font=fs)
    for i, (p, lab) in enumerate(((t, "target"), (r, "painting"), (e, "red: too dark · blue: too light · magenta: hue"))):
        x = 4 + i * (PW + 4)
        im.paste(draw_grid(p, 0.1, labels=(i < 2)), (x, head))
        d.rectangle([x, head + PH - 20, x + 8 + d.textlength(lab, font=fs), head + PH], fill=(246, 244, 240))
        d.text((x + 4, head + PH - 18), lab, fill=(40, 40, 40), font=fs)
    im.save(out)


# ------------------------------------------------------------ judge
# The whole-sheet score averages over everything, so a batch that touches 2%
# of the paper moves it by noise-sized amounts, and any ink near where the
# target has ink "pays" by shrinking too_light even when it is the wrong shape.
# The judge looks only where the batch changed the sheet, forgives ~1.6 mm of
# misregistration, and asks: did local error fall, did new ink land on target
# ink of at least that darkness (precision), and how much went darker than
# the target allows (over-dark, with a tolerance that tightens for pale tones)?

def disc_max(a, r):
    out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r and (dx or dy):
                out = np.maximum(out, np.roll(np.roll(a, dy, 0), dx, 1))
    return out


def tolerant_abs(A, B, r):
    """min over q within r of |A(p) - B(q)|"""
    best = np.abs(A - B)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r and (dx or dy):
                best = np.minimum(best, np.abs(A - np.roll(np.roll(B, dy, 0), dx, 1)))
    return best


def lum(path, size, blur):
    return gauss_blur(rgb_to_lab(load_rgb(path, size)), blur)[..., 0]


R_TOL = 2          # px at 384 wide ≈ 1.6 mm: is the mark crisp and right?
R_COARSE = 6       # ≈ 4.8 mm: is this mark where the target has that mark?
CHANGE = 2.5       # L* change that counts as "the batch touched this pixel"


STRUCT_W = 1.0   # weight of the structure term in net (bot.js evaluate uses the same)


def struct_tensor(L):
    """Local structure tensor of L* (edge strength and direction) at the
    image's resolution, pooled 2x2, at two tolerances (≈0.8 mm and ≈2 mm on
    a 768-wide sheet): what kind of marks are where, not exactly where each
    edge falls."""
    gx = np.zeros_like(L); gy = np.zeros_like(L)
    gx[1:-1, 1:-1] = (L[:-2, 2:] + 2 * L[1:-1, 2:] + L[2:, 2:] - L[:-2, :-2] - 2 * L[1:-1, :-2] - L[2:, :-2]) / 8
    gy[1:-1, 1:-1] = (L[2:, :-2] + 2 * L[2:, 1:-1] + L[2:, 2:] - L[:-2, :-2] - 2 * L[:-2, 1:-1] - L[:-2, 2:]) / 8
    h2, w2 = L.shape[0] // 2, L.shape[1] // 2
    pool = lambda v: v[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).mean((1, 3))
    J = [pool(v) for v in (gx * gx, gx * gy, gy * gy)]
    return [[gauss_blur(v, s_) for v in J] for s_ in (1.0, 2.2)]


def structure_change(target, parent, child, size):
    """How much closer the child brings the local structure to the target's
    where it changed the sheet (100 = matches there, negative = further),
    the mean of two tolerances."""
    T, P, C = (lum(f, size, 0.7) for f in (target, parent, child))
    JT, JP, JC = struct_tensor(T), struct_tensor(P), struct_tensor(C)
    h2, w2 = JT[0][0].shape
    ch = (np.abs(C - P) > 2)[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).any((1, 3))
    M = disc_max(ch.astype(float), 3) > 0
    if M.sum() < 4:
        return 0.0
    tot = 0.0
    for k in range(2):
        G, A, B = JT[k], JP[k], JC[k]
        dist = lambda X: np.sqrt((X[0] - G[0]) ** 2 + 2 * (X[1] - G[1]) ** 2 + (X[2] - G[2]) ** 2)
        mag = lambda X: np.sqrt(X[0] ** 2 + 2 * X[1] ** 2 + X[2] ** 2)
        N = float((mag(G) + mag(A))[M].sum())
        tot += 100 * float((dist(A) - dist(B))[M].sum()) / N if N > 0 else 0.0
    return tot / 2


def judge(target, parent, child, paper=None, parent_wet=None, footprints=None, labels=None):
    size = work_size(target)
    T, P, C = lum(target, size, 1.0), lum(parent, size, 1.0), lum(child, size, 1.0)
    if paper is not None:
        paperL = float(rgb_to_lab(np.array(paper, dtype=np.float64)[None, None])[0, 0, 0])
    else:
        paperL = float(np.percentile(T, 97))
    DT, DP, DC = (np.clip(paperL - X, 0, None) for X in (T, P, C))
    M = disc_max((np.abs(C - P) > CHANGE).astype(float), 3) > 0
    out = {"area": round(float(M.mean()), 4)}
    if M.sum() < 5:
        out.update(verdict="no change", net=0.0)
        return out
    newink = (DC - DP) > 4

    def at(r):
        DTmax = disc_max(DT, r)
        eb, ea = tolerant_abs(P, T, r)[M].mean(), tolerant_abs(C, T, r)[M].mean()
        tol = np.maximum(4, 0.25 * DTmax)
        overmap = np.maximum(0, DC - DTmax - tol) * M
        prec = float((DTmax >= DC - tol)[newink].mean()) if newink.any() else 1.0
        return eb, ea, overmap, prec, float(overmap[M].mean())

    # a gestural mark a few mm off is a near miss, not a mark in the wrong
    # place plus a missing one: judge at a fine and a coarse tolerance
    eb, ea, overmap, prec, over = at(R_TOL)
    ebc, eac, overmap_c, prec_c, over_c = at(R_COARSE)
    Traw, Craw = lum(target, size, 0), lum(child, size, 0)
    hp = lambda X: gauss_blur((X - gauss_blur(X, 2.0)) ** 2, 3.0)
    ink = M & (DT > 8) & (DC > 8)
    tex = float(np.log((hp(Craw) + 1) / (hp(Traw) + 1))[ink].mean()) if ink.sum() > 20 else 0.0
    local = 100 * (eb - ea) / max(eb, 1e-6)
    local_c = 100 * (ebc - eac) / max(ebc, 1e-6)
    net_f = local - 10 * over
    net_c = local_c - 10 * over_c
    w0, h0 = Image.open(target).size
    struct = structure_change(target, parent, child, (768, round(768 * h0 / w0)))
    net_tone = 0.5 * (net_f + net_c)
    net = net_tone + STRUCT_W * struct
    verdict = "worse" if net < 0 else "flawed" if (over > 1.0 or prec < 0.8) else "better"
    out.update(verdict=verdict, net=round(float(net), 1), net_tone=round(float(net_tone), 1), structure=round(float(struct), 1), net_fine=round(float(net_f), 1), net_coarse=round(float(net_c), 1),
               local_error_change=round(float(local), 1), precision=round(prec, 2), precision_coarse=round(prec_c, 2),
               over_dark=round(over, 2), over_dark_coarse=round(over_c, 2), texture=round(tex, 2),
               local_error=[round(float(eb), 2), round(float(ea), 2)])
    # which action did it: assign each changed pixel to the last action whose
    # footprint (wet render after that action) changed it
    if footprints and parent_wet:
        prev = lum(parent_wet, size, 1.0)
        owner = np.full(T.shape, -1)
        still = ("dry", "wait", "tilt", "dryer", "humidity")
        for k, f in enumerate(footprints):
            cur = lum(f, size, 1.0)
            lab = ((labels or [""] * len(footprints))[k] or "").lower()
            # drying and waiting change how wet paint looks but put no ink down
            if not lab.startswith(still):
                owner[disc_max((np.abs(cur - prev) > CHANGE).astype(float), 2) > 0] = k
            prev = cur
        errb, erra = tolerant_abs(P, T, R_TOL), tolerant_abs(C, T, R_TOL)
        errbc, errac = tolerant_abs(P, T, R_COARSE), tolerant_abs(C, T, R_COARSE)
        acts = []
        tot_over = float(overmap.sum()) or 1.0
        for k in range(len(footprints)):
            mk = (owner == k) & M
            if mk.sum() < 3:
                acts.append({"i": k, "label": (labels or [None] * len(footprints))[k], "area": 0.0, "net": 0.0, "over_share": 0.0})
                continue
            lk = 100 * (errb[mk].mean() - erra[mk].mean()) / max(errb[mk].mean(), 1e-6)
            lkc = 100 * (errbc[mk].mean() - errac[mk].mean()) / max(errbc[mk].mean(), 1e-6)
            ok, okc = float(overmap[mk].mean()), float(overmap_c[mk].mean())
            acts.append({"i": k, "label": (labels or [None] * len(footprints))[k], "area": round(float(mk.mean()), 4),
                         "net": round(float(0.5 * ((lk - 10 * ok) + (lkc - 10 * okc))), 1), "over_share": round(float(overmap[mk].sum()) / tot_over, 2)})
        drift = M & (owner < 0)
        out["actions"] = acts
        out["drift_area"] = round(float(drift.mean()), 4)   # changed while no action touched it: wet paint still moving
        # name a culprit only when the batch as a whole is flawed or worse and
        # one action clearly did it (not merely the biggest share of a little)
        bad = [a for a in acts if a["area"] > 0 and (a["net"] < 0 or (a["over_share"] >= 0.35 and over > 0.5))]
        if bad and verdict != "better":
            w = max(bad, key=lambda a: (a["over_share"], -a["net"]))
            out["culprit"] = w["i"]
    return out


# ------------------------------------------------------------ judge (opaque paint)
# Gouache can go lighter as well as darker and change hue, so the judge works
# on colour difference (CIE76 ΔE on lightly blurred L*a*b*): where the batch
# changed the sheet, did the colour come closer to the target's (each pixel
# forgiven ~1.6 mm, and ~4.8 mm, of misregistration)? precision: the share of
# repainted pixels that came closer. Structure is the same term as for pencil.
def lab_img(path, size, blur):
    return gauss_blur(rgb_to_lab(load_rgb(path, size)), blur)


def tolerant_dE(A, T, r):
    """min over q within r of ΔE(A(p), T(q))"""
    best = np.sqrt(((A - T) ** 2).sum(-1))
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r and (dx or dy):
                Ts = np.roll(np.roll(T, dy, 0), dx, 1)
                best = np.minimum(best, np.sqrt(((A - Ts) ** 2).sum(-1)))
    return best


def judge_colour(target, parent, child, parent_wet=None, footprints=None, labels=None):
    size = work_size(target)
    T, P, C = lab_img(target, size, 1.0), lab_img(parent, size, 1.0), lab_img(child, size, 1.0)
    chg = np.sqrt(((C - P) ** 2).sum(-1))
    M = disc_max((chg > 3.0).astype(float), 3) > 0
    out = {"area": round(float(M.mean()), 4)}
    if M.sum() < 5:
        out.update(verdict="no change", net=0.0)
        return out
    E = {}
    for r in (R_TOL, R_COARSE):
        E[r] = (tolerant_dE(P, T, r), tolerant_dE(C, T, r))
    eb, ea = E[R_TOL][0][M].mean(), E[R_TOL][1][M].mean()
    ebc, eac = E[R_COARSE][0][M].mean(), E[R_COARSE][1][M].mean()
    local = 100 * (eb - ea) / max(eb, 1e-6)
    local_c = 100 * (ebc - eac) / max(ebc, 1e-6)
    painted = M & (chg > 3.0)
    closer = (E[R_TOL][1] < E[R_TOL][0] - 0.5)
    prec = float(closer[painted].mean()) if painted.any() else 1.0
    worse_px = (E[R_TOL][1] > E[R_TOL][0] + 3) & painted
    w0, h0 = Image.open(target).size
    struct = structure_change(target, parent, child, (768, round(768 * h0 / w0)))
    net_tone = 0.5 * (local + local_c)
    net = net_tone + STRUCT_W * struct
    verdict = "worse" if net < 0 else "flawed" if prec < 0.6 else "better"
    out.update(verdict=verdict, net=round(float(net), 1), net_tone=round(float(net_tone), 1), structure=round(float(struct), 1),
               net_fine=round(float(local), 1), net_coarse=round(float(local_c), 1), local_error_change=round(float(local), 1),
               precision=round(prec, 2), over_dark=round(float(worse_px.mean() / max(M.mean(), 1e-6)), 2), texture=0.0,
               local_error=[round(float(eb), 2), round(float(ea), 2)])
    if footprints and parent_wet:
        prev = lab_img(parent_wet, size, 1.0)
        owner = np.full(T.shape[:2], -1)
        still = ("dry", "wait", "tilt", "dryer", "humidity")
        for k, f in enumerate(footprints):
            cur = lab_img(f, size, 1.0)
            lab = ((labels or [""] * len(footprints))[k] or "").lower()
            if not lab.startswith(still):
                owner[disc_max((np.sqrt(((cur - prev) ** 2).sum(-1)) > 3.0).astype(float), 2) > 0] = k
            prev = cur
        acts = []
        for k in range(len(footprints)):
            mk = (owner == k) & M
            if mk.sum() < 3:
                acts.append({"i": k, "label": (labels or [None] * len(footprints))[k], "area": 0.0, "net": 0.0, "over_share": 0.0})
                continue
            lk = 100 * (E[R_TOL][0][mk].mean() - E[R_TOL][1][mk].mean()) / max(E[R_TOL][0][mk].mean(), 1e-6)
            lkc = 100 * (E[R_COARSE][0][mk].mean() - E[R_COARSE][1][mk].mean()) / max(E[R_COARSE][0][mk].mean(), 1e-6)
            acts.append({"i": k, "label": (labels or [None] * len(footprints))[k], "area": round(float(mk.mean()), 4),
                         "net": round(float(0.5 * (lk + lkc)), 1), "over_share": round(float((worse_px & mk).sum() / max(worse_px.sum(), 1)), 2)})
        out["actions"] = acts
        bad = [a for a in acts if a["area"] > 0 and a["net"] < 0]
        if bad and verdict != "better":
            out["culprit"] = min(bad, key=lambda a: a["net"] * a["area"])["i"]
    return out


def cmd_judge(a):
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    labels = json.loads(a.labels) if a.labels else None
    if a.opaque:
        print(json.dumps(judge_colour(a.target, a.parent, a.child, a.parent_wet, a.footprints, labels)))
        return
    print(json.dumps(judge(a.target, a.parent, a.child, paper, a.parent_wet, a.footprints, labels)))


# ------------------------------------------------------------ measure
def measure_marks(render, cells, sheet_mm, paper=None):
    """Measure test marks on a dried scrap sheet. Each cell gives the path's
    axis (start, end), a search box and a kind; returns where the mark
    starts/ends relative to the path (mm, positive = inside the path), its
    width at the middle (mm), its core L*, and for blades the fraction of the
    path the mark covers."""
    im = load_rgb(render)
    H, W = im.shape[:2]
    L = gauss_blur(rgb_to_lab(im), 0.8)[..., 0]
    if paper is not None:
        paperL = float(rgb_to_lab(np.array(paper, dtype=np.float64)[None, None])[0, 0, 0])
    else:
        paperL = float(np.percentile(L, 90))
    mmpx = sheet_mm[0] / W
    out = []
    for c in cells:
        x0, y0, x1, y1 = c["box"]
        X0, Y0, X1, Y1 = int(max(0, x0) * W), int(max(0, y0) * H), int(min(1, x1) * W), int(min(1, y1) * H)
        box = L[Y0:Y1, X0:X1]
        D = np.clip(paperL - box, 0, None)
        r = dict(c)
        r.pop("box", None)
        if c.get("area"):
            r.update(found=True, L=round(float(np.median(box)), 1))
            out.append(r)
            continue
        d95 = float(np.percentile(D, 99.5)) if D.size else 0
        if d95 < 2.5:
            r.update(found=False)
            out.append(r)
            continue
        m = D > max(2.0, 0.3 * d95)
        (ax, ay), (bx, by) = c["axis"]
        A = np.array([ax * W - X0, ay * H - Y0])
        B = np.array([bx * W - X0, by * H - Y0])
        L_ab = float(np.hypot(*(B - A))) or 1.0
        u = (B - A) / L_ab
        n = np.array([-u[1], u[0]])
        # keep only ink connected to this mark's own axis (neighbouring test
        # strokes can reach into the box): label components on a coarse grid
        step = 2
        small = m[::step, ::step]
        lab, nlab = label_components(small)
        gy, gx = np.mgrid[0:small.shape[0], 0:small.shape[1]] * step
        rel = np.stack([gx - A[0], gy - A[1]], -1)
        tt, ss = rel @ u, rel @ n
        near = (np.abs(ss) < 3.0 / mmpx + 4) & (tt > 0.2 * L_ab) & (tt < 0.8 * L_ab)
        keep = set(np.unique(lab[near & (lab > 0)]).tolist())
        if not keep:
            keep = set(np.unique(lab[(np.abs(ss) < 8.0 / mmpx) & (tt > -0.2 * L_ab) & (tt < 1.2 * L_ab) & (lab > 0)]).tolist())
        if not keep:
            r.update(found=False)
            out.append(r)
            continue
        ok = np.isin(lab, list(keep))
        m = np.zeros_like(m)
        m[::step, ::step] = ok
        m = disc_max(m.astype(float), 1) > 0
        m &= D > max(2.0, 0.3 * d95)
        ys, xs = np.nonzero(m)
        P = np.stack([xs, ys], 1).astype(np.float64) - A
        t = P @ u
        sN = P @ n
        t0, t1 = np.percentile(t, 0.5), np.percentile(t, 99.5)
        mid = (t > t0 + 0.3 * (t1 - t0)) & (t < t0 + 0.7 * (t1 - t0))
        wid = float(np.percentile(sN[mid], 97) - np.percentile(sN[mid], 3)) if mid.sum() > 5 else 0.0
        core = D[ys, xs] > 0.5 * d95
        Lc = float(np.median(box[ys[core & mid], xs[core & mid]])) if (core & mid).sum() > 3 else float(np.median(box[ys, xs]))
        r.update(found=True, start_mm=round(float(t0 * mmpx), 2), end_mm=round(float((L_ab - t1) * mmpx), 2),
                 width_mm=round(wid * mmpx, 2), L=round(Lc, 1))
        if c["kind"] == "blade":
            bins = np.linspace(t0, t1, 13)
            wmax, wpos = 0.0, 0.5
            for i in range(12):
                sel = (t >= bins[i]) & (t < bins[i + 1])
                if sel.sum() > 5:
                    w_ = float(np.percentile(sN[sel], 97) - np.percentile(sN[sel], 3))
                    if w_ > wmax:
                        wmax, wpos = w_, (i + 0.5) / 12
            r.update(a=round(float(t0 / L_ab), 3), b=round(float(t1 / L_ab), 3), width_mm=round(wmax * mmpx, 2), belly=round(wpos, 2))
        out.append(r)
    return out


def cmd_measure(a):
    cells = json.load(open(a.cells))
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    sheet = [float(v) for v in a.sheet.split(",")]
    print(json.dumps(measure_marks(a.render, cells, sheet, paper)))


# ------------------------------------------------------------ trace
def trace_strokes(target, box, darker_than, min_len_mm, sheet_mm, paper=None, max_strokes=30):
    """Find elongated marks in a box of the target and describe each as a
    library stroke: centreline (sheet fractions), width (mm) and value (L*).
    Marks are connected pieces darker than `darker_than`; each is sliced
    along its principal axis to get the centre and width at every step."""
    im = load_rgb(target)
    H, W = im.shape[:2]
    L = gauss_blur(rgb_to_lab(im), 1.0)[..., 0]
    x0, y0, x1, y1 = box
    X0, Y0, X1, Y1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    sub = L[Y0:Y1, X0:X1]
    mmpx = sheet_mm[0] / W
    step = 2
    mask = (sub < darker_than)[::step, ::step]
    lab, n = label_components(mask)
    out = []
    for j in range(1, n + 1):
        ys, xs = np.nonzero(lab == j)
        if len(xs) < 12:
            continue
        P = np.stack([xs, ys], 1).astype(np.float64) * step
        c = P.mean(0)
        u = np.linalg.svd(P - c, full_matrices=False)[2][0]
        nrm = np.array([-u[1], u[0]])
        t, sN = (P - c) @ u, (P - c) @ nrm
        length = (t.max() - t.min()) * mmpx
        if length < min_len_mm:
            continue
        k = max(3, min(9, int(length / 8)))
        edges = np.linspace(t.min(), t.max(), k + 1)
        path, widths, vals = [], [], []
        for i in range(k):
            sel = (t >= edges[i]) & (t <= edges[i + 1])
            if sel.sum() < 3:
                continue
            tc, sc = t[sel].mean(), np.median(sN[sel])
            q = c + tc * u + sc * nrm
            path.append([round(float((q[0] + X0) / W), 4), round(float((q[1] + Y0) / H), 4)])
            widths.append(float((np.percentile(sN[sel], 95) - np.percentile(sN[sel], 5)) * mmpx))
            px = (P[sel] / 1).astype(int)
            vals.append(float(np.median(sub[np.clip(px[:, 1], 0, sub.shape[0] - 1), np.clip(px[:, 0], 0, sub.shape[1] - 1)])))
        if len(path) < 2:
            continue
        # which end is thin: leaves and blades taper to a point
        taper = [round(min(1, widths[0] / max(widths)), 2), round(min(1, widths[-1] / max(widths)), 2)]
        out.append({"length_mm": round(length, 1), "width": round(float(np.percentile(widths, 75)), 1), "value": round(float(np.median(vals)), 0),
                    "taper": taper, "path": path, "area_px": int(len(xs) * step * step)})
    out.sort(key=lambda r: -r["area_px"])
    return out[:max_strokes]


def cmd_trace(a):
    box = [float(v) for v in a.box.split(",")]
    sheet = [float(v) for v in a.sheet.split(",")]
    r = trace_strokes(a.target, box, a.darker_than, a.min_len, sheet)
    if a.overlay:
        im = Image.open(a.target).convert("RGB")
        W, H = im.size
        d = ImageDraw.Draw(im)
        f = font(max(12, W // 90))
        for i, s_ in enumerate(r):
            pts = [(p[0] * W, p[1] * H) for p in s_["path"]]
            d.line(pts, fill=(230, 40, 40), width=3)
            d.text((pts[0][0] + 4, pts[0][1] + 2), f"t{i}", fill=(200, 20, 20), font=f)
        x0, y0, x1, y1 = box
        im.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))).save(a.overlay)
    print(json.dumps(r))


# ------------------------------------------------------------ thumbs / sheets
def cmd_thumb(a):
    im = Image.open(a.img).convert("RGB")
    im.resize((a.width, round(a.width * im.height / im.width)), Image.LANCZOS).save(a.out)
    print(a.out)


def cmd_sheet(a):
    """Crops of several renders (and the target) around one box, tiled with labels."""
    x0, y0, x1, y1 = [float(v) for v in a.crop.split(",")]
    items = [("target", a.target)] + [tuple(reversed(it.split("=", 1))) for it in a.items]
    tiles = []
    for label, path in items:
        im = Image.open(path).convert("RGB")
        W, H = im.size
        c = im.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)))
        s = 300 / max(1, c.height)
        c = c.resize((max(1, int(c.width * s)), 300), Image.LANCZOS)
        tiles.append((label, c))
    tw = max(t.width for _, t in tiles)
    cols = min(len(tiles), max(1, 1800 // (tw + 10)))
    rows = (len(tiles) + cols - 1) // cols
    out = Image.new("RGB", (cols * (tw + 10), rows * 340), (246, 244, 240))
    d = ImageDraw.Draw(out)
    f = font(15)
    for i, (label, t) in enumerate(tiles):
        x, y = (i % cols) * (tw + 10), (i // cols) * 340
        out.paste(t, (x, y + 34))
        for k, line in enumerate(wrap_text(d, label, f, tw)[:2]):
            d.text((x + 2, y + 2 + k * 16), line, fill=(20, 20, 20), font=f)
    out.save(a.out)
    print(a.out)


def wrap_text(d, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = t
    return lines + ([cur] if cur else [])


# ------------------------------------------------------------ palette
def kmeans(X, k, iters=25, seed=1):
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), size=1)]
    for _ in range(1, k):  # k-means++ init
        d = ((X[:, None, :] - C[None]) ** 2).sum(-1).min(1)
        C = np.vstack([C, X[rng.choice(len(X), p=d / d.sum())]])
    for _ in range(iters):
        lab = ((X[:, None, :] - C[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            if (lab == j).any():
                C[j] = X[lab == j].mean(0)
    return C, lab


def lab_to_rgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    inv = lambda t: np.where(t ** 3 > 216 / 24389, t ** 3, (116 * t - 16) / (24389 / 27))
    xyz = np.stack([inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883], -1)
    M = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    return linear_to_srgb(xyz @ M.T)


def cmd_palette(a):
    size = work_size(a.target)
    lab = gauss_blur(rgb_to_lab(load_rgb(a.target, size)), 1.0)
    h, w, _ = lab.shape
    X = lab.reshape(-1, 3)
    C, labels = kmeans(X, a.k)
    labels = labels.reshape(h, w)
    ys, xs = np.mgrid[0:h, 0:w]
    out = []
    for j in np.argsort(-C[:, 0]):
        m = labels == j
        if not m.any():
            continue
        L, A, B = C[j]
        out.append({
            "rgb": [int(v) for v in np.clip(lab_to_rgb(C[j][None])[0], 0, 255).round()],
            "L": round(float(L), 1), "chroma": round(float(math.hypot(A, B)), 1),
            "hue_deg": round(float(math.degrees(math.atan2(B, A)) % 360), 0),
            "coverage": round(float(m.mean()), 3),
            "centre": [round(float(xs[m].mean() / w), 3), round(float(ys[m].mean() / h), 3)],
            "bbox": [round(float(xs[m].min() / w), 3), round(float(ys[m].min() / h), 3), round(float((xs[m].max() + 1) / w), 3), round(float((ys[m].max() + 1) / h), 3)],
        })
    if a.out:
        sw = Image.new("RGB", (80 * len(out), 110), (255, 255, 255))
        d = ImageDraw.Draw(sw)
        f = font(12)
        for i, c in enumerate(out):
            d.rectangle([i * 80, 0, i * 80 + 79, 79], fill=tuple(c["rgb"]))
            d.text((i * 80 + 3, 82), f"L{c['L']:.0f} {c['coverage'] * 100:.0f}%", fill=(0, 0, 0), font=f)
            d.text((i * 80 + 3, 96), f"C{c['chroma']:.0f} h{c['hue_deg']:.0f}", fill=(0, 0, 0), font=f)
        sw.save(a.out)
    print(json.dumps(out))


# ------------------------------------------------------------ regions
def label_components(mask):
    """4-connected components; returns label image (0 = background) and count."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    n = 0
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not lab[y, x]:
                n += 1
                stack = [(y, x)]
                lab[y, x] = n
                while stack:
                    cy, cx = stack.pop()
                    for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = n
                            stack.append((ny, nx))
    return lab, n


def trace(mask):
    """Outer boundary of a single 8-connected blob as pixel-corner points (Moore tracing)."""
    h, w = mask.shape
    pad = np.zeros((h + 2, w + 2), bool)
    pad[1:-1, 1:-1] = mask
    ys, xs = np.nonzero(pad)
    i = np.lexsort((xs, ys))[0]
    start = (int(ys[i]), int(xs[i]))
    nbr = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    pts = [start]
    cur, back = start, 6  # came from the left
    for _ in range(4 * (h + 2) * (w + 2)):
        found = False
        for k in range(8):
            d = (back + 1 + k) % 8
            ny, nx = cur[0] + nbr[d][0], cur[1] + nbr[d][1]
            if pad[ny, nx]:
                back = (d + 4) % 8
                cur = (ny, nx)
                found = True
                break
        if not found or cur == start:
            break
        pts.append(cur)
    return [(x - 1 + 0.5, y - 1 + 0.5) for y, x in pts]


def simplify(pts, tol):
    if len(pts) < 4:
        return pts
    P = np.array(pts)
    keep = np.zeros(len(P), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        s, e = stack.pop()
        if e <= s + 1:
            continue
        a, b = P[s], P[e]
        ab = b - a
        n = np.hypot(*ab) or 1e-9
        d = np.abs(ab[0] * (P[s + 1:e, 1] - a[1]) - ab[1] * (P[s + 1:e, 0] - a[0])) / n
        i = int(d.argmax())
        if d[i] > tol:
            keep[s + 1 + i] = True
            stack += [(s, s + 1 + i), (s + 1 + i, e)]
    return [tuple(p) for p in P[keep]]


def rings_of(mask, w, h, min_px, tol):
    lab, n = label_components(mask)
    out = []
    for j in range(1, n + 1):
        blob = lab == j
        area = int(blob.sum())
        if area < min_px:
            continue
        outer = simplify(trace(blob), tol)
        # holes: background pieces enclosed by this blob
        inv = ~blob
        hl, hn = label_components(inv)
        border = set(np.unique(np.concatenate([hl[0], hl[-1], hl[:, 0], hl[:, -1]])))
        holes = []
        for k in range(1, hn + 1):
            if k in border:
                continue
            hb = hl == k
            if hb.sum() >= min_px:
                holes.append(simplify(trace(hb), tol))
        norm = lambda ring: [[round(x / w, 4), round(y / h, 4)] for x, y in ring]
        ys, xs = np.nonzero(blob)
        out.append({"area": round(area / (w * h), 4), "bbox": [round(xs.min() / w, 3), round(ys.min() / h, 3), round((xs.max() + 1) / w, 3), round((ys.max() + 1) / h, 3)],
                    "rings": [norm(outer)] + [norm(hh) for hh in holes]})
    out.sort(key=lambda r: -r["area"])
    return out


def cmd_regions(a):
    RW = a.res
    w0, h0 = Image.open(a.target).size
    RH = round(RW * h0 / w0)
    lab = gauss_blur(rgb_to_lab(load_rgb(a.target, (RW, RH))), a.blur)
    L = lab[..., 0]
    min_px = max(4, int(a.min_area * RW * RH))
    regions, overlay_masks = [], []
    if a.by == "value":
        paperL = float(np.percentile(L, 97))
        lo = float(np.percentile(L, 1))
        # cumulative bands, light to dark: band k = everything at least this dark
        th = [paperL - 4 - (paperL - 4 - lo) * i / a.levels for i in range(a.levels)]
        for i, t in enumerate(th):
            m = L < t
            rs = rings_of(m, RW, RH, min_px, a.tol)
            for j, r in enumerate(rs[: a.max_per]):
                r.update({"id": f"v{i}.{j}", "band": i, "L_below": round(t, 1), "mean_L": round(float(L[m].mean()), 1) if m.any() else None})
                regions.append(r)
            overlay_masks.append((f"v{i}", m))
    else:
        X = lab.reshape(-1, 3)
        C, labels = kmeans(X, a.k)
        labels = labels.reshape(RH, RW)
        order = np.argsort(-C[:, 0])
        for rank, j in enumerate(order):
            m = labels == j
            rs = rings_of(m, RW, RH, min_px, a.tol)
            rgb = [int(v) for v in np.clip(lab_to_rgb(C[j][None])[0], 0, 255).round()]
            for q, r in enumerate(rs[: a.max_per]):
                r.update({"id": f"c{rank}.{q}", "cluster": rank, "rgb": rgb, "L": round(float(C[j][0]), 1)})
                regions.append(r)
            overlay_masks.append((f"c{rank}", m))
    json.dump({"by": a.by, "regions": regions}, open(a.out, "w"), indent=1)
    if a.overlay:
        base = Image.open(a.target).convert("RGB")
        W, H = base.size
        im = draw_grid(base, 0.1)
        d = ImageDraw.Draw(im)
        f = font(max(12, W // 80))
        cols = [(220, 40, 40), (30, 120, 220), (30, 160, 60), (200, 120, 0), (150, 50, 200), (0, 160, 160), (120, 120, 120), (220, 0, 140)]
        for r in regions:
            col = cols[(r.get("band", r.get("cluster", 0))) % len(cols)]
            for k, ring in enumerate(r["rings"]):
                d.line([(x * W, y * H) for x, y in ring] + [(ring[0][0] * W, ring[0][1] * H)], fill=col, width=2 if k == 0 else 1)
            bx = r["bbox"]
            d.text((bx[0] * W + 3, bx[1] * H + 2), r["id"], fill=col, font=f)
        im.save(a.overlay)
    print(json.dumps({"regions": len(regions), "out": a.out, "ids": [(r["id"], r["area"]) for r in regions][:40]}))



# ------------------------------------------------------------ codebook
PROF = 24  # samples along a mark (codebook.mjs P)


def lum_of(path, blur=0.8):
    im = load_rgb(path)
    return gauss_blur(rgb_to_lab(im), blur)[..., 0]


def paper_L(L, paper):
    if paper is not None:
        return float(rgb_to_lab(np.array(paper, dtype=np.float64)[None, None])[0, 0, 0])
    return float(np.percentile(L, 90))


def grow_from(seed, allowed, step=2, limit=400):
    """The part of `allowed` connected to `seed` (gaps up to `step` px bridged)."""
    cur = seed & allowed
    if not cur.any():
        return cur
    for _ in range(limit):
        nxt = disc_max(cur.astype(float), step) > 0
        nxt &= allowed
        if (nxt == cur).all():
            break
        cur = nxt
    return cur


def mark_descriptor(Lbox, paperL, mmpx, ox, oy, thr=4.0, path=None):
    """Measure one codebook mark painted along +x in its box. Lbox is the L*
    crop; (ox, oy) the gesture origin in crop pixels; path the gesture's
    own path (mm, its frame) so that only ink connected to it counts.
    Returns the descriptor (all mm, in the gesture's own frame) or None when
    nothing marked."""
    D = np.clip(paperL - Lbox, 0, None)
    m = D > thr
    if m.sum() < 6:
        return None
    if path:
        seed = np.zeros_like(m)
        Hh, Ww = m.shape
        pts = np.array(path, dtype=np.float64)
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]) if len(pts) > 1 else [(pts[0], pts[0])]:
            for t in np.linspace(0, 1, 12):
                px = int(round(ox + (x0 + (x1 - x0) * t) / mmpx)); py_ = int(round(oy + (y0 + (y1 - y0) * t) / mmpx))
                r = max(2, int(round(2.0 / mmpx)))
                seed[max(0, py_ - r):min(Hh, py_ + r + 1), max(0, px - r):min(Ww, px + r + 1)] = True
        own = grow_from(seed, m, step=2)
        if own.sum() >= 6:
            m = own
    Dm = np.where(m, D, 0)
    colmass = Dm.sum(0)
    tot = colmass.sum()
    if tot <= 0:
        return None
    cum = np.cumsum(colmass) / tot
    xs0 = int(np.searchsorted(cum, 0.005)); xs1 = int(np.searchsorted(cum, 0.995))
    xs1 = max(xs1, xs0 + 1)
    H = Lbox.shape[0]
    yy = np.arange(H)[:, None]
    w, v, c, cov = [], [], [], []
    edges = np.linspace(xs0, xs1 + 1, PROF + 1)
    for k in range(PROF):
        a, b = int(math.floor(edges[k])), max(int(math.floor(edges[k])) + 1, int(math.ceil(edges[k + 1])))
        mm = m[:, a:b]; LL = Lbox[:, a:b]
        n = mm.sum()
        if n == 0:
            w.append(0.0); v.append(round(paperL, 1)); c.append(c[-1] if c else 0.0); cov.append(0.0)
            continue
        # the mark's body: darker than halfway between the paper and its core
        # (the same rule profile() applies to a target against its own
        # surroundings, so widths compare)
        core = float(np.percentile(LL[mm], 5))
        half = paperL - 0.5 * (paperL - core)
        body = mm & (LL < half)
        if body.sum() == 0:
            body = mm
        ys = np.nonzero(body)[0]
        lo, hi = np.percentile(ys, 4), np.percentile(ys, 96)
        env = max(1.0, hi - lo + 1)
        w.append(float(env) * mmpx)
        cov.append(float(min(1.0, body.sum() / (env * body.shape[1]))))
        v.append(float(LL[body].mean()))
        wgt = np.where(body, paperL - LL, 0)
        cy = float((wgt * yy).sum() / max(1e-6, wgt.sum()))
        c.append((cy - oy) * mmpx)
    # widths across the local direction of the mark, not straight down
    cx = np.array(c)
    step = (xs1 - xs0) * mmpx / PROF
    slope = np.gradient(cx, step) if PROF > 2 else np.zeros(PROF)
    w = [float(wi * math.cos(math.atan(si))) for wi, si in zip(w, slope)]
    seg = np.hypot(step, np.diff(cx)) if PROF > 1 else np.array([0])
    arclen = float(seg.sum() + step)
    ink = m.sum() * mmpx * mmpx
    return {
        "len": round(arclen, 2),
        "x0": round((xs0 - ox) * mmpx, 2), "x1": round((xs1 - ox) * mmpx, 2),
        "w": [round(x, 2) for x in w], "v": [round(x, 1) for x in v], "c": [round(x, 2) for x in c],
        "cov": round(float(np.mean([x for x in cov if x > 0] or [0])), 3),
        "area": round(float(ink), 1),
        "vmin": round(float(np.percentile(Lbox[m], 5)), 1),
        "vmean": round(float(Lbox[m].mean()), 1),
    }


def cmd_cbmeasure(a):
    """Descriptors for every gesture on a dried codebook sheet (see
    codebook.mjs). cells: [{id, x, y (gesture origin, mm), box: [x0, y0, x1,
    y1] (its own frame, mm)}]."""
    L = lum_of(a.render)
    sheet = [float(v) for v in a.sheet.split(",")]
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    pL = paper_L(L, paper)
    H, W = L.shape
    mmpx = sheet[0] / W
    out = []
    for cell in json.load(open(a.cells)):
        bx0, by0, bx1, by1 = cell["box"]
        X0 = int(round((cell["x"] + bx0) / mmpx)); X1 = int(round((cell["x"] + bx1) / mmpx))
        Y0 = int(round((cell["y"] + by0) / mmpx)); Y1 = int(round((cell["y"] + by1) / mmpx))
        X0c, Y0c, X1c, Y1c = max(0, X0), max(0, Y0), min(W, X1), min(H, Y1)
        if X1c - X0c < 3 or Y1c - Y0c < 3:
            out.append({"id": cell["id"], "d": None}); continue
        crop = L[Y0c:Y1c, X0c:X1c]
        ox = cell["x"] / mmpx - X0c; oy = cell["y"] / mmpx - Y0c
        out.append({"id": cell["id"], "d": mark_descriptor(crop, pL, mmpx, ox, oy, path=cell.get("path"))})
    if a.atlas:
        # ink darkness at 0.4 mm/px (paper = 0), to preview and blend marks
        f = max(1, int(round(0.4 / mmpx)))
        Hs, Ws = H // f, W // f
        small = L[:Hs * f, :Ws * f].reshape(Hs, f, Ws, f).mean((1, 3))
        D8 = np.clip((pL - small - 2.0) * 2.8, 0, 255).astype(np.uint8)
        Image.fromarray(D8, "L").save(a.atlas, optimize=True)
    print(json.dumps(out))


def L2Y(L):
    return ((L + 16) / 116) ** 3 if L > 8 else L / 903.3


def Y2L(Y):
    return 116 * Y ** (1 / 3) - 16 if Y > 0.008856 else 903.3 * Y


def profile_along(L, pL, mmpx, pts, n, search, thr, near_mm):
    """Width, value, centre and coverage of the mark along pts (mm) at n
    samples (see cmd_profile)."""
    H, W = L.shape
    seg = np.hypot(*np.diff(pts, axis=0).T)
    S = np.concatenate([[0], np.cumsum(seg)])
    tot = S[-1] or 1.0
    ss = (np.arange(n) + 0.5) / n * tot
    P_ = np.stack([np.interp(ss, S, pts[:, 0]), np.interp(ss, S, pts[:, 1])], 1)
    tang = np.gradient(P_, axis=0)
    tang /= np.maximum(1e-9, np.hypot(*tang.T))[:, None]
    nrm = np.stack([-tang[:, 1], tang[:, 0]], 1)
    ts = np.arange(-search, search + 1e-6, mmpx)
    near_px = max(2, int(round(near_mm / mmpx)))
    w, v, c, cov = [], [], [], []
    for k in range(n):
        q = P_[k][None] + ts[:, None] * nrm[k][None]
        xi = np.clip((q[:, 0] / mmpx).astype(int), 0, W - 1); yi = np.clip((q[:, 1] / mmpx).astype(int), 0, H - 1)
        line = L[yi, xi]
        mid = len(ts) // 2
        # the mark's core: the darkest point within `near` mm of the path;
        # its background: the lighter surroundings across the path (a wash
        # behind the mark is background, not mark); the mark is the run
        # darker than halfway between them
        seg_ = line[max(0, mid - near_px):mid + near_px + 1]
        ci = int(np.argmin(seg_)) + max(0, mid - near_px)
        core = float(line[ci])
        bg = min(pL, float(np.percentile(line, 85)))
        if bg - core < thr:
            w.append(0.0); v.append(round(pL, 1)); c.append(P_[k].tolist()); cov.append(0.0); continue
        half = bg - 0.5 * (bg - core)
        ink = line < half
        lo = hi = ci
        while lo > 0 and (ink[lo - 1] or (lo > 1 and ink[lo - 2])): lo -= 1
        while hi < len(ts) - 1 and (ink[hi + 1] or (hi < len(ts) - 2 and ink[hi + 2])): hi += 1
        run = slice(lo, hi + 1)
        w.append(float((hi - lo + 1) * mmpx))
        cov.append(float(ink[run].mean()))
        # the mark as it would be on bare paper: layered ink multiplies
        # reflectance, so a mark over a wash is the wash times the mark
        Lm = float(line[run][ink[run]].mean())
        v.append(Y2L(L2Y(pL) * L2Y(Lm) / max(1e-6, L2Y(bg))))
        cen = (ts[lo] + ts[hi]) / 2
        c.append((P_[k] + cen * nrm[k]).tolist())
    return w, v, c, cov


def cmd_profile(a):
    """Width, value and centreline of a target mark along a rough path.
    Samples PROF points along the path; at each, walks across it to find the
    run of ink around the path (within --search mm) and records its width,
    mean L* and centre, so an eyeballed path snaps onto the mark. With
    --extend, the path is first carried on past both ends (up to that many
    mm) as long as the mark continues, so a path traced only along a mark's
    dark core reaches its pale tips."""
    L = lum_of(a.target, 1.0)
    sheet = [float(v) for v in a.sheet.split(",")]
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    pL = paper_L(L, paper)
    mmpx = sheet[0] / L.shape[1]
    pts = np.array(json.loads(a.path), dtype=np.float64) * np.array([sheet[0], sheet[1]])
    if a.extend > 0 and len(pts) >= 2:
        # carry the path on along its end directions, sample finely, and cut
        # it where the mark runs out
        d0 = pts[0] - pts[1]; d0 /= max(1e-9, np.hypot(*d0))
        d1 = pts[-1] - pts[-2]; d1 /= max(1e-9, np.hypot(*d1))
        ext = np.vstack([pts[0] + d0 * a.extend, pts, pts[-1] + d1 * a.extend])
        seg = np.hypot(*np.diff(ext, axis=0).T)
        n = max(PROF, int(np.sum(seg) / 1.0))
        w, v, c, cov = profile_along(L, pL, mmpx, ext, n, a.search, a.thr, a.near)
        on = [i for i, x in enumerate(w) if x > 0.3]
        if on:
            # the stretch around the original path that stays on the mark
            tot = seg.sum(); s0 = a.extend / tot * n; s1 = (tot - a.extend) / tot * n
            i0, i1 = int(s0), min(n - 1, int(s1))
            # carry on while the mark does: not into nothing, and not into a
            # wider mark it runs into
            def walk(i, step):
                # a tip narrows and pales; a jump wider or darker is
                # another mark
                lw, lv = w[i], v[i]
                ok = lambda j: 0.3 < w[j] <= 1.35 * lw + 0.4 and v[j] >= lv - 10
                gap = max(1, int(round(5.0 / (np.sum(seg) / n))))   # hop a crossing mark up to ~5 mm wide
                while 0 <= i + step < n:
                    j = i + step
                    if not ok(j):
                        nxt = [j + step * g for g in range(1, gap + 1) if 0 <= j + step * g < n and ok(j + step * g)]
                        if not nxt:
                            break
                        j = nxt[0]
                    lw = 0.7 * lw + 0.3 * w[j]; lv = 0.7 * lv + 0.3 * v[j]
                    i = j
                return i
            # a path can also overrun the mark (a lift that stops marking
            # before the path ends): trim what is off it first
            while i0 < i1 and w[i0] <= 0.3: i0 += 1
            while i1 > i0 and w[i1] <= 0.3: i1 -= 1
            if w[i0] > 0.3: i0 = walk(i0, -1)
            if w[i1] > 0.3: i1 = walk(i1, 1)
            cp = np.array(c[i0:i1 + 1])
            if len(cp) >= 2:
                pts = cp
    w, v, c, cov = profile_along(L, pL, mmpx, pts, PROF, a.search, a.thr, a.near)
    # a mark crossing this one reads as a spike: a 3-point median removes it
    def med3(x):
        x = list(x)
        return [x[0]] + [sorted(x[i - 1:i + 2])[1] for i in range(1, len(x) - 1)] + [x[-1]] if len(x) > 2 else x
    w, v = med3(w), med3(v)
    cpts = np.array(c)
    if PROF >= 5:
        sm = cpts.copy()
        sm[1:-1] = 0.25 * cpts[:-2] + 0.5 * cpts[1:-1] + 0.25 * cpts[2:]
        cpts = sm
    L2 = float(np.hypot(*np.diff(cpts, axis=0).T).sum() * PROF / (PROF - 1))
    print(json.dumps({"len": round(L2, 2), "w": [round(x, 2) for x in w], "v": [round(x, 1) for x in v],
                      "pts": [[round(x, 2), round(y, 2)] for x, y in cpts], "cov": round(float(np.mean([x for x in cov if x > 0] or [0])), 3)}))



# ------------------------------------------------------------ decomposition
def L2Yv(L):
    return np.where(L > 8, ((L + 16) / 116) ** 3, L / 903.3)


def Y2Lv(Y):
    return np.where(Y > 0.008856, 116 * np.cbrt(Y) - 16, 903.3 * Y)


def cmd_residual(a):
    """The ink the target still needs over what is painted, drawn as if on
    bare paper: layered ink multiplies reflectance, so what is missing is the
    target's reflectance divided by the painting's. Where the painting is
    already as dark or darker, nothing is needed (paper)."""
    T = load_rgb(a.target)
    H, W = T.shape[:2]
    Pm = load_rgb(a.paint, (W, H))
    Lt = gauss_blur(rgb_to_lab(T), 1.0)[..., 0]
    Lp = gauss_blur(rgb_to_lab(Pm), 1.0)[..., 0]
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    pL = paper_L(Lt, paper)
    Y0 = float(L2Yv(np.array(pL)))
    Yn = np.clip(Y0 * L2Yv(np.minimum(Lt, pL)) / np.maximum(L2Yv(np.minimum(Lp, pL)), 1e-4), 0, Y0)
    g = np.clip(linear_to_srgb(Yn), 0, 255).astype(np.uint8)
    Image.fromarray(np.stack([g, g, g], -1)).save(a.out)
    Ln = Y2Lv(Yn)
    box = [float(v) for v in a.box.split(",")] if a.box else [0, 0, 1, 1]
    sub = Ln[int(box[1] * H):int(box[3] * H), int(box[0] * W):int(box[2] * W)]
    need = np.clip(pL - sub, 0, None)
    print(json.dumps({"out": a.out, "paperL": round(pL, 1), "missing": round(float(need.mean()), 2), "missing_dark": round(float((need > 30).mean()), 4)}))


def thin(m):
    """Zhang-Suen thinning of a boolean mask to a one-pixel skeleton."""
    m = m.astype(np.uint8).copy()
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(m, 1)
            p2, p3, p4, p5 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:]
            p6, p7, p8, p9 = P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]
            B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            A = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.uint8) for i in range(8))
            if step == 0:
                c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (m == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any():
                m[rm] = 0
                changed = True
        if not changed:
            return m.astype(bool)


def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0], float), np.array(pts[-1], float)
    d = b - a
    n = np.hypot(*d) or 1.0
    P = np.array(pts, float)
    dist = np.abs((P[:, 0] - a[0]) * d[1] - (P[:, 1] - a[1]) * d[0]) / n
    i = int(np.argmax(dist))
    if dist[i] > tol:
        return rdp(pts[:i + 1], tol)[:-1] + rdp(pts[i:], tol)
    return [pts[0], pts[-1]]


NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def skeleton_strokes(sk, spur_px, join_deg=40.0, dir_px=12):
    """Split a skeleton into strokes: branches between junctions and ends,
    short spurs pruned, and at each junction the branches that carry on
    most nearly straight through it joined into one stroke (a leaf crossing
    a stalk stays a leaf and a stalk). Returns polylines of (y, x) pixels."""
    S = set(zip(*[v.tolist() for v in np.nonzero(sk)]))
    nb = lambda p: [(p[0] + dy, p[1] + dx) for dy, dx in NB8 if (p[0] + dy, p[1] + dx) in S]
    J = {p for p in S if len(nb(p)) >= 3}
    cl, centres = {}, []
    for p in J:
        if p in cl:
            continue
        cid = len(centres)
        stack, members = [p], [p]
        cl[p] = cid
        while stack:
            q = stack.pop()
            for r in nb(q):
                if r in J and r not in cl:
                    cl[r] = cid; stack.append(r); members.append(r)
        centres.append(tuple(np.mean(members, 0)))
    visited = set()
    branches = []

    def walk(first, start):
        path = [first]
        visited.add(first)
        cur = first
        while True:
            js = [r for r in nb(cur) if r in J and (cl[r] != start or len(path) > 2)]
            if js:
                return path, cl[js[0]]
            nxt = [r for r in nb(cur) if r not in visited and r not in J]
            if not nxt:
                return path, None
            nxt.sort(key=lambda r: abs(r[0] - cur[0]) + abs(r[1] - cur[1]))   # 4-neighbours first
            cur = nxt[0]
            visited.add(cur)
            path.append(cur)

    for p in J:
        for q in nb(p):
            if q not in J and q not in visited:
                path, end = walk(q, cl[p])
                branches.append({"px": path, "a": cl[p], "b": end})
    for p in S:
        if p not in J and p not in visited and len(nb(p)) <= 1:
            path, end = walk(p, None)
            branches.append({"px": path, "a": None, "b": end})
    for p in S:
        if p not in J and p not in visited:
            path, end = walk(p, None)
            branches.append({"px": path, "a": None, "b": end})
    # prune spurs: short branches hanging off a junction
    keep = []
    for br in branches:
        free = (br["a"] is None) != (br["b"] is None)
        if free and len(br["px"]) < spur_px:
            continue
        keep.append(br)
    branches = keep
    for br in branches:
        pts = [tuple(float(v) for v in q) for q in br["px"]]
        if br["a"] is not None:
            pts = [centres[br["a"]]] + pts
        if br["b"] is not None:
            pts = pts + [centres[br["b"]]]
        br["pts"] = pts
    # join through junctions
    ends = {}
    for i, br in enumerate(branches):
        for e in ("a", "b"):
            if br[e] is not None:
                ends.setdefault(br[e], []).append((i, e))
    partner = {}
    for c, inc in ends.items():
        dirs = []
        for i, e in inc:
            pts = branches[i]["pts"] if e == "a" else branches[i]["pts"][::-1]
            far = np.array(pts[min(len(pts) - 1, dir_px)]); near = np.array(pts[0])
            d = far - near
            dirs.append(d / (np.hypot(*d) or 1.0))
        if len(inc) == 2:
            pairs = [(0.0, 0, 1)]
        else:
            pairs = []
            for x in range(len(inc)):
                for y in range(x + 1, len(inc)):
                    dev = math.degrees(math.acos(float(np.clip(-np.dot(dirs[x], dirs[y]), -1, 1))))
                    if dev < join_deg:
                        pairs.append((dev, x, y))
            pairs.sort()
        used = set()
        for dev, x, y in pairs:
            if x in used or y in used:
                continue
            used.update((x, y))
            partner[inc[x]] = inc[y]; partner[inc[y]] = inc[x]
    done, strokes = set(), []
    for i in range(len(branches)):
        if i in done:
            continue
        # walk to one end of this chain, then along it
        cur, ent = i, "a"
        seen = {i}
        while (cur, ent) in partner:
            j, e = partner[(cur, ent)]
            if j in seen:
                break
            seen.add(j)
            cur, ent = j, ("b" if e == "a" else "a")
        chain, pts = [], []
        cur_e = "b" if ent == "a" else "a"   # leave through the far end
        cur_i = cur
        # start at the free end `ent` of `cur`
        start_i, start_free = cur, ent
        ci, free = start_i, start_free
        while True:
            done.add(ci)
            seg = branches[ci]["pts"] if free == "a" else branches[ci]["pts"][::-1]
            pts += seg if not pts else seg[1:]
            out = "b" if free == "a" else "a"
            nxt = partner.get((ci, out))
            if not nxt or nxt[0] in done:
                break
            ci, free = nxt[0], nxt[1]
        strokes.append(pts)
    return strokes


def cmd_strokes(a):
    """Strokes in a box of an image (e.g. a residual): marks darker than
    --darker-than, thinned to a skeleton, split at junctions and rejoined
    through crossings; each a centreline (sheet fractions), longest first."""
    L = lum_of(a.img, 1.0)
    H, W = L.shape
    sheet = [float(v) for v in a.sheet.split(",")]
    mmpx = sheet[0] / W
    x0, y0, x1, y1 = [float(v) for v in a.box.split(",")]
    X0, Y0, X1, Y1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    m = L[Y0:Y1, X0:X1] < a.darker_than
    # tidy: fill hair gaps, drop specks
    r = max(1, int(round(0.3 / mmpx)))
    m = disc_max(m.astype(float), r) > 0
    m = ~(disc_max((~m).astype(float), r) > 0)
    m = ~(disc_max((~m).astype(float), 1) > 0) if a.open else m
    sk = thin(m)
    polys = skeleton_strokes(sk, spur_px=int(a.spur / mmpx), join_deg=a.join)
    out = []
    for pts in polys:
        if len(pts) < 2:
            continue
        P = np.array(pts)
        length = float(np.hypot(*np.diff(P, axis=0).T).sum() * mmpx)
        if length < a.min_len:
            continue
        simp = rdp([tuple(q) for q in pts], 0.4 / mmpx)
        path = [[round((q[1] + X0) / W, 4), round((q[0] + Y0) / H, 4)] for q in simp]
        out.append({"length_mm": round(length, 1), "path": path})
    out.sort(key=lambda s_: -s_["length_mm"])
    if a.overlay:
        im = Image.open(a.img).convert("RGB")
        d = ImageDraw.Draw(im)
        for i, s_ in enumerate(out):
            d.line([(p[0] * W, p[1] * H) for p in s_["path"]], fill=(230, 40, 40), width=2)
            d.text((s_["path"][0][0] * W + 3, s_["path"][0][1] * H), str(i), fill=(20, 20, 200))
        im.crop((X0, Y0, X1, Y1)).save(a.overlay)
    print(json.dumps(out[:a.max]))


def cmd_masses(a):
    """Large pale areas of an image (e.g. a residual) as outlines, for mist
    or washes: what is still missing at the scale of a wash (blurred past
    single strokes), areas above --min-area mm²."""
    sheet = [float(v) for v in a.sheet.split(",")]
    RW = 300
    w0, h0 = Image.open(a.img).size
    RH = round(RW * h0 / w0)
    L = gauss_blur(rgb_to_lab(load_rgb(a.img, (RW, RH))), a.blur)[..., 0]
    paper = [float(v) for v in a.paper.split(",")] if a.paper else None
    pL = paper_L(L, paper)
    x0, y0, x1, y1 = [float(v) for v in a.box.split(",")]
    m = np.zeros_like(L, bool)
    X0, Y0, X1, Y1 = int(x0 * RW), int(y0 * RH), int(x1 * RW), int(y1 * RH)
    m[Y0:Y1, X0:X1] = L[Y0:Y1, X0:X1] < pL - a.depth
    mm2 = (sheet[0] / RW) * (sheet[1] / RH)
    rs = rings_of(m, RW, RH, max(4, int(a.min_area / mm2)), 1.0)
    out = []
    for r in rs:
        # the typical value inside (bare-paper equivalent in a residual)
        ring = r["rings"][0]
        im = Image.new("L", (RW, RH), 0)
        ImageDraw.Draw(im).polygon([(x * RW, y * RH) for x, y in ring], fill=255)
        inside = (np.asarray(im) > 0) & m
        if inside.sum() < 4:
            continue
        v = float(np.median(L[inside]))
        out.append({"rings": r["rings"], "bbox": r["bbox"], "area_mm2": round(float(inside.sum() * mm2), 0), "value": round(v, 1)})
    print(json.dumps(out[:a.max]))


def cmd_zoom(a):
    """A close look at one region: target | painting | difference, cropped to
    the box and enlarged, with a fine grid labelled in sheet coordinates
    (top/left) and in the box's own 0..1 frame (bottom/right), and the
    region's own numbers."""
    box = [float(v) for v in a.box.split(",")]
    x0, y0, x1, y1 = box
    T = Image.open(a.target).convert("RGB")
    W, H = T.size
    R = Image.open(a.render).convert("RGB").resize((W, H), Image.LANCZOS)
    cb = (int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))
    t, r = T.crop(cb), R.crop(cb)
    # a wide box is stacked (target over painting over difference) so each
    # panel can be large; a tall or square one sits side by side
    stack = t.width > 1.4 * t.height
    width = a.width or (1500 if stack else 760)
    scale = width / max(1, t.width)
    size = (width, max(1, int(t.height * scale)))
    t, r = t.resize(size, Image.LANCZOS), r.resize(size, Image.LANCZOS)
    Lt = rgb_to_lab(np.asarray(t).astype(np.float64))[..., 0]
    Lr = rgb_to_lab(np.asarray(r).astype(np.float64))[..., 0]
    d = Lr - Lt
    # difference: red where the painting is too dark, blue where too light
    diff = np.full(d.shape + (3,), 245.0)
    dark = np.clip(-d / 30, 0, 1)[..., None]; light = np.clip(d / 30, 0, 1)[..., None]
    diff = diff * (1 - dark) + np.array([210, 40, 40]) * dark
    diff = diff * (1 - light) + np.array([40, 90, 220]) * light
    diff = Image.fromarray(diff.astype(np.uint8))
    step = a.grid or (lambda w: next(s_ for s_ in [0.002, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1] if w / s_ <= 14))(x1 - x0)
    pad = 30
    if stack:
        out = Image.new("RGB", (size[0] + 2 * pad, 3 * (size[1] + pad + 24) + pad), (250, 250, 250))
    else:
        out = Image.new("RGB", (3 * size[0] + 4 * pad, size[1] + 2 * pad + 24), (250, 250, 250))
    dr = ImageDraw.Draw(out)
    f = font(13 if stack else 12)
    for k, (im, lab) in enumerate([(t, "target"), (r, "painting"), (diff, "red = too dark, blue = too light")]):
        ox = pad if stack else pad + k * (size[0] + pad)
        oy = k * (size[1] + pad + 24) if stack else 0
        out.paste(im, (ox, oy + pad + 24))
        dr.text((ox, oy + 6), lab, fill=(20, 20, 20), font=font(15))
        # label only every few lines when they are close together
        every_x = max(1, math.ceil(42 / max(1e-6, step / (x1 - x0) * size[0])))
        every_y = max(1, math.ceil(16 / max(1e-6, step / (y1 - y0) * size[1])))
        g = math.ceil(x0 / step) * step
        gi = 0
        while g <= x1 + 1e-9:
            px = ox + (g - x0) / (x1 - x0) * size[0]
            dr.line([(px, oy + pad + 24), (px, oy + pad + 24 + size[1])], fill=(90, 130, 255) if k < 2 else (200, 200, 200), width=1)
            gi += 1
            if (k == 0 or k == 1) and (gi - 1) % every_x == 0:
                dr.text((px + 2, oy + pad + 26), f"{g:.3f}".rstrip("0").rstrip("."), fill=(0, 0, 190), font=f)
                dr.text((px + 2, oy + pad + 12 + size[1]), f"u{(g - x0) / (x1 - x0):.2f}", fill=(120, 0, 120), font=f)
            g += step
        g = math.ceil(y0 / step) * step
        gi = 0
        while g <= y1 + 1e-9:
            py = oy + pad + 24 + (g - y0) / (y1 - y0) * size[1]
            dr.line([(ox, py), (ox + size[0], py)], fill=(90, 130, 255) if k < 2 else (200, 200, 200), width=1)
            gi += 1
            if (k == 0 or k == 1) and (gi - 1) % every_y == 0:
                dr.text((ox + 2, py + 1), f"{g:.3f}".rstrip("0").rstrip("."), fill=(0, 0, 190), font=f)
                dr.text((ox + size[0] - 34, py + 1), f"v{(g - y0) / (y1 - y0):.2f}", fill=(120, 0, 120), font=f)
            g += step
    out.save(a.out)
    err = float(np.abs(d).mean())
    print(json.dumps({"out": a.out, "error": round(err, 2), "too_dark": round(float(np.clip(-d - 4, 0, None).mean()), 2), "too_light": round(float(np.clip(d - 4, 0, None).mean()), 2), "grid": step}))


def cmd_overlay(a):
    """Where gestures will go, before any graphite goes down: their
    trajectories drawn over the target and the painting in a box (a dot every
    50 ms: close dots = slow, far apart = fast; a ring at each start)."""
    x0, y0, x1, y1 = [float(v) for v in a.box.split(",")]
    T = Image.open(a.target).convert("RGB")
    W, H = T.size
    R = Image.open(a.render).convert("RGB").resize((W, H), Image.LANCZOS)
    cb = (int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))
    scale = a.width / max(1, cb[2] - cb[0])
    size = (a.width, max(1, int((cb[3] - cb[1]) * scale)))
    panels = [T.crop(cb).resize(size, Image.LANCZOS), R.crop(cb).resize(size, Image.LANCZOS)]
    strokes = json.load(open(a.strokes))
    cols = [(220, 40, 40), (30, 110, 230), (20, 150, 60), (200, 110, 0), (150, 40, 200), (0, 150, 150), (230, 0, 130), (90, 90, 90)]
    out = Image.new("RGB", (2 * size[0] + 30, size[1] + 40), (250, 250, 250))
    d = ImageDraw.Draw(out)
    f = font(12)
    for k, im in enumerate(panels):
        ox = 10 + k * (size[0] + 10)
        im = im.copy()
        di = ImageDraw.Draw(im)
        for s_ in strokes:
            c = cols[s_["g"] % len(cols)]
            P = [((x - x0) / (x1 - x0) * size[0], (y - y0) / (y1 - y0) * size[1]) for x, y in s_["pts"]]
            if len(P) > 1:
                di.line(P, fill=c, width=2)
            last = -1e9
            for (px, py), t in zip(P, s_["ts"]):
                if t - last >= 50:
                    di.ellipse([px - 2, py - 2, px + 2, py + 2], fill=c); last = t
            if P:
                di.ellipse([P[0][0] - 5, P[0][1] - 5, P[0][0] + 5, P[0][1] + 5], outline=c, width=2)
                if s_.get("first"):
                    di.text((P[0][0] + 6, P[0][1] - 14), str(s_["g"]), fill=c, font=f)
        out.paste(im, (ox, 30))
        d.text((ox, 8), "target" if k == 0 else "painting (head)", fill=(20, 20, 20), font=font(14))
    out.save(a.out)
    print(json.dumps({"out": a.out}))


def cmd_sample(a):
    """L* of the target and of the drawing so far along strokes (each point
    averaged over about a millimetre), for pressure that follows the tone."""
    T = Image.open(a.target).convert("RGB")
    W, H = T.size
    R = Image.open(a.render).convert("RGB").resize((W, H), Image.LANCZOS)
    def Lmap(im):
        L = rgb_to_lab(np.asarray(im).astype(np.float64))[..., 0]
        r = max(1, int(round(a.radius * W / 304.8)))
        c = np.cumsum(np.cumsum(np.pad(L, ((r + 1, r), (r + 1, r)), mode="edge"), 0), 1)
        k = 2 * r + 1
        return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)
    Lt, Lr = Lmap(T), Lmap(R)
    strokes = json.load(open(a.strokes))
    out = []
    for pts in strokes:
        row = []
        for x, y in pts:
            i = min(H - 1, max(0, int(y * H))); j = min(W - 1, max(0, int(x * W)))
            row.append([round(float(Lt[i, j]), 1), round(float(Lr[i, j]), 1)])
        out.append(row)
    print(json.dumps(out))

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare"); p.add_argument("ref"); p.add_argument("blank"); p.add_argument("out"); p.add_argument("--fit", choices=["crop", "pad"], default="crop"); p.add_argument("--no-balance", dest="no_balance", action="store_true")
    p = sub.add_parser("grid"); p.add_argument("img"); p.add_argument("out")
    p = sub.add_parser("score"); p.add_argument("target"); p.add_argument("render"); p.add_argument("--eval"); p.add_argument("--prev"); p.add_argument("--title"); p.add_argument("--paper", help="r,g,b of bare simulated paper"); p.add_argument("--opaque", action="store_true")
    p = sub.add_parser("palette"); p.add_argument("target"); p.add_argument("--k", type=int, default=8); p.add_argument("--out")
    p = sub.add_parser("trace"); p.add_argument("target"); p.add_argument("--box", default="0,0,1,1"); p.add_argument("--darker-than", dest="darker_than", type=float, default=75)
    p.add_argument("--min-len", dest="min_len", type=float, default=12); p.add_argument("--sheet", default="304.8,228.6"); p.add_argument("--overlay")
    p = sub.add_parser("thumb"); p.add_argument("img"); p.add_argument("out"); p.add_argument("--width", type=int, default=384)
    p = sub.add_parser("sheet"); p.add_argument("--target", required=True); p.add_argument("--crop", required=True); p.add_argument("--out", required=True); p.add_argument("items", nargs="*")
    p = sub.add_parser("measure"); p.add_argument("render"); p.add_argument("cells"); p.add_argument("--paper"); p.add_argument("--sheet", default="304.8,228.6")
    p = sub.add_parser("cbmeasure"); p.add_argument("render"); p.add_argument("cells"); p.add_argument("--paper"); p.add_argument("--sheet", default="304.8,228.6"); p.add_argument("--atlas")
    p = sub.add_parser("profile"); p.add_argument("target"); p.add_argument("--path", required=True); p.add_argument("--paper"); p.add_argument("--sheet", default="304.8,228.6")
    p.add_argument("--search", type=float, default=12.0); p.add_argument("--thr", type=float, default=6.0); p.add_argument("--near", type=float, default=3.0); p.add_argument("--extend", type=float, default=0.0)
    p = sub.add_parser("residual"); p.add_argument("target"); p.add_argument("paint"); p.add_argument("out"); p.add_argument("--paper"); p.add_argument("--box")
    p = sub.add_parser("strokes"); p.add_argument("img"); p.add_argument("--box", default="0,0,1,1"); p.add_argument("--darker-than", dest="darker_than", type=float, default=60)
    p.add_argument("--min-len", dest="min_len", type=float, default=6); p.add_argument("--spur", type=float, default=2.5); p.add_argument("--join", type=float, default=40)
    p.add_argument("--open", action="store_true"); p.add_argument("--max", type=int, default=60); p.add_argument("--sheet", default="304.8,228.6"); p.add_argument("--overlay")
    p = sub.add_parser("masses"); p.add_argument("img"); p.add_argument("--box", default="0,0,1,1"); p.add_argument("--depth", type=float, default=5); p.add_argument("--blur", type=float, default=2.0)
    p.add_argument("--min-area", dest="min_area", type=float, default=300); p.add_argument("--max", type=int, default=12); p.add_argument("--paper"); p.add_argument("--sheet", default="304.8,228.6")
    p = sub.add_parser("zoom"); p.add_argument("target"); p.add_argument("render"); p.add_argument("out"); p.add_argument("--box", required=True); p.add_argument("--width", type=int); p.add_argument("--grid", type=float)
    p = sub.add_parser("sample"); p.add_argument("target"); p.add_argument("render"); p.add_argument("strokes"); p.add_argument("--radius", type=float, default=0.6)
    p = sub.add_parser("overlay"); p.add_argument("target"); p.add_argument("render"); p.add_argument("strokes"); p.add_argument("out"); p.add_argument("--box", required=True); p.add_argument("--width", type=int, default=760)
    p = sub.add_parser("judge"); p.add_argument("target"); p.add_argument("parent"); p.add_argument("child"); p.add_argument("--paper"); p.add_argument("--opaque", action="store_true")
    p.add_argument("--parent-wet", dest="parent_wet"); p.add_argument("--footprints", nargs="*"); p.add_argument("--labels")
    p = sub.add_parser("regions"); p.add_argument("target"); p.add_argument("--by", choices=["value", "color"], default="value")
    p.add_argument("--levels", type=int, default=4); p.add_argument("--k", type=int, default=6); p.add_argument("--res", type=int, default=160)
    p.add_argument("--blur", type=float, default=1.2); p.add_argument("--min-area", type=float, default=0.002); p.add_argument("--tol", type=float, default=0.8)
    p.add_argument("--max-per", type=int, default=12); p.add_argument("--out", required=True); p.add_argument("--overlay")
    a = ap.parse_args()
    global OPAQUE
    OPAQUE = bool(getattr(a, "opaque", False))
    {"prepare": cmd_prepare, "grid": cmd_grid, "score": cmd_score, "palette": cmd_palette, "regions": cmd_regions, "judge": cmd_judge, "measure": cmd_measure, "trace": cmd_trace, "thumb": cmd_thumb, "sheet": cmd_sheet, "cbmeasure": cmd_cbmeasure, "profile": cmd_profile, "residual": cmd_residual, "strokes": cmd_strokes, "masses": cmd_masses, "zoom": cmd_zoom, "overlay": cmd_overlay, "sample": cmd_sample}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
