// Stroke codebook: thousands of brush gestures painted once each, measured,
// and reused anywhere on the sheet.
//
// A gesture is described in its own frame: the brush travels along +x from
// (0, 0) to (L, 0) mm, bowing toward -y by bow·L at the middle (and S-bending
// by sbend·L), with a pressure profile along the way. The simulation's brush
// and paper have no preferred direction, so the mark a gesture leaves is the
// same at any angle and position, and a mirrored gesture leaves the mirrored
// mark: each gesture is painted once, horizontally, and placed anywhere by a
// rotation, a translation and an optional mirror (not by painting it at every
// angle). Direction of travel is not symmetric (a brush lands and lifts
// differently), so a mark and its reverse are different entries.
//
// Matching works on the measured mark, not on the gesture: its length, and
// its width, darkness and centreline sampled at P points along it. A target
// mark (from the reference, or described) is compared with every entry, the
// nearest are aligned to it, and their gestures interpolated.

export const P = 24;   // profile samples along a mark

// ------------------------------------------------------------------ sampling
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
const PERMS = new Map();
// digits of each base shuffled (per seed), which removes the strong
// correlation plain Halton sequences have between their higher dimensions
function perm(b, seed) {
  const key = b + ':' + seed;
  if (!PERMS.has(key)) {
    const r = mulberry32(b * 7919 + seed * 104729 + 1), p = [...Array(b).keys()];
    for (let i = b - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    PERMS.set(key, p);
  }
  return PERMS.get(key);
}
function radicalInverse(i, b, pm) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * pm[i % b]; i = Math.floor(i / b); }
  return r;
}
// a low-discrepancy point in [0,1)^d (scrambled Halton)
export function halton(i, d, seed = 0) {
  const out = [];
  for (let k = 0; k < d; k++) { const b = PRIMES[k]; out.push(radicalInverse(i + 1, b, perm(b, seed))); }
  return out;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const logr = (a, b, t) => a * Math.pow(b / a, t);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// Sample the i-th gesture of a codebook. About one in ten is a press (a dot,
// dab or rosette); the rest are travelling strokes.
export function sampleGesture(i, seed, brush, sizes) {
  const h = halton(i, 15, seed);
  const size = sizes[Math.min(sizes.length - 1, Math.floor(h[0] * sizes.length))];
  if (h[13] < 0.1) {
    return { kind: 'press', brush, size, press: +lerp(0.15, 0.95, h[1]).toFixed(3), hold: Math.round(logr(30, 500, h[2])), tilt: +(0.5 * h[3] * h[3]).toFixed(3), load: +lerp(0.04, 0.95, h[10]).toFixed(3), water: +lerp(0.1, 0.6, h[11]).toFixed(3) };
  }
  const L = logr(6, 120, h[1]);
  const g = {
    kind: 'stroke', brush, size,
    L: +L.toFixed(1),
    bow: +(0.22 * h[2] * h[2]).toFixed(3),
    sbend: h[3] < 0.25 ? +((h[3] / 0.25 - 0.5) * 0.16).toFixed(3) : 0,
    p: +lerp(0.3, 0.9, h[4]).toFixed(3),
    pStart: +h[5].toFixed(3),
    r0: +Math.min(0.45 * L, 30 * h[6] * h[6]).toFixed(1),
    pEnd: +(0.7 * h[7]).toFixed(3),
    r1: +Math.min(0.5 * L, 2 + 38 * h[8] * h[8]).toFixed(1),
    swell: h[9] < 0.5 ? 0 : +((h[9] - 0.5) / 0.5 * 0.7 - 0.15).toFixed(3),
    swellAt: +lerp(0.2, 0.8, h[12]).toFixed(3),
    speed: Math.round(logr(80, 600, h[14])),
    load: +lerp(0.04, 0.95, h[10]).toFixed(3),
    water: +lerp(0.1, 0.6, h[11]).toFixed(3),
  };
  return g;
}

// The gesture's path in its own frame: [x, y, pressure] every ~stepMM.
export function gesturePath(g, stepMM = 2.5) {
  const n = Math.max(3, Math.ceil(g.L / stepMM) + 1);
  const raw = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    raw.push([g.L * t, -g.L * (g.bow * Math.sin(Math.PI * t) + g.sbend * Math.sin(2 * Math.PI * t))]);
  }
  let s = 0;
  const S = raw.map((q, k) => (k ? (s += Math.hypot(q[0] - raw[k - 1][0], q[1] - raw[k - 1][1])) : 0));
  const Lp = s || 1;
  return raw.map((q, k) => {
    const d = S[k];
    let env = 1;
    if (g.r0 > 0 && d < g.r0) env = lerp(g.pStart, 1, smooth(d / g.r0));
    if (g.r1 > 0 && d > Lp - g.r1) env = Math.min(env, lerp(1, g.pEnd, smooth((d - (Lp - g.r1)) / g.r1)));
    if (g.r0 <= 0 && k === 0) env = g.pStart;
    const u = d / Lp;
    const bump = g.swell ? g.swell * Math.exp(-Math.pow((u - g.swellAt) / 0.22, 2)) : 0;
    let p = clamp(g.p * env * (1 + bump), 0, 1);
    if (k === n - 1) p = Math.min(p, 0.02);   // and off the paper
    return [q[0], q[1], +p.toFixed(3)];
  });
}

