#!/usr/bin/env python3
"""Build the painting video for a run: the recorded time-lapse of every
batch (including the ones that were later rolled back), a card at each
checkpoint with its dry preview, score and verdict, a banner at each
rollback, and the final painting beside the reference.

  video.py paintings/<run> [--out file.mp4] [--fps 30] [--speed 1] [--hold 1]

--speed 2 keeps every 2nd painting frame; --hold scales how long cards stay.
Needs Pillow and numpy; encodes with mp4enc (Swift/AVFoundation, compiled
on first use) and falls back to WebM with Playwright's ffmpeg.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1920, 1080
PX, PY, PW, PH = 40, 64, 1280, 960          # painting box
RX, RW = 1360, 520                          # right panel
BG = (27, 26, 24)
INK = (232, 227, 216)
MUTED = (150, 145, 136)
GREEN = (112, 196, 128)
RED = (232, 96, 84)
AMBER = (226, 180, 90)


def font(size, bold=False):
    # Arial Unicode first: it has the ✓ ✗ ↺ → marks used in the captions
    names = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else []) + [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    return ImageFont.load_default()


F = {k: font(v) for k, v in {"s": 17, "m": 21, "l": 28}.items()}
FB = {k: font(v) for k, v in {"m": 22, "l": 30, "xl": 46}.items()}


def fit(img, w, h):
    return img.convert("RGB").resize((w, h), Image.LANCZOS)


def wrap(d, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if d.textlength(t, font=f) > width and cur:
            lines.append(cur)
            cur = w_
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


class Film:
    def __init__(self, run_dir, a):
        self.dir = run_dir
        self.run = json.load(open(os.path.join(run_dir, "run.json")))
        self.fps = a.fps
        self.speed = max(1, a.speed)
        self.holdk = a.hold
        self.tmp = tempfile.mkdtemp(prefix="ink-video-")
        self.list = []
        self.n = 0
        self.cps = self.run["checkpoints"]
        head = self.run.get("final", {}).get("cp") or self.run["head"]
        kept, c = set(), head
        while c:
            kept.add(c)
            c = self.cps[c]["parent"]
        self.kept = kept
        self.history = []     # (cp, score, kept) in the order they were made
        self.events = []      # recent decisions, newest last
        self.ref = Image.open(os.path.join(run_dir, self.run.get("target") or "blank.png")).convert("RGB")
        self.ref_thumb = fit(self.ref, RW, round(RW * 3 / 4))
        self.cache = {}
        subj = self.run.get("subject") or ""
        paper = {"xuan": "raw xuan", "xuanHalf": "half-sized xuan", "xuanSized": "sized xuan", "hot": "hot-press", "cold": "cold-press", "rough": "rough"}.get(self.run["paper"], self.run["paper"])
        self.title = f"{'Sumi-e ink' if self.run['medium'] == 'ink' else 'Watercolor'} on {paper} — {subj}"

    def img(self, rel):
        p = rel if os.path.isabs(rel) else os.path.join(os.path.dirname(os.path.dirname(self.dir)), rel)
        if not os.path.exists(p):
            p = os.path.join(self.dir, rel)
        if p not in self.cache:
            self.cache[p] = fit(Image.open(p), PW, PH)
        return self.cache[p]

    # ------------------------------------------------------------ frames
    def emit(self, im, hold=1):
        f = os.path.join(self.tmp, f"{self.n:06d}.jpg")
        im.save(f, quality=90)
        self.list.append((f, max(1, int(round(hold)))))
        self.n += 1

    def frame(self, painting, phase, sub="", colour=INK, panel_img=None, panel_caption=None, banner=None, banner_colour=RED, t=None):
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        d.text((PX, 22), self.title, fill=MUTED, font=F["m"])
        im.paste(painting, (PX, PY))
        if banner:
            bh = 64
            ov = Image.new("RGBA", (PW, bh), banner_colour + (225,))
            im.paste(ov, (PX, PY + PH - bh), ov)
            d.text((PX + 20, PY + PH - bh + 15), banner, fill=(255, 255, 255), font=FB["l"])
        # panel: reference (or error map) at the top
        pim = panel_img or self.ref_thumb
        im.paste(pim, (RX, PY))
        y = PY + pim.height + 8
        d.text((RX, y), panel_caption or "reference (gpt-image-2.5-sunburst)", fill=MUTED, font=F["s"])
        y += 40
        d.text((RX, y), phase, fill=colour, font=FB["l"])
        y += 42
        for line in wrap(d, sub, F["m"], RW)[:3]:
            d.text((RX, y), line, fill=INK, font=F["m"])
            y += 28
        if t is not None:
            d.text((RX, y), f"sim time {t:.1f} s", fill=MUTED, font=F["s"])
        self.chart(d, RX, 700, RW, 150)
        y = 880
        for text, col in self.events[-5:]:
            d.text((RX, y), text[:52], fill=col, font=F["s"])
            y += 24
        d.text((PX, H - 44), f"checkpoint every {self.run.get('every', 6)} actions · judge each one dried, where it painted · every rolled-back branch was a lookahead · any checkpoint can be returned to",
               fill=MUTED, font=F["s"])
        return im

    def chart(self, d, x, y, w, h):
        d.text((x, y - 26), "score at each checkpoint (lower is closer)", fill=MUTED, font=F["s"])
        d.rectangle([x, y, x + w, y + h], outline=(70, 67, 62))
        pts = [(c, s, k) for c, s, k in self.history if s is not None]
        base = self.cps["cp-0000"].get("score", {}).get("score")
        vals = [s for _, s, _ in pts] + ([base] if base else [])
        if not vals:
            return
        lo, hi = min(vals), max(vals)
        if hi - lo < 1e-6:
            hi = lo + 1
        n = max(len(pts), 12)
        X = lambda i: x + 12 + (w - 24) * i / (n - 1)
        Y = lambda v: y + 10 + (h - 20) * (1 - (v - lo) / (hi - lo))
        if base:
            d.line([(x + 2, Y(base)), (x + w - 2, Y(base))], fill=(80, 76, 70), width=1)
            d.text((x + w - 90, Y(base) - 20), "blank sheet", fill=(110, 105, 98), font=F["s"])
        # kept path as a line
        kp = [(X(i), Y(s)) for i, (c, s, k) in enumerate(pts) if k]
        if len(kp) > 1:
            d.line(kp, fill=GREEN, width=2)
        for i, (c, s, k) in enumerate(pts):
            r = 5
            d.ellipse([X(i) - r, Y(s) - r, X(i) + r, Y(s) + r], fill=GREEN if k else RED)

    # ------------------------------------------------------------ story
    def build(self):
        run = self.run
        frames = {}
        mf = os.path.join(self.dir, "frames", "manifest.jsonl")
        if os.path.exists(mf):
            for line in open(mf):
                if line.strip():
                    m = json.loads(line)
                    frames.setdefault(m["seg"], []).append(m)
        log = [json.loads(l) for l in open(os.path.join(self.dir, "log.jsonl")) if l.strip()]
        hold = lambda s: s * self.fps * self.holdk

        # title
        big = fit(self.ref, PW, PH)
        self.emit(self.frame(big, "the reference", f"generated with gpt-image-2.5-sunburst in the simulator's own medium; the painter now tries to paint it with the simulated brush, ink and paper"), hold(3))
        blank = self.img(self.cps["cp-0000"]["render"])
        self.emit(self.frame(blank, "blank sheet", "raw xuan on felt", t=0), hold(1))
        cur = blank
        for idx, ev in enumerate(log):
            kind = ev.get("ev")
            if kind == "act":
                cp = ev["cp"]
                c = self.cps.get(cp)
                if not c:
                    continue
                labels = ", ".join(ev.get("labels") or [])
                fr = sorted(frames.get(cp, []), key=lambda m: m["seq"])
                last = None
                for i, m in enumerate(fr):
                    if i % self.speed and i != len(fr) - 1:
                        continue
                    last = fit(Image.open(os.path.join(self.dir, "frames", m["file"])), PW, PH)
                    what = m.get("label") or ""
                    phase = "drying" if what == "dry" else "waiting" if what == "wait" else f"painting {cp}"
                    self.emit(self.frame(last, phase, what if what not in ("dry", "wait") else labels, t=m["t"]))
                if last is not None:
                    cur = last
                # checkpoint card: dried preview, score, verdict
                s = c.get("score") or {}
                dlt = s.get("delta", {})
                kept = cp in self.kept
                nxt = next((e for e in log[idx + 1:] if e.get("ev") in ("act", "back", "checkout", "finish")), None)
                rejected_now = nxt is not None and nxt.get("ev") in ("back", "checkout") and nxt.get("from") == cp
                self.history.append((cp, s.get("score"), kept))
                dry = self.img(c["dry"])
                err = None
                if c.get("eval") and os.path.exists(os.path.join(os.path.dirname(os.path.dirname(self.dir)), c["eval"])):
                    e = Image.open(os.path.join(os.path.dirname(os.path.dirname(self.dir)), c["eval"])).convert("RGB")
                    pw = (e.width - 16) // 3
                    err = fit(e.crop((4 + 2 * (pw + 4), 54, 4 + 2 * (pw + 4) + pw, e.height - 8)), RW, round(RW * 3 / 4))
                ds = dlt.get("score")
                dd = dlt.get("too_dark")
                sub = f"score {s.get('score')} ({ds:+.2f})" if ds is not None else f"score {s.get('score')}"
                if dd is not None:
                    sub += f" · too dark {s.get('too_dark')} ({dd:+.2f})"
                if c.get("note"):
                    sub += f" — {c['note']}"
                j = c.get("judge") or {}
                jv = j.get("verdict")
                if kept:
                    verdict, col = "✓ keep", GREEN
                elif rejected_now:
                    verdict, col = "lookahead: roll back", RED
                else:
                    verdict, col = "kept for now (a lookahead, later)", AMBER
                if jv and jv != "no change":
                    sub = f"judge: {jv} (net {j.get('net')}, over-dark {j.get('over_dark')}, precision {j.get('precision')}) · " + sub
                if c.get("partialOf"):
                    sub = f"kept the first {len(c['actions'])} actions of {c['partialOf']} · " + sub
                for k in range(1, 7):
                    self.emit(self.frame(Image.blend(cur, dry, k / 6), f"checkpoint {cp}", "drying it forward to judge the result", panel_img=err, panel_caption="error map · red too dark · blue too light"))
                self.emit(self.frame(dry, f"{cp}: {verdict}", sub, colour=col, panel_img=err, panel_caption="error map · red too dark · blue too light",
                                     banner=f"{cp} dry preview · {verdict}", banner_colour=(40, 120, 60) if kept else (170, 50, 40) if rejected_now else (150, 110, 40)), hold(2.2))
                self.events.append((f"{'✓' if kept else '✗'} {cp}  {s.get('score')}  {(labels or c.get('note') or '')}", col))
                # back to the wet present
                wet = self.img(c["render"])
                for k in range(1, 5):
                    self.emit(self.frame(Image.blend(dry, wet, k / 4), f"continue from {cp}" if kept else f"{cp} under review", ""))
                cur = wet
            elif kind in ("back", "checkout"):
                frm, to = ev.get("from"), ev.get("to")
                if not frm or not to or to not in self.cps:
                    continue
                # the reason is on the first checkpoint rolled back past (the child of `to`)
                c, first = frm, frm
                while c and self.cps.get(c, {}).get("parent") not in (to, None):
                    c = self.cps[c]["parent"]
                if c and self.cps.get(c, {}).get("parent") == to:
                    first = c
                note = self.cps.get(first, {}).get("note") or self.cps.get(frm, {}).get("note") or ""
                self.emit(self.frame(cur, f"lookahead {frm} → back to {to}", note, colour=RED, banner=f"↺ that was a lookahead: back to {to}", banner_colour=(170, 50, 40)), hold(1.6))
                target = self.img(self.cps[to].get("render") or self.cps[to]["dry"])
                for k in range(1, 13):
                    self.emit(self.frame(Image.blend(cur, target, k / 12), f"restoring {to}", note, colour=AMBER))
                self.emit(self.frame(target, f"restored {to}", "the painting exactly as it was at that checkpoint, still wet where it was wet", colour=AMBER), hold(1))
                self.events.append((f"↺ {frm} → {to}", AMBER))
                cur = target
        # final
        fin = os.path.join(self.dir, "final.png")
        if os.path.exists(fin):
            im = Image.new("RGB", (W, H), BG)
            d = ImageDraw.Draw(im)
            a, b = fit(Image.open(fin), 900, 675), fit(self.ref, 900, 675)
            im.paste(a, (40, 150))
            im.paste(b, (980, 150))
            d.text((40, 40), self.title, fill=INK, font=FB["l"])
            d.text((40, 110), "final painting (simulation)", fill=MUTED, font=F["m"])
            d.text((980, 110), "reference", fill=MUTED, font=F["m"])
            f = run.get("final", {})
            hs = self.cps[f.get("cp", run["head"])].get("score", {})
            base = self.cps["cp-0000"].get("score", {}).get("score")
            lines = [f"{f.get('actions', '?')} actions on the kept path · {f.get('checkpoints', '?')} checkpoints made · {f.get('rolledBack', '?')} abandoned by rolling back",
                     f"score {hs.get('score')} (blank sheet {base}) · error {hs.get('error')} · too dark {hs.get('too_dark')} · too light {hs.get('too_light')}"]
            for i, l in enumerate(lines):
                d.text((40, 860 + i * 36), l, fill=INK, font=F["l"])
            self.emit(im, hold(5))

    def encode(self, out):
        lst = os.path.join(self.tmp, "list.txt")
        with open(lst, "w") as f:
            for p, n in self.list:
                f.write(f"{p}\t{n}\n")
        root = os.path.dirname(os.path.dirname(self.dir))
        enc = os.path.join(root, "paintings", ".ink", "bin", "mp4enc")
        src = os.path.join(HERE, "mp4enc.swift")
        if (not os.path.exists(enc) or os.path.getmtime(enc) < os.path.getmtime(src)) and shutil.which("swiftc"):
            os.makedirs(os.path.dirname(enc), exist_ok=True)
            print("compiling mp4enc...", file=sys.stderr)
            subprocess.run(["swiftc", "-O", src, "-o", enc], check=True)
        if os.path.exists(enc):
            subprocess.run([enc, lst, out, str(self.fps)], check=True)
            return out
        ff = sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-mac")) + glob.glob(os.path.expanduser("~/.cache/ms-playwright/ffmpeg-*/ffmpeg-linux")))
        if not ff:
            sys.exit("no encoder: needs swiftc (macOS) or Playwright's ffmpeg")
        out = os.path.splitext(out)[0] + ".webm"
        cat = os.path.join(self.tmp, "all.mjpeg")
        with open(cat, "wb") as o:
            for p, n in self.list:
                data = open(p, "rb").read()
                for _ in range(n):
                    o.write(data)
        subprocess.run([ff[-1], "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(self.fps), "-i", "file:" + cat,
                        "-c:v", "vp8", "-b:v", "8M", "-y", "file:" + out], check=True)
        print(out)
        return out


def timelapse(run_dir, frames_dir, out, seconds, fps, bitrate=None, manifest="manifest.jsonl", camera_moves=False, total=None, rt_every=None, rt_hold=None, head_s=1.2, tail_s=None, thin_lags=False):
    """Just the canvas: keep the frames where the ink visibly changes (so
    drying and waiting pass in a blink), pace them to about `seconds` as hard
    steps (no crossfades), and hold on the blank sheet and the finished painting.
    With `total`, the video is exactly that many seconds (to match a song):
    the painting is paced into it and the last hold takes up the rest."""
    import numpy as np
    man = [json.loads(l) for l in open(os.path.join(frames_dir, manifest)) if l.strip()]
    if not camera_moves:
        # a painting time-lapse just cuts to the new framing: no camera moves
        man = [m for m in man if not m.get("cam")]
    same_view = lambda i, j: (man[i].get("view") or [0, 0, 1, 1]) == (man[j].get("view") or [0, 0, 1, 1])
    small = lambda f: np.asarray(Image.open(os.path.join(frames_dir, f)).convert("L").resize((160, 120), Image.BILINEAR), dtype=np.float32)
    quiet = ("pre-wet", "dry", "wait", "let ", "settle")
    keep, last, gap = [0], small(man[0]["file"]), 0
    for i in range(1, len(man)):
        lab = (man[i].get("label") or "").lower()
        gap += 1
        if man[i].get("painting") and total:
            ok = True                # the brush at work: every frame (it moves in each)
        elif any(q in lab for q in quiet) or not lab:
            ok = gap >= 8 and not total   # water and drying: a glimpse now and then
        else:
            cur = small(man[i]["file"])
            ok = float(np.abs(cur - last).mean()) > 0.008 or gap >= 6   # ink going down: every visible step
        if ok:
            keep.append(i)
            last, gap = small(man[i]["file"]), 0
    if keep[-1] != len(man) - 1:
        keep.append(len(man) - 1)
    # camera moves (a zooming time-lapse) are kept whole, one output frame
    # each, so they stay smooth; the painting is paced into the rest
    cams = [i for i, m in enumerate(man) if m.get("cam")]
    camset = set(cams)
    # frames recorded in real time (ink timelapse --realtime: a signature)
    # play one output frame each, outside the pacing; or, with rt_every N,
    # stop-motion like the rest: every Nth, paced as the painting is
    rts = [i for i, m in enumerate(man) if m.get("rt") and i not in camset]
    if rt_every and rt_every > 1:
        drop = set(rts) - set(rts[::rt_every]) - {rts[-1]} if rts else set()
        keep = [k for k in keep if k not in drop]
        rts = [i for i in rts if i not in drop]
    rtfix = set()
    if rt_hold:
        # writing (title, signature) as stop-motion on a fixed beat: every
        # frame kept, each held rt_hold output frames, outside the pacing
        rtfix = set(rts)
        cams += [i for i in rts for _ in range(rt_hold)]
        camset |= rtfix
    elif not rt_every:
        camset |= set(rts)
        cams += rts
    keep = [k for k in keep if k not in camset]
    # frames to hold a while (the finished title card): a fixed time each,
    # outside the pacing
    # (hold: seconds; nframes: output frames, e.g. 1 for a signature played
    # smooth in real time)
    holds = {i: (round(m["hold"] * fps) if m.get("hold") else int(m["nframes"])) for i, m in enumerate(man) if m.get("hold") or m.get("nframes")}
    hold_frames = sum(holds.values())
    keep = [k for k in keep if k not in holds]
    n_total = round(total * fps) if total else None
    head, blend_end = round(fps * head_s), 0
    tail = round(fps * (tail_s if tail_s is not None else (3.5 if not total else 4.0)))
    # pace: about `seconds` long (or what `total` leaves), at least ~2 output frames per step
    target = (n_total - head - tail - blend_end if total else int(seconds * fps)) - len(cams) - hold_frames
    target = max(2, target)
    # the lag before a zoom-in (the whole sheet while that close-up's brush
    # is already at work) is kept whole when frames are thinned
    zoomed_cps = {m.get("cp") for m in man if m.get("view")}
    lag = set() if thin_lags else {i for i in keep if not man[i].get("view") and man[i].get("cp") in zoomed_cps}
    if len(keep) * 2 > target:
        rest = [k for k in keep if k not in lag]
        n_rest = max(2, target // 2 - len(lag))
        idx = np.linspace(0, len(rest) - 1, min(len(rest), n_rest)).round().astype(int)
        keep = sorted(set(rest[i] for i in idx.tolist()) | lag)
    per = target / max(1, len(keep) - 1)     # output frames per kept step, fractional
    keep = sorted(set(keep) | camset | set(holds))
    tmp = tempfile.mkdtemp(prefix="ink-timelapse-")
    lst = []
    n = 0
    def emit(im, frames):
        nonlocal n
        f = os.path.join(tmp, f"{n:06d}.jpg")
        im.save(f, quality=92)
        lst.append((f, max(1, int(frames))))
        n += 1
    first = Image.open(os.path.join(frames_dir, man[0]["file"])).convert("RGB")
    emit(first, head)
    prev = first; prev_k = 0
    acc = 0.0                                # spread the fractional holds exactly
    for k in keep[1:]:
        im = Image.open(os.path.join(frames_dir, man[k]["file"])).convert("RGB")
        if k in holds:       # held a fixed time
            emit(im, holds[k]); prev = im; prev_k = k; continue
        if k in rtfix:       # writing, on a fixed beat
            emit(im, rt_hold); prev = im; prev_k = k; continue
        if k in camset:      # the camera moving, or real time: every frame, once
            emit(im, 1); prev = im; prev_k = k; continue
        h = int(acc + per) - int(acc); acc += per
        if h < 1: continue
        emit(im, h)          # hard steps, no crossfades (a blend ghosts the brush)
        prev = im; prev_k = k
    final = os.path.join(run_dir, "final.png")
    if man[-1].get("final"):   # the replay's own last frame: the finished painting, brush away
        end = Image.open(os.path.join(frames_dir, man[-1]["file"])).convert("RGB")
    else:
        end = Image.open(final).convert("RGB").resize(prev.size, Image.LANCZOS) if os.path.exists(final) else prev
    used = sum(k_ for _, k_ in lst)
    emit(end, n_total - used if total else tail)
    if total and n_total - used < fps * 2:
        print(f"warning: only {(n_total - used) / fps:.1f} s left for the final hold", file=sys.stderr)
    lp = os.path.join(tmp, "list.txt")
    with open(lp, "w") as f:
        for p_, k_ in lst:
            f.write(f"{p_}\t{k_}\n")
    root = os.path.dirname(os.path.dirname(run_dir))
    enc = os.path.join(root, "paintings", ".ink", "bin", "mp4enc")
    src = os.path.join(HERE, "mp4enc.swift")
    if (not os.path.exists(enc) or os.path.getmtime(enc) < os.path.getmtime(src)) and shutil.which("swiftc"):
        subprocess.run(["swiftc", "-O", src, "-o", enc], check=True)
    subprocess.run([enc, lp, out, str(fps)] + ([str(int(bitrate))] if bitrate else []), check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    frames_out = sum(k_ for _, k_ in lst)
    print(f"time-lapse: {len(man)} recorded frames, {len(keep)} kept, {frames_out} frames = {frames_out / fps:.3f} s → {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--out")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--speed", type=int, default=1)
    ap.add_argument("--hold", type=float, default=1.0)
    ap.add_argument("--keep", help="also keep the composed frames in this directory")
    ap.add_argument("--bitrate", type=float, help="video bitrate, bits/s (default 12e6)")
    ap.add_argument("--timelapse", help="frames directory from `ink timelapse`: make the canvas-only time-lapse")
    ap.add_argument("--seconds", type=float, default=36)
    ap.add_argument("--manifest", default="manifest.jsonl", help="which frame manifest in the frames directory")
    ap.add_argument("--camera-moves", action="store_true", help="keep animated camera moves (default: cuts)")
    ap.add_argument("--total", type=float, help="exactly this many seconds long (to match a song); the final hold takes up the rest")
    ap.add_argument("--rt-every", type=int, help="real-time frames (a signature) as stop-motion: every Nth, paced like the painting")
    ap.add_argument("--head", type=float, default=1.2, help="seconds on the first frame")
    ap.add_argument("--tail", type=float, help="seconds on the finished painting (with --total: at least this; it takes up the rest)")
    ap.add_argument("--thin-lags", action="store_true", help="thin the zoom-in lags with everything else (short versions)")
    ap.add_argument("--rt-hold", type=int, help="real-time frames (writing) each held this many output frames (2 = on twos), outside the pacing")
    a = ap.parse_args()
    run_dir = os.path.abspath(a.run_dir)
    if a.timelapse:
        timelapse(run_dir, a.timelapse, a.out or os.path.join(run_dir, os.path.basename(run_dir) + "-timelapse.mp4"), a.seconds, a.fps, a.bitrate, a.manifest, a.camera_moves, a.total, a.rt_every, a.rt_hold, a.head, a.tail, a.thin_lags)
        return
    film = Film(run_dir, a)
    film.build()
    out = a.out or os.path.join(run_dir, os.path.basename(run_dir) + ".mp4")
    film.encode(out)
    if a.keep:
        shutil.rmtree(a.keep, ignore_errors=True)
        shutil.copytree(film.tmp, a.keep)
    shutil.rmtree(film.tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