// pose: where the gesture's origin goes (x, y mm), its angle (radians,
// counter-clockwise on the page with y down means clockwise visually is
// negative), an optional mirror across its axis, and a stretch along it.
export function transform(pose) {
  const c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0), m = pose.mirror ? -1 : 1, k = pose.scale || 1;
  return (q) => { const x = q[0] * k, y = q[1] * m * k; return [pose.x + c * x - s * y, pose.y + s * x + c * y]; };
}

// A gesture placed on the sheet as ordinary actions (sheet fractions).
export function placeGesture(g, pose, sheetMM, pigments) {
  const T = transform(pose);
  const f = (q) => [+(q[0] / sheetMM[0]).toFixed(4), +(q[1] / sheetMM[1]).toFixed(4)];
  const pig = pigments || { 0: 1 };
  if (g.kind === 'press') {
    const at = f(T([0, 0]));
    const dir = T([1, 0]), o = T([0, 0]);
    const ang = Math.atan2(dir[1] - o[1], dir[0] - o[0]);
    const tilt = g.tilt > 0.02 ? [+(Math.cos(ang) * g.tilt).toFixed(3), +(-Math.sin(ang) * g.tilt).toFixed(3)] : [0, 0.001];
    return [{ type: 'press', at, press: g.press, hold: g.hold, tilt, brush: g.brush, size: g.size, load: g.load, water: g.water, pigments: pig }];
  }
  const pts = gesturePath(g).map((q) => { const w = T(q); return [...f(w), q[2]]; });
  return [{ type: 'stroke', brush: g.brush, size: g.size, load: g.load, water: g.water, speed: g.speed, pigments: pig, settle: 25, lift: 40, pts }];
}

// The box a gesture's mark can occupy, in its own frame (mm), from the
// brush width (mm) at its size.
export function gestureBox(g, brushW) {
  // generous: wet ink bleeds several mm on raw paper, and a mark cut off by
  // its box (or one reaching into a neighbour's) measures wrong
  const w = brushW[g.size] || 8, bleed = 3 + 10 * g.water;
  if (g.kind === 'press') { const r = 0.5 * w * (1.6 + 1.8 * g.press) + bleed; return [-r - 3, -r, r + 4 + 24 * g.tilt, r]; }
  const hw = 0.5 * w * (1 + 1.6 * g.p * (1 + Math.max(0, g.swell))) + bleed;
  const up = g.L * (g.bow + Math.abs(g.sbend)), dn = g.L * Math.abs(g.sbend);
  return [-22, -up - hw, g.L + 14, dn + hw];
}

// Shelf-pack gesture boxes onto sheets (all painted horizontally).
export function packSheets(items, sheetMM, gap = 5, margin = 6) {
  const sorted = items.map((it, i) => ({ i, box: it.box, w: it.box[2] - it.box[0], h: it.box[3] - it.box[1] })).sort((a, b) => b.h - a.h || b.w - a.w);
  const sheets = [];
  let cur = null;
  const open = () => { cur = { cells: [], shelves: [] }; sheets.push(cur); };
  open();
  for (const it of sorted) {
    if (it.w > sheetMM[0] - 2 * margin || it.h > sheetMM[1] - 2 * margin) continue;
    let placed = false;
    for (const sh of cur.shelves) {
      if (it.h <= sh.h && sh.x + it.w <= sheetMM[0] - margin) { cur.cells.push({ i: it.i, x: sh.x - it.box[0], y: sh.y - it.box[1] }); sh.x += it.w + gap; placed = true; break; }
    }
    if (placed) continue;
    const top = cur.shelves.length ? cur.shelves[cur.shelves.length - 1].y + cur.shelves[cur.shelves.length - 1].h + gap : margin;
    if (top + it.h > sheetMM[1] - margin) { open(); }
    const y0 = cur.shelves.length ? cur.shelves[cur.shelves.length - 1].y + cur.shelves[cur.shelves.length - 1].h + gap : margin;
    const sh = { y: y0, h: it.h, x: margin };
    cur.shelves.push(sh);
    cur.cells.push({ i: it.i, x: sh.x - it.box[0], y: sh.y - it.box[1] });
    sh.x += it.w + gap;
  }
  return sheets.map((s) => s.cells);
}

// ------------------------------------------------------------------ matching
// An entry's descriptor d: { len, x0, x1 (mark start/end along the axis,
// relative to the gesture's origin, mm), w[P] width mm, v[P] L*, c[P]
// centreline offset mm (canonical, +y down), cov (0..1 solid), area }.
// A target: { len, w[P], v[P], c[P] (in the target's own chord frame),
// cov (optional) }.

// Resample a polyline (mm) to n points evenly by arc length.
export function resamplePath(pts, n) {
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = S[S.length - 1] || 1, out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const s = (L * (k + 0.5)) / n;
    while (j < pts.length - 1 && S[j] < s) j++;
    const t = (s - S[j - 1]) / (S[j] - S[j - 1] || 1);
    out.push([lerp(pts[j - 1][0], pts[j][0], t), lerp(pts[j - 1][1], pts[j][1], t)]);
  }
  return { pts: out, len: L };
}

// A target's centreline in its own frame: chord from first to last sample
// along +x, offsets across it (+y is to the right of travel on the page).
export function chordFrame(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  return pts.map((q) => [(q[0] - a[0]) * ux + (q[1] - a[1]) * uy, -(q[0] - a[0]) * uy + (q[1] - a[1]) * ux]);
}

export class Codebook {
  constructor(entries, meta) {
    this.meta = meta || {};
    this.entries = entries.filter((e) => e.d && e.d.len > 0.5);
    const n = this.entries.length;
    this.len = new Float32Array(n);
    this.W = new Float32Array(n * P); this.V = new Float32Array(n * P); this.C = new Float32Array(n * P);
    this.cov = new Float32Array(n);
    this.entries.forEach((e, k) => {
      this.len[k] = e.d.len; this.cov[k] = e.d.cov == null ? 1 : e.d.cov;
      for (let j = 0; j < P; j++) { this.W[k * P + j] = e.d.w[j]; this.V[k * P + j] = e.d.v[j]; this.C[k * P + j] = e.d.c[j]; }
    });
    this.byId = new Map(this.entries.map((e, k) => [e.id, k]));
  }
  get size() { return this.entries.length; }
  // take in newly painted entries (a grown neighbourhood)
  add(entries) {
    const all = this.entries.concat(entries.filter((e) => e.d && e.d.len > 0.5));
    const fresh = new Codebook(all, this.meta);
    Object.assign(this, fresh);
    return this;
  }
  maxId() { let m = 0; for (const e of this.entries) if (e.id > m) m = e.id; return m; }

  // Distance from entry k to a target (profiles in the target's travel
  // direction). Mirrored entries are considered too: m = -1 flips the
  // entry's centreline. Returns [distance, mirror].
  distance(k, t, wts) {
    // scaled so that each of these costs 1: length off by 10%, width off by
    // 10% of the mark's mean width, value off by 5 L*, the centreline off
    // by 2% of the length, coverage off by 0.3
    const le = this.len[k], lt = t.len;
    let d = wts.len * 110 * Math.pow(Math.log(le / lt), 2);
    let sw = 0, sv = 0, sc0 = 0, sc1 = 0;
    const wn = t.wMean || 1;
    for (let j = 0; j < P; j++) {
      const dw = (this.W[k * P + j] - t.w[j]) / wn; sw += dw * dw;
      const dv = this.V[k * P + j] - t.v[j]; sv += dv * dv;
      // centreline shape, relative to length (so it compares bends, not size)
      const ce = this.C[k * P + j] / le, ct = t.c[j] / lt;
      sc0 += (ce - ct) * (ce - ct); sc1 += (ce + ct) * (ce + ct);
    }
    const mirror = sc1 < sc0;
    d += (wts.width * 100 * sw + wts.value * 0.04 * sv + wts.shape * 2500 * Math.min(sc0, sc1)) / P;
    if (wts.texture && t.cov != null) d += wts.texture * 11 * Math.pow(this.cov[k] - t.cov, 2);
    return [d, mirror];
  }

  // The k nearest entries to a target, trying it in both directions of
  // travel unless the direction is fixed.
  nearest(t, k = 8, opts = {}) {
    const wts = Object.assign({ len: 1, width: 1, value: 1, shape: 1, texture: 0.3 }, opts.weights || {});
    const dirs = opts.direction === 'forward' ? [t] : opts.direction === 'reverse' ? [reverseTarget(t)] : [t, reverseTarget(t)];
    const best = [];
    const kinds = opts.kinds;
    for (let e = 0; e < this.entries.length; e++) {
      if (kinds && !kinds.includes(this.entries[e].g.kind)) continue;
      if (opts.sizes && !opts.sizes.includes(this.entries[e].g.size)) continue;
      for (let di = 0; di < dirs.length; di++) {
        const [d, mirror] = this.distance(e, dirs[di], wts);
        if (best.length < k || d < best[best.length - 1].d) {
          best.push({ k: e, d, mirror, reversed: di === 1 });
          best.sort((a, b) => a.d - b.d);
          if (best.length > k) best.pop();
        }
      }
    }
    return best.map((b) => Object.assign(b, { entry: this.entries[b.k] }));
  }
}

export function reverseTarget(t) {
  const r = Object.assign({}, t, { w: t.w.slice().reverse(), v: t.v.slice().reverse(), c: t.c.slice().reverse().map((x) => -x), pts: t.pts ? t.pts.slice().reverse() : null });
  return r;
}

// Rotation, translation and (limited) scale that best put an entry's
// measured centreline onto the target's (both P points; least squares,
// 2-D Procrustes). The entry's points are in its own frame, mirrored first
// if asked; the target's are on the sheet (mm).
export function alignPose(entry, mirror, targetPts, allowScale = [0.85, 1.18]) {
  const d = entry.d;
  const src = [];
  for (let j = 0; j < P; j++) src.push([d.x0 + (d.len * (j + 0.5)) / P, (mirror ? -1 : 1) * d.c[j]]);
  const n = P;
  let mx = 0, my = 0, tx = 0, ty = 0;
  for (let j = 0; j < n; j++) { mx += src[j][0]; my += src[j][1]; tx += targetPts[j][0]; ty += targetPts[j][1]; }
  mx /= n; my /= n; tx /= n; ty /= n;
  let a = 0, b = 0, ss = 0, st = 0;
  for (let j = 0; j < n; j++) {
    const x = src[j][0] - mx, y = src[j][1] - my, u = targetPts[j][0] - tx, v = targetPts[j][1] - ty;
    a += x * u + y * v; b += x * v - y * u; ss += x * x + y * y; st += u * u + v * v;
  }
  const ang = Math.atan2(b, a);
  const scale = clamp(Math.sqrt(st / Math.max(1e-6, ss)), allowScale[0], allowScale[1]);
  const c = Math.cos(ang), s = Math.sin(ang);
  // origin maps so that the centroid lands on the target's centroid
  const x = tx - scale * (c * mx - s * my), y = ty - scale * (s * mx + c * my);
  // residual (mm, rms) after alignment
  let r = 0;
  for (let j = 0; j < n; j++) {
    const px = x + scale * (c * src[j][0] - s * src[j][1]), py = y + scale * (s * src[j][0] + c * src[j][1]);
    r += (px - targetPts[j][0]) ** 2 + (py - targetPts[j][1]) ** 2;
  }
  return { x, y, angle: ang, mirror, scale, rms: Math.sqrt(r / n) };
}

const CONT = ['L', 'bow', 'sbend', 'p', 'pStart', 'r0', 'pEnd', 'r1', 'swell', 'swellAt', 'speed', 'load', 'water', 'press', 'hold', 'tilt'];

// Interpolate the gestures of several matches (weights ~ 1/distance^power).
// Brush size is a whole number and the direction of travel a choice, so
// only matches of the heaviest one's kind, size and direction are blended
// (up to n of them, from a larger pool); a mirrored match is a mirrored
// placement of an ordinary gesture, so it blends too, with its centreline
// flipped. Every continuous parameter is blended, and so is the mark it
// should leave.
export function blendMatches(pool, n = 6, power = 2) {
  const top = pool[0];
  const same = pool.filter((m) => m.entry.g.kind === top.entry.g.kind && m.entry.g.size === top.entry.g.size && m.reversed === top.reversed).slice(0, n);
  const w = same.map((m) => 1 / Math.pow(m.d + 0.05, power));
  const W = w.reduce((a, b) => a + b, 0);
  const g = Object.assign({}, top.entry.g);
  for (const key of CONT) {
    if (g[key] == null) continue;
    let v = 0;
    same.forEach((m, i) => {
      let x = m.entry.g[key] == null ? g[key] : m.entry.g[key];
      // a mirrored match bends the other way (bow and S flip with it)
      if ((key === 'bow' || key === 'sbend') && m.mirror !== top.mirror) x = -x;
      v += w[i] * x;
    });
    g[key] = +(v / W).toFixed(key === 'speed' || key === 'hold' ? 0 : 3);
  }
  if (g.bow < 0) { g.bow = -g.bow; g.sbend = -g.sbend; g._flip = true; }
  const d = { len: 0, x0: 0, x1: 0, w: new Array(P).fill(0), v: new Array(P).fill(0), c: new Array(P).fill(0), cov: 0 };
  same.forEach((m, i) => {
    const e = m.entry.d, f = w[i] / W, sg = m.mirror === top.mirror ? 1 : -1;
    d.len += f * e.len; d.x0 += f * e.x0; d.x1 += f * e.x1; d.cov += f * (e.cov == null ? 1 : e.cov);
    for (let j = 0; j < P; j++) { d.w[j] += f * e.w[j]; d.v[j] += f * e.v[j]; d.c[j] += f * sg * e.c[j]; }
  });
  if (g._flip) { d.c = d.c.map((x) => -x); delete g._flip; return { g, d, flip: true, from: same.map((m, i) => ({ id: m.entry.id, weight: +(w[i] / W).toFixed(3) })) }; }
  return { g, d, flip: false, from: same.map((m, i) => ({ id: m.entry.id, weight: +(w[i] / W).toFixed(3) })) };
}

// The target a mark description asks for: a centreline on the sheet (mm),
// and width / value either constant, as profiles, or measured (the caller
// fills w/v from the reference image).
export function makeTarget(ptsMM, widths, values, cov) {
  const r = resamplePath(ptsMM, P);
  const loc = chordFrame(r.pts);
  const w = Array.isArray(widths) ? widths : new Array(P).fill(widths);
  const v = Array.isArray(values) ? values : new Array(P).fill(values);
  const wMean = w.reduce((a, b) => a + b, 0) / P || 1;
  return { pts: r.pts, len: r.len, w, v, c: loc.map((q) => q[1]), wMean, cov };
}

// A constant-width description of a mark with pointed or blunt ends: the
// width profile tapers over the given lengths (mm) at each end.
export function taperedWidths(len, width, ends) {
  const [a, b] = ends || [0, 0];
  const out = [];
  for (let j = 0; j < P; j++) {
    const s = (len * (j + 0.5)) / P;
    let f = 1;
    if (a > 0 && s < a) f = Math.min(f, 0.15 + 0.85 * smooth(s / a));
    if (b > 0 && s > len - b) f = Math.min(f, 0.15 + 0.85 * smooth((len - s) / b));
    out.push(+(width * f).toFixed(2));
  }
  return out;
}

// ------------------------------------------------------------ local inverse
// Around a target, marks change smoothly with the gesture: fit that change
// linearly from the nearest same-size, same-direction matches (weighted
// least squares), then solve for the gesture whose predicted mark is the
// target, held near the blend (ridge) so it does not run off where the
// codebook has no marks.
const SOLVE = [['L', 100], ['bow', 0.2], ['sbend', 0.1], ['p', 0.5], ['pStart', 1], ['r0', 25], ['pEnd', 0.6], ['r1', 35], ['swell', 0.6], ['swellAt', 0.5], ['speed', 400], ['load', 0.8], ['water', 0.4]];
const RANGE = { L: [4, 140], bow: [0, 0.3], sbend: [-0.12, 0.12], p: [0.2, 0.95], pStart: [0, 1], r0: [0, 40], pEnd: [0, 0.8], r1: [1, 50], swell: [-0.2, 0.7], swellAt: [0.15, 0.85], speed: [60, 700], load: [0.02, 0.98], water: [0.08, 0.65] };
function features(d, t, sg) {
  // length, width (8 bins, relative to the target's mean width), value (8
  // bins), bend (8 bins, relative to length)
  const f = [Math.log(d.len / t.len) * 3];
  const bins = 8, step = P / bins;
  for (let b = 0; b < bins; b++) { let w = 0; for (let j = b * step; j < (b + 1) * step; j++) w += d.w[j]; f.push((w / step) / (t.wMean || 1)); }
  for (let b = 0; b < bins; b++) { let v = 0; for (let j = b * step; j < (b + 1) * step; j++) v += d.v[j]; f.push((v / step) / 12); }
  for (let b = 0; b < bins; b++) { let c = 0; for (let j = b * step; j < (b + 1) * step; j++) c += d.c[j]; f.push(((sg * c) / step / Math.max(1, d.len)) * 25); }
  return f;
}
function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting (small dense systems)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c]; if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / piv; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}
export function solveMatches(pool, t, n = 16, ridge = 0.6) {
  const B = blendMatches(pool, 6);
  const top = pool[0];
  const same = pool.filter((m) => m.entry.g.kind === 'stroke' && m.entry.g.kind === top.entry.g.kind && m.entry.g.size === top.entry.g.size && m.reversed === top.reversed).slice(0, n);
  if (same.length < 6) return null;
  const tf = features({ len: t.len, w: t.w, v: t.v, c: t.c }, t, 1);
  const x0 = SOLVE.map(([k, s]) => (B.g[k] || 0) / s);
  const X = same.map((m) => SOLVE.map(([k, s]) => (((m.mirror !== top.mirror && (k === 'bow' || k === 'sbend')) ? -1 : 1) * (m.entry.g[k] || 0)) / s));
  const sgT = top.mirror ? -1 : 1;
  const F = same.map((m) => features(m.entry.d, t, (m.mirror ? -1 : 1) * sgT * (top.mirror ? -1 : 1)));
  const wts = same.map((m) => 1 / Math.pow(m.d + 0.05, 1));
  const q = SOLVE.length, nf = tf.length;
  // regress each feature on [x - x0, 1]: F ≈ (X - x0) G + h
  const Z = X.map((x) => [...x.map((v, i) => v - x0[i]), 1]);
  const ZtZ = [...Array(q + 1)].map(() => new Array(q + 1).fill(0));
  const ZtF = [...Array(q + 1)].map(() => new Array(nf).fill(0));
  Z.forEach((z, r) => { for (let i = 0; i <= q; i++) { for (let j = 0; j <= q; j++) ZtZ[i][j] += wts[r] * z[i] * z[j]; for (let j = 0; j < nf; j++) ZtF[i][j] += wts[r] * z[i] * F[r][j]; } });
  const wsum = wts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < q; i++) ZtZ[i][i] += 0.05 * wsum;   // stabilise the fit itself
  const G = [...Array(nf)].map((_, j) => solveLinear(ZtZ, ZtZ.map((_, i) => ZtF[i][j])));   // G[j] = coefficients for feature j
  // solve (G_x^T G_x + ridge I) dx = G_x^T (tf - h)
  const GtG = [...Array(q)].map(() => new Array(q).fill(0)), Gtr = new Array(q).fill(0);
  for (let j = 0; j < nf; j++) {
    const g = G[j], h = g[q], r = tf[j] - h;
    for (let a = 0; a < q; a++) { Gtr[a] += g[a] * r; for (let b = 0; b < q; b++) GtG[a][b] += g[a] * g[b]; }
  }
  for (let a = 0; a < q; a++) GtG[a][a] += ridge;
  const dx = solveLinear(GtG, Gtr);
  const g = Object.assign({}, B.g);
  SOLVE.forEach(([k, s], i) => { const lo = RANGE[k][0], hi = RANGE[k][1]; g[k] = +clamp((x0[i] + dx[i]) * s, lo, hi).toFixed(k === 'speed' ? 0 : 3); });
  let flip = B.flip;
  if (g.bow < 0) { g.bow = -g.bow; g.sbend = -g.sbend; flip = !flip; }
  // the mark it should leave, for placing it: the blend's, stretched to the
  // solved length
  const d = Object.assign({}, B.d, { c: B.flip !== flip ? B.d.c.map((x) => -x) : B.d.c });
  const k = g.L / Math.max(1, B.g.L);
  d.x0 *= k; d.x1 *= k; d.len *= k; d.c = d.c.map((x) => x * k);
  return { g, d, flip, from: B.from };
}

// A nearby gesture: every continuous parameter nudged (by about s of its
// usual range), and now and then the next brush size.
export function perturbGesture(g, s, rnd) {
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const n = Object.assign({}, g);
  if (g.kind === 'press') {
    n.press = +clamp(g.press + 0.3 * s * gauss(), 0.1, 0.98).toFixed(3);
    n.hold = Math.round(clamp(g.hold * Math.exp(0.6 * s * gauss()), 20, 700));
    n.tilt = +clamp(g.tilt + 0.2 * s * gauss(), 0, 0.6).toFixed(3);
  } else {
    n.L = +clamp(g.L * Math.exp(0.3 * s * gauss()), 4, 140).toFixed(1);
    n.bow = +clamp(g.bow + 0.08 * s * gauss(), 0, 0.3).toFixed(3);
    n.sbend = +clamp(g.sbend + 0.04 * s * gauss(), -0.12, 0.12).toFixed(3);
    n.p = +clamp(g.p + 0.25 * s * gauss(), 0.2, 0.95).toFixed(3);
    n.pStart = +clamp(g.pStart + 0.5 * s * gauss(), 0, 1).toFixed(3);
    n.r0 = +clamp(g.r0 + 15 * s * gauss(), 0, 0.45 * n.L).toFixed(1);
    n.pEnd = +clamp(g.pEnd + 0.35 * s * gauss(), 0, 0.8).toFixed(3);
    n.r1 = +clamp(g.r1 + 18 * s * gauss(), 1, 0.5 * n.L).toFixed(1);
    n.swell = +clamp(g.swell + 0.35 * s * gauss(), -0.2, 0.7).toFixed(3);
    n.swellAt = +clamp(g.swellAt + 0.3 * s * gauss(), 0.15, 0.85).toFixed(3);
    n.speed = Math.round(clamp(g.speed * Math.exp(0.5 * s * gauss()), 60, 700));
  }
  n.load = +clamp(g.load + 0.3 * s * gauss(), 0.02, 0.98).toFixed(3);
  n.water = +clamp(g.water + 0.18 * s * gauss(), 0.08, 0.65).toFixed(3);
  if (rnd() < 0.7 * s) n.size = clamp(g.size + (rnd() < 0.5 ? -1 : 1), 0, 9);
  return n;
}

// The outline a target mark occupies (sheet fractions): its centreline with
// half its measured width either side, plus a tolerance, and a little past
// both ends.
export function targetBand(t, sheetMM, tolMM = 0.8, rel = 0.25, endMM = 3) {
  const n = t.pts.length, L = [], R = [];
  for (let j = 0; j < n; j++) {
    const a = t.pts[Math.max(0, j - 1)], b = t.pts[Math.min(n - 1, j + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const half = Math.max(0.5, t.w[j]) * (0.5 + rel * 0.5) + tolMM;
    let p = t.pts[j];
    if (j === 0) p = [p[0] - tx * endMM, p[1] - ty * endMM];
    if (j === n - 1) p = [p[0] + tx * endMM, p[1] + ty * endMM];
    L.push([(p[0] - ty * half) / sheetMM[0], (p[1] + tx * half) / sheetMM[1]]);
    R.push([(p[0] + ty * half) / sheetMM[0], (p[1] - tx * half) / sheetMM[1]]);
  }
  return [L.concat(R.reverse())];
}
