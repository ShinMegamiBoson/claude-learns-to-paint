// Stroke library: marks described by where they should land, how wide and
// how dark, compiled into brush actions using measurements of how this
// brush actually marks this paper (see `ink strokes calibrate`).
//
//   {"type": "lib", "stroke": "line", "path": [[x, y], ...], "width": 3, "value": 50}
//
// Everything is in sheet fractions (x right, y down) except width/length in
// mm and value in L* (0 black … ~95 bare paper). A lib action can also carry
// ordinary brush fields (pigments, water, speed, brush, size, pressure, load)
// to override what the library would choose, and `raw: true` to skip the
// lag compensation (used when calibrating).

import * as CB from './codebook.mjs';
import * as HAND from './hand.mjs';
import { mixFor } from './paintmix.mjs';

export const KINDS = {
  line: 'a line along path: stalks, legs, beaks, crest plumes, outlines',
  blade: 'a leaf or reed blade from base to tip, swelling then tapering to a point',
  dab: 'a short mark centred on at: cattail heads, knees, eyes, buds',
  band: 'a soft horizontal band: water dashes, distant horizons',
  stack: 'a vertical run of short bands, narrowing downward: reflections',
  drybrush: 'a broken, streaky line: feathers, bark, grass texture',
  mist: 'a pale soft-edged cloud: pre-wet paper, then light fast passes',
  wash: 'a flat region of one value (rect, poly, rings or region)',
  saved: 'a saved recipe (strokes save), fitted onto from→to',
  fit: 'the codebook gesture(s) whose painted mark best matches a mark along path (width/value given, or measured from the target)',
  hatch: 'pencil: parallel strokes filling a region at an angle (layers: several angles = cross-hatching)',
  rough: 'pencil: a loose first sketch of an outline: light, overlapping, searching strokes',
  gesture: 'a stroke written as the hand\'s acceleration over time (start, v0, acc), integrated with momentum',
  tone: 'pencil: shading with the side of the lead over a region (blend: true to smooth it with a stump)',
  blend: 'pencil: a blending stump worked over a region',
  erase: 'pencil: a kneaded eraser lifting graphite along a path or over a region',
  code: 'code:<id>: one codebook mark placed from→to (any angle)',
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// how much the brush is loaded with water, per texture: a flooded brush lays
// solid ink; a semi-dry one breaks into hair streaks at its flanks and tail
// (the look of most sumi-e marks); a dry one scatters flying white throughout
export const TEXTURE = {
  solid: { water: 0.38, speed: 230 },
  natural: { water: 0.22, speed: 300 },
  dry: { water: 0.15, speed: 420 },
};
const lerp = (a, b, t) => a + (b - a) * t;

// piecewise-linear lookup on sorted xs
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return lerp(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1));
  return ys[ys.length - 1];
}
// invert a monotone increasing table (ys increasing with xs)
function invert(xs, ys, y) {
  const pairs = xs.map((x, i) => [ys[i], x]).sort((a, b) => a[0] - b[0]);
  return interp(pairs.map((p) => p[0]), pairs.map((p) => p[1]), y);
}

export class Library {
  constructor(ctx) {
    // ctx: { sheetMM, medium, paperL, cal, pigCal, saved }
    Object.assign(this, ctx);
    this.brush = (ctx.cal && ctx.cal.brush) || (ctx.medium === 'ink' ? 'fude' : 'round');
  }
  mm(p) { return [p[0] * this.sheetMM[0], p[1] * this.sheetMM[1]]; }
  frac(p) { return [p[0] / this.sheetMM[0], p[1] / this.sheetMM[1]]; }

  // ---------------------------------------------------------- choices
  // size and pressure for a mark width (mm): prefer pressures near 0.5,
  // where the brush is most controllable
  chooseWidth(w, a) {
    if (a.size != null && a.pressure != null) return { size: a.size, pressure: a.pressure };
    const t = this.need('width');
    let best = null;
    for (const size of t.sizes) {
      if (a.size != null && size !== a.size) continue;
      const rows = t.rows.filter((r) => r.size === size && r.width > 0).sort((p, q) => p.pressure - q.pressure);
      if (rows.length < 2) continue;
      const ws = rows.map((r) => r.width), ps = rows.map((r) => r.pressure);
      if (w < ws[0] * 0.85 || w > ws[ws.length - 1] * 1.15) {
        const edge = w < ws[0] ? { p: ps[0], miss: ws[0] - w } : { p: ps[ps.length - 1], miss: w - ws[ws.length - 1] };
        const cand = { size, pressure: edge.p, cost: 10 + edge.miss };
        if (!best || cand.cost < best.cost) best = cand;
        continue;
      }
      const p = clamp(invert(ps, ws, w), 0.25, 0.85);
      const cand = { size, pressure: p, cost: Math.abs(p - 0.5) };
      if (!best || cand.cost < best.cost) best = cand;
    }
    if (!best) throw new Error(`no calibrated brush makes a ${w} mm mark`);
    return { size: best.size, pressure: +best.pressure.toFixed(3) };
  }
  // how far the mark starts after / ends before the path's ends (mm)
  lag(size, pressure, kind) {
    const t = this.need('width');
    let rows = t.rows.filter((r) => r.size === size && r.start != null).sort((p, q) => p.pressure - q.pressure);
    if (!rows.length) rows = t.rows.filter((r) => r.start != null).sort((p, q) => Math.abs(p.size - size) - Math.abs(q.size - size)).slice(0, 3).sort((p, q) => p.pressure - q.pressure);
    const c = this.corr(kind);
    if (!rows.length) return { start: c.start, end: c.end };
    return {
      start: interp(rows.map((r) => r.pressure), rows.map((r) => r.start), pressure) + c.start,
      end: interp(rows.map((r) => r.pressure), rows.map((r) => r.end), pressure) + c.end,
    };
  }
  corr(kind) {
    const k = (this.cal && this.cal.corrections && this.cal.corrections[kind]) || {};
    return { start: k.start || 0, end: k.end || 0, width: k.width || 1, dark: k.dark || null, wdark: k.wdark || null };
  }
  // how much wider than asked this kind of mark comes out at this value
  widthFactor(kind, value) {
    const c = this.corr(kind);
    if (c.wdark && c.wdark.length) return clamp(interp(c.wdark.map((q) => q[0]), c.wdark.map((q) => q[1]), Math.max(1, this.paperL - value)), 0.5, 2.5);
    return c.width;
  }
  // the value to ask the load tables for so this kind of mark comes out at
  // `value`: its darkness is scaled by a measured curve (pale and dark marks
  // of the same kind can be off by different factors)
  corrValue(kind, value) {
    const c = this.corr(kind).dark;
    if (!c || !c.length) return value;
    const D = Math.max(0.5, this.paperL - value);
    const xs = c.map((q) => q[0]), hi = xs[xs.length - 1];
    let f = interp(xs, c.map((q) => q[1]), D);
    // no extrapolating past the darkest measured mark: fade back to 1 (a
    // factor learned where a thin mark ran out of ink must not blacken
    // wider marks that can reach the value)
    if (D > hi) f = lerp(f, 1, clamp((D - hi) / 15, 0, 1));
    return clamp(this.paperL - D * clamp(f, 0.75, 1.35), 0, 99);
  }
  // load for a value (L*) for this kind of mark, size and pressure
  chooseLoad(kind, value, size, pressure, a) {
    if (a.load != null) return a.load;
    const v = this.need('value');
    const table = v[kind] || v.line;
    const D = Math.max(0.5, this.paperL - value);
    // thicker, harder-pressed marks deposit more: scale by the width sheet's
    // darkness at load 0.5 relative to the value sheet's reference stroke
    let scale = 1;
    const wt = this.cal.width;
    if (wt && table.ref && kind !== 'mist' && kind !== 'band') {
      const rows = wt.rows.filter((r) => r.size === size && r.L != null).sort((p, q) => p.pressure - q.pressure);
      const refRows = wt.rows.filter((r) => r.size === table.ref.size && r.L != null).sort((p, q) => p.pressure - q.pressure);
      if (rows.length && refRows.length) {
        const d = this.paperL - interp(rows.map((r) => r.pressure), rows.map((r) => r.L), pressure);
        const d0 = this.paperL - interp(refRows.map((r) => r.pressure), refRows.map((r) => r.L), table.ref.pressure);
        if (d > 1 && d0 > 1) scale = clamp(d / d0, 0.5, 2);
      }
    }
    const pig = pigmentKey(a.pigments);
    // washes: the run's own swatch calibration (per pigment, painted as washes)
    if (kind === 'wash' && this.pigCal) {
      const rows = this.pigCal.filter((q) => q.pigment === (pig == null ? 0 : pig));
      if (rows.length) return +clamp(invert(rows.map((q) => q.load), rows.map((q) => this.paperL - q.L), D), 0.01, 0.95).toFixed(3);
    }
    const ds = table.rows.map((r) => this.paperL - r.L), loads = table.rows.map((r) => r.load);
    // other pigments: scale by how dark their wash is next to the reference pigment's
    let ratio = 1;
    if (this.pigCal && pig != null && pig !== 0) {
      const r0 = this.pigCal.filter((q) => q.pigment === 0), rp = this.pigCal.filter((q) => q.pigment === pig);
      if (r0.length && rp.length) {
        const dAt = (rows) => this.paperL - interp(rows.map((q) => q.load), rows.map((q) => q.L), 0.45);
        ratio = clamp(dAt(rp) / Math.max(1, dAt(r0)), 0.1, 3);
      }
    }
    const want = D / scale / ratio;
    const load = invert(loads, ds, want);
    if (want < Math.min(...ds) * 0.9 && kind !== 'mist') this.warn(`value L${value} is paler than a ${kind} can go (≈L${Math.round(this.paperL - Math.min(...ds))} at load ${Math.min(...loads)}); use a mist or band`);
    // (natural lines get a fuller brush for darks, which these load tables do not include)
    if (want > Math.max(...ds) * (kind === 'line' || kind === 'blade' ? 1.4 : 1.1)) this.warn(`value L${Math.round(value)} is darker than a ${kind} reaches (≈L${Math.round(this.paperL - Math.max(...ds))}); use a bigger or harder-pressed mark`);
    return +clamp(load, 0.01, 0.95).toFixed(3);
  }
  need(k) {
    if (!this.cal || !this.cal[k]) throw new Error(`no stroke calibration for ${this.medium}/${this.paper || '?'} (run: ink strokes calibrate <run>)`);
    return this.cal[k];
  }
  warn(msg) { (this.warnings = this.warnings || []).push(msg); }

  // ---------------------------------------------------------- geometry
  // extend (positive) or trim (negative) the ends of a polyline in mm
  extend(pts, startMM, endMM) {
    const P = pts.map((p) => p.slice());
    const push = (i, j, d) => {
      const dx = P[i][0] - P[j][0], dy = P[i][1] - P[j][1], L = Math.hypot(dx, dy) || 1;
      P[i] = [P[i][0] + (dx / L) * d, P[i][1] + (dy / L) * d];
    };
    push(0, 1, startMM);
    push(P.length - 1, P.length - 2, endMM);
    return P;
  }
  resample(pts, stepMM) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / stepMM));
      for (let k = 1; k <= n; k++) out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
    }
    return out;
  }
  lengthMM(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; }

  // ---------------------------------------------------------- builders
  expand(a) {
    const kind = a.stroke;
    if (kind && kind.startsWith('saved:')) return this.savedRecipe(a, kind.slice(6));
    if (kind && kind.startsWith('code:')) return this.codeMark(a, +kind.slice(5)).map((x) => Object.assign({ label: a.label || kind }, x, { lib: 'code' }));
    const pencilKinds = { line: '_pencilLine', hatch: '_hatch', tone: '_tone', blend: '_blend', erase: '_erase', rough: '_rough', gesture: '_gesture' };
    if (this.medium === 'pencil' && !pencilKinds[kind]) throw new Error(`on a pencil sheet the library has ${Object.keys(pencilKinds).join(', ')} (not ${kind})`);
    if (this.medium !== 'pencil' && ['hatch', 'tone', 'blend', 'erase', 'rough'].includes(kind)) throw new Error(`${kind} is a pencil stroke`);
    const f = this.medium === 'pencil' ? this[pencilKinds[kind]] : this['_' + kind];
    if (!f) throw new Error(`unknown library stroke "${kind}" (have: ${Object.keys(KINDS).join(', ')})`);
    const acts = f.call(this, a);
    const base = pick(a, ['pigments', 'water', 'speed', 'brush', 'tip', 'rinse', 'settle', 'lift']);
    return acts.map((x) => Object.assign({ label: a.label || kind }, x, base, { lib: kind }));
  }

  // pressure along a line: a soft landing, the body at p, a taper out
  lineStroke(ptsMM, size, p, a, opts) {
    const taper = a.taper || opts.taper || [0.6, 0.35];
    const dense = this.resample(ptsMM, 3);
    const L = this.lengthMM(dense);
    // landing ramp and taper over fixed distances (not fractions of the
    // path), so a longer path does not move where the mark fades out
    // taper_mm: [landing, lift] lengths, for marks that come to a point
    const tm = a.taper_mm || opts.taper_mm;
    const ramp = tm ? Math.min(+tm[0], 0.45 * L) : Math.min(6, 0.25 * L), tail = tm ? Math.min(+tm[1], 0.45 * L) : Math.min(12, 0.35 * L);
    let s = 0;
    const pts = dense.map((q, i) => {
      if (i) s += Math.hypot(q[0] - dense[i - 1][0], q[1] - dense[i - 1][1]);
      let f = 1;
      if (s < ramp) f = lerp(taper[0], 1, s / ramp);
      else if (s > L - tail) f = lerp(1, taper[1], (s - (L - tail)) / tail);
      let pr = p * f;
      if (i === 0) pr = Math.min(pr, 0.2);           // land lightly: pressing at touchdown splays the hairs
      if (i === dense.length - 1) pr = 0.02;
      const fr = this.frac(q);
      return [+fr[0].toFixed(4), +fr[1].toFixed(4), +clamp(pr, 0, 1).toFixed(3)];
    });
    return { type: 'stroke', pts, brush: a.brush || this.brush, size, settle: 25, lift: 40, ...opts.fields };
  }

  _line(a, over) {
    const path = a.path || (a.from && a.to ? [a.from, a.to] : null);
    if (!Array.isArray(path) || path.length < 2) throw new Error('line needs path: [[x, y], ...] or from/to');
    const dry = (over && over.dry) || a.texture === 'dry';
    const kind = (over && over.kind) || (dry ? 'drybrush' : 'line');
    const tex = TEXTURE[dry ? 'dry' : a.texture || 'natural'] || TEXTURE.natural;
    const width = num(a.width, 'width (mm)', 0.3, 60) / (a.raw ? 1 : this.widthFactor(kind, a.value));
    const value = a.raw ? num(a.value, 'value (L*)', 0, 99) : this.corrValue(kind, num(a.value, 'value (L*)', 0, 99));
    const { size, pressure } = this.chooseWidth(width, a);
    if (!a.raw && width < 1.8 && value < 70) this.warn(`a ${a.width} mm line cannot get darker than about L75 (the finest tip barely deposits); use width ≥ 2 mm for darks`);
    if (!a.raw && kind === 'dab' && (a.length || 0) < 12) this.warn(`dabs shorter than 12 mm come out narrower and paler than asked; lengthen it or ask for more width/darker value`);
    let pts = path.map((p) => this.mm(p));
    if (!a.raw) { const g = this.lag(size, pressure, kind); pts = this.extend(pts, g.start, g.end); }
    const load = this.chooseLoad(dry ? 'drybrush' : 'line', value, size, pressure, a);
    // the darkest marks need a fuller brush: a semi-dry one cannot carry enough ink
    const darkFill = (a.texture || 'natural') === 'natural' ? clamp((45 - value) / 25, 0, 1) : 0;
    const fields = { load, water: +(tex.water + 0.1 * darkFill).toFixed(3), speed: tex.speed, pigments: a.pigments || { 0: 1 } };
    return [this.lineStroke(pts, size, pressure, a, { fields, taper: (over && over.taper) || (dry ? [0.5, 0.25] : null) })];
  }
  _drybrush(a) { return this._line(a, { dry: true }); }

  _dab(a) {
    const at = pt(a.at, 'at');
    const len = num(a.length, 'length (mm)', 1, 120), ang = ((a.angle || 0) * Math.PI) / 180;
    const c = this.mm(at), h = len / 2;
    const from = this.frac([c[0] - Math.cos(ang) * h, c[1] - Math.sin(ang) * h]), to = this.frac([c[0] + Math.cos(ang) * h, c[1] + Math.sin(ang) * h]);
    return this._line(Object.assign({}, a, { path: [from, to] }), { taper: a.taper || [0.8, 0.45], kind: 'dab' });
  }

  _band(a) {
    const x0 = a.x0 != null ? a.x0 : a.from && a.from[0], x1 = a.x1 != null ? a.x1 : a.to && a.to[0];
    const y = a.y != null ? a.y : a.from && a.from[1];
    if (![x0, x1, y].every(Number.isFinite)) throw new Error('band needs x0, x1, y (or from/to)');
    const c = a.raw ? { width: 1 } : this.corr('band');
    const value = a.raw ? num(a.value, 'value (L*)', 0, 99) : this.corrValue('band', num(a.value, 'value (L*)', 0, 99)), width = num(a.width, 'width (mm)', 0.5, 30) / (a.raw ? 1 : this.widthFactor('band', a.value));
    const { size, pressure } = this.chooseWidth(width, a);
    let pts = [this.mm([x0, y]), this.mm([(x0 + x1) / 2, y + 0.002]), this.mm([x1, y])];
    if (!a.raw) { const g = this.lag(size, pressure, 'band'); pts = this.extend(pts, g.start, g.end); }
    const load = this.chooseLoad('band', value, size, pressure, a);
    return [this.lineStroke(pts, size, pressure, a, { taper: [0.35, 0.2], fields: { load, water: 0.5, speed: 380, pigments: a.pigments || { 0: 1 } } })];
  }

  _stack(a) {
    const at = pt(a.at, 'at');
    const n = a.count || 5, gap = (a.spacing || 4.5) / this.sheetMM[1];
    const w0 = a.lengths ? a.lengths[0] : a.length0 || 20, w1 = a.lengths ? a.lengths[1] : a.length1 || 8;
    const out = [];
    for (let i = 0; i < n; i++) {
      const hw = lerp(w0, w1, n > 1 ? i / (n - 1) : 0) / 2 / this.sheetMM[0];
      out.push(...this._band(Object.assign({}, a, { x0: at[0] - hw, x1: at[0] + hw, y: at[1] + i * gap, width: a.width || 3 })));
    }
    return out;
  }

  _blade(a) {
    const from = pt(a.from, 'from'), to = pt(a.to, 'to');
    const bc = a.raw ? { width: 1, start: 0, end: 0 } : this.corr('blade');
    const width = num(a.width, 'width (mm)', 0.5, 40) / (a.raw ? 1 : this.widthFactor('blade', a.value)), value = a.raw ? num(a.value, 'value (L*)', 0, 99) : this.corrValue('blade', num(a.value, 'value (L*)', 0, 99));
    const b = this.need('blade');
    // pick size/press whose measured max width is closest, press near 0.6
    let best = null;
    for (const r of b.rows) {
      if (a.size != null && r.size !== a.size) continue;
      const cost = Math.abs(r.width - width) / Math.max(width, 1) + Math.abs(r.press - 0.6) * 0.3;
      if (!best || cost < best.cost) best = Object.assign({ cost }, r);
    }
    if (!best) throw new Error('no blade calibration');
    const press = a.press != null ? a.press : clamp(best.press * (width / Math.max(best.width, 0.5)) ** 0.5, 0.52, 0.9);
    let f = this.mm(from), t = this.mm(to);
    { // residual end errors from verification: slide the ends (mm)
      const ux = t[0] - f[0], uy = t[1] - f[1], l = Math.hypot(ux, uy) || 1;
      f = [f[0] - (ux / l) * bc.start, f[1] - (uy / l) * bc.start];
      t = [t[0] + (ux / l) * bc.end, t[1] + (uy / l) * bc.end];
    }
    const Lm = Math.hypot(t[0] - f[0], t[1] - f[1]);
    // mark covers [a0, a1] of the path (measured): stretch and slide the path
    const span = Math.max(0.2, best.b - best.a);
    const Lp = a.raw ? Lm : Lm / span;
    const dx = (t[0] - f[0]) / (Lm || 1), dy = (t[1] - f[1]) / (Lm || 1);
    const s0 = a.raw ? 0 : best.a * Lp;
    const start = this.frac([f[0] - dx * s0, f[1] - dy * s0]);
    const load = this.chooseLoad('blade', value, best.size, press, a);
    return [{
      type: 'dab', at: [+start[0].toFixed(4), +start[1].toFixed(4)], angle: +((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(1),
      length: +Lp.toFixed(1), press: +press.toFixed(3), curve: a.curve || 0, brush: a.brush || this.brush, size: best.size,
      load, water: a.texture === 'solid' ? 0.4 : a.texture === 'dry' ? 0.18 : 0.26, speed: a.speed || 560, pigments: a.pigments || { 0: 1 },
    }];
  }

  _mist(a) {
    let rings = a.rings || (a.poly ? [a.poly] : null);
    if (a.rect) { const [x0, y0, x1, y1] = a.rect; rings = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]; }
    if (!rings && !a.region) throw new Error('mist needs rect, poly, rings or region');
    const value = num(a.value, 'value (L*)', 50, 99);
    const load = this.chooseLoad('mist', value, 9, 0.45, a);
    const grow = (r) => { // pre-wet a little wider than the mist so its edge stays soft
      const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cy = r.reduce((s, p) => s + p[1], 0) / r.length;
      return r.map(([x, y]) => [x + Math.sign(x - cx) * 0.012, y + Math.sign(y - cy) * 0.012]);
    };
    const region = a.region ? { region: a.region } : { rings };
    const pre = a.region ? { region: a.region } : { rings: rings.map((r, i) => (i ? r : grow(r))) };
    return [
      Object.assign({ type: 'wash', tool: 'water', brush: 'fude', size: 9, water: 0.8, spacing: 0.55, label: (a.label || 'mist') + ': pre-wet' }, pre),
      Object.assign({ type: 'wash', tool: 'brush', brush: 'fude', size: 9, load, water: 0.6, pressure: 0.45, speed: 400, spacing: 0.8, pigments: a.pigments || { 0: 1 } }, region),
    ];
  }

  _wash(a) {
    let rings = a.rings || (a.poly ? [a.poly] : null);
    if (a.rect) { const [x0, y0, x1, y1] = a.rect; rings = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]; }
    if (!rings && !a.region) throw new Error('wash needs rect, poly, rings or region');
    const value = num(a.value, 'value (L*)', 0, 99);
    const load = this.chooseLoad('wash', value, 8, 0.6, a);
    return [Object.assign({ type: 'wash', brush: a.brush || (this.medium === 'ink' ? 'fude' : 'mop'), size: a.size != null ? a.size : 8, load, water: 0.6, spacing: 0.6, pigments: a.pigments || { 0: 1 } }, a.region ? { region: a.region } : { rings })];
  }

  // saved recipe: its actions were recorded with an anchor segment; map that
  // segment onto from→to (translate, rotate, scale) and move every point
  // ---------------------------------------------------------- pencil
  // Grade and pressure for a value (L*): the hardest grade that reaches it
  // at a comfortable pressure (0.3-0.8), from the measured tables (tone =
  // hatching 1.2 mm apart, side = side-of-the-lead shading, line = one line).
  pencilChoose(value, kind, a) {
    if (a && a.grade && a.pressure != null) return { grade: a.grade, pressure: a.pressure };
    const order = ['2H', 'HB', '2B', '4B', '6B', '8B'];
    const T = (this.cal && this.cal.pencil && this.cal.pencil[kind]) || null;
    const Lof = (g, p) => {
      const rows = T && T[g];
      if (!rows) {   // no calibration: a rough model
        const dark = { '2H': 0.35, HB: 0.5, '2B': 0.62, '4B': 0.74, '6B': 0.84, '8B': 0.92 }[g];
        return 94 - 62 * dark * Math.pow(p, 0.7);
      }
      return interp(rows.map((r) => r[0]), rows.map((r) => r[1]), p);
    };
    const grades = a && a.grade ? [a.grade] : order;
    for (const g of grades) {
      const lo = Lof(g, 0.8), hi = Lof(g, 0.3);
      if (value >= lo && value <= hi) {
        // L falls as pressure rises: find p for value
        let p0 = 0.3, p1 = 0.8;
        for (let i = 0; i < 24; i++) { const m = 0.5 * (p0 + p1); if (Lof(g, m) > value) p0 = m; else p1 = m; }
        return { grade: g, pressure: +(0.5 * (p0 + p1)).toFixed(3) };
      }
    }
    // out of reach: lightest at light pressure, or darkest pressed hard
    if (value > Lof(grades[0], 0.3)) return { grade: grades[0], pressure: +Math.max(0.12, 0.3 - (value - Lof(grades[0], 0.3)) / 40).toFixed(3) };
    const g = grades[grades.length - 1];
    if (value < Lof(g, 0.8)) this.warn(`L${Math.round(value)} is darker than ${g} reaches by ${kind} (≈L${Math.round(Lof(g, 0.95))} pressed hard)`);
    return { grade: g, pressure: 0.95 };
  }
  // drawn over existing tone (over: its L*), a layer only has to supply what
  // is still missing: layers multiply reflectance
  pencilOver(value, over) {
    if (over == null) return value;
    const Y = (L) => Math.pow((L + 16) / 116, 3), P = this.paperL || 94;
    const need = Y(P) * Math.min(1, Y(value) / Y(Math.max(value, over)));
    return 116 * Math.cbrt(need) - 16;
  }
  // rings of a region (sheet fractions): rect, poly, rings
  pencilRings(a) {
    if (a.rings) return a.rings;
    if (a.poly) return [a.poly];
    if (a.rect) { const [x0, y0, x1, y1] = a.rect; return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]; }
    throw new Error(`${a.stroke} needs rect, poly, rings or region`);
  }
  // a deterministic jitter, so the same action always draws the same marks
  pencilRand(a) {
    let t = (a.seed != null ? a.seed : 1 + Math.round(1e4 * ((a.rect || a.poly || (a.rings && a.rings[0]) || a.path || [[0, 0]]).flat().reduce((x, y) => x + y, 0) % 1))) >>> 0;
    return () => { t = (t + 0x6d2b79f5) | 0; let x = Math.imul(t ^ (t >>> 15), t | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  }
  // straight strokes across a region at an angle, clipped to it (even-odd),
  // in mm; each { a, b } segment
  pencilScan(rings, angleDeg, spacingMM, rnd, jitterMM) {
    const R = rings.map((r) => r.map((q) => this.mm(q)));
    const ang = (angleDeg * Math.PI) / 180, ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
    let lo = Infinity, hi = -Infinity, tl = Infinity, th = -Infinity;
    for (const r of R) for (const [x, y] of r) { const o = x * nx + y * ny, t = x * ux + y * uy; lo = Math.min(lo, o); hi = Math.max(hi, o); tl = Math.min(tl, t); th = Math.max(th, t); }
    const segs = [];
    for (let o = lo + spacingMM * (0.5 + 0.3 * (rnd() - 0.5)); o < hi; o += spacingMM * (1 + 0.25 * (rnd() - 0.5))) {
      // where the line o crosses the outline
      const ts = [];
      for (const r of R) for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
        const o0 = x0 * nx + y0 * ny, o1 = x1 * nx + y1 * ny;
        if ((o0 <= o) === (o1 <= o)) continue;
        const f = (o - o0) / (o1 - o0);
        ts.push((x0 + (x1 - x0) * f) * ux + (y0 + (y1 - y0) * f) * uy);
      }
      ts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        let t0 = ts[i] + jitterMM * (rnd() - 0.3), t1 = ts[i + 1] - jitterMM * (rnd() - 0.3);
        if (t1 - t0 < 1) continue;
        const oo = o + 0.15 * spacingMM * (rnd() - 0.5);
        segs.push({ a: [oo * nx + t0 * ux, oo * ny + t0 * uy], b: [oo * nx + t1 * ux, oo * ny + t1 * uy] });
      }
    }
    return segs;
  }
  // one pencil stroke from mm points with a pressure envelope (lighter in
  // and out over taperMM), a slight bow, alternating direction by caller
  pencilStroke(ptsMM, grade, pressure, opts) {
    const o = opts || {};
    if (o.hand !== false && ptsMM.length >= 2 && this.lengthMM(ptsMM) > 1.5) return this.handStroke(ptsMM, grade, pressure, o);
    const dense = this.resample(ptsMM, o.step || 2);
    const L = this.lengthMM(dense) || 1;
    const [ta, tb] = o.taper || [Math.min(3, 0.25 * L), Math.min(4, 0.3 * L)];
    let s = 0;
    const pts = dense.map((q, i) => {
      if (i) s += Math.hypot(q[0] - dense[i - 1][0], q[1] - dense[i - 1][1]);
      let f = 1;
      if (ta > 0 && s < ta) f = Math.min(f, (o.lift || 0.35) + (1 - (o.lift || 0.35)) * (s / ta));
      if (tb > 0 && s > L - tb) f = Math.min(f, (o.lift || 0.35) + (1 - (o.lift || 0.35)) * ((L - s) / tb));
      const fr = this.frac(q);
      return [+fr[0].toFixed(4), +fr[1].toFixed(4), +clamp(pressure * f, 0.03, 1).toFixed(3)];
    });
    return { type: 'stroke', tool: o.tool || 'pencil', grade, sharp: o.sharp == null ? 0.3 : o.sharp, side: o.side || 0, speed: o.speed || 160, pigments: o.pigments || { 0: 1 }, pts };
  }
  // A stroke drawn by the hand (hand.mjs): the motion is planned through
  // the path and tracked with momentum and tremor, so it lands near the path
  // and never exactly on it; the pressure follows the motion: a little
  // heavier where the hand is slow, lighter at speed, lifted at the ends.
  handStroke(ptsMM, grade, pressure, o) {
    const dense = this.resample(this.smoothPath(ptsMM, 6), 0.5);
    const m = HAND.thin(HAND.follow(dense, { speed: o.speed || 140, looseness: o.looseness == null ? 1 : o.looseness, gain: o.gain || 5, seed: o.seed || 3, overshoot: o.overshoot || 0 }), 0.4);
    return this.timedStroke(m, grade, pressure, o);
  }
  // points, times and speeds (mm, ms, mm/s) as a stroke action
  timedStroke(m, grade, pressure, o) {
    const n = m.pts.length;
    const S = [0];
    for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(m.pts[i][0] - m.pts[i - 1][0], m.pts[i][1] - m.pts[i - 1][1]));
    const L = S[n - 1] || 1, vmax = Math.max(1, ...m.speed);
    const [ta, tb] = o.taper || [Math.min(3, 0.25 * L), Math.min(4, 0.3 * L)];
    const lift = o.lift == null ? 0.35 : o.lift;
    const curve = Array.isArray(o.pressureCurve) ? o.pressureCurve : null;
    // a hand never holds one pressure: the weight swells and fades slowly
    // along the line (lost and found)
    const wv = o.weightVar == null ? 0.18 : o.weightVar, ph = ((o.seed || 1) * 0.6180339887) % 1;
    const weight = (t) => 1 + wv * (0.6 * Math.sin(6.2832 * (0.9 * t / 1000 + ph)) + 0.4 * Math.sin(6.2832 * (2.1 * t / 1000 + 2 * ph)));
    const pts = m.pts.map((q, i) => {
      const s = S[i];
      let f = weight(m.ts[i]);
      if (ta > 0 && s < ta) f = Math.min(f, lift + (1 - lift) * (s / ta));
      if (tb > 0 && s > L - tb) f = Math.min(f, lift + (1 - lift) * ((L - s) / tb));
      f *= 1.08 - 0.18 * (m.speed[i] / vmax);
      let p = pressure;
      if (curve) p = interp(curve.map((c) => c[0]), curve.map((c) => c[1]), m.ts[i]);
      const fr = this.frac(q);
      return [+fr[0].toFixed(4), +fr[1].toFixed(4), +clamp(p * f, 0.03, 1).toFixed(3)];
    });
    const out = { type: 'stroke', tool: o.tool || 'pencil', grade, sharp: o.sharp == null ? 0.3 : o.sharp, side: o.side || 0, speed: 150, pigments: o.pigments || { 0: 1 }, pts, ts: m.ts.map((t) => Math.round(t * 10) / 10) };
    if (out.tool === 'eraser') { out.eraser = o.eraser || 'vinyl'; out.eraserSize = o.eraserSize == null ? 4 : o.eraserSize; }
    return out;
  }
  // A stroke written as motion: where the hand starts, how it is moving,
  // and how it is pushed — never the curve itself. The trajectory is what
  // that motion produces (hand.mjs: momentum, a little tremor).
  //   start  [x, y] sheet (or frame) fractions
  //   v0     [vx, vy] mm/s, or {dir: degrees, speed: mm/s}   (0° = +x, 90° = down the sheet)
  //   pushes [{dir: degrees, mag: mm/s², ms}, ...] one after another, each
  //          fixed on the sheet; or {along, turn, ms}: pushed along the way
  //          the hand is already moving (along > 0 speeds up, < 0 brakes) and
  //          across it (turn > 0 bends clockwise on the sheet, to the right
  //          of travel). At speed v a turn of a mm/s² curves with radius
  //          v²/a; the two kinds mix freely. heading: degrees to push along
  //          from rest (default v0's direction, else 0).
  //   acc    [[t ms, ax, ay], ...] mm/s² keyframes, linear between
  //   coast  ms of drifting on after the last push (default 0)
  //   pressure  a number, or [[t ms, p], ...]; it lifts in and out over the ends
  //   repeat {n, step: [dx, dy] mm, vary: 0.08, jitter: 0.4, stagger: 0}  the same
  //          motion n times from starts step mm apart (hatching), each a little
  //          different; stagger mm moves each start along its heading at random
  //          (stagger_forward: only forward, so no stroke starts before the line);
  //          scale [first, last] shrinks or grows the strokes across the family
  //          (speed and push scaled, timing kept); fan degrees turns them;
  //          together: true moves the copies as one hand (one tremor) — for
  //          strokes laid side by side inside one shape, like a blade
  //   tool pencil | stump | eraser; grade or value (of the line); width (mm,
  //          the point, or how wide the eraser bears); eraser vinyl | kneaded;
  //          side (0..1); tone (with repeat): the value the area
  //          reads as with the repeats |step| mm apart
  //   aim    [x, y] where it is meant to end; not drawn — ink preview reports the miss
  gestureMotion(a, k, rnd, n = 1) {
    const vary = a.repeat && a.repeat.vary != null ? a.repeat.vary : 0.08;
    const vf = () => (k ? 1 + vary * (rnd() * 2 - 1) : 1);
    // across a family the hand can shrink (or grow) its strokes and turn them:
    // scale [first, last] scales speed and push (the same timing, a smaller
    // copy of the motion), fan rotates the whole motion by up to fan degrees
    const u = n > 1 ? k / (n - 1) : 0, R = a.repeat || {};
    const sc = Array.isArray(R.scale) ? R.scale[0] + (R.scale[1] - R.scale[0]) * u : 1, fanD = (R.fan || 0) * u;
    let acc = a.acc, accFn = null;
    if (Array.isArray(a.pushes) && a.pushes.some((p) => p.along != null || p.turn != null)) {
      // pushes relative to the hand's own heading: a function of its velocity
      const segs = [];
      let t = 0;
      for (const p of a.pushes) {
        const ms = Math.max(1, (p.ms || 100) * vf());
        const d = (((p.dir || 0) + fanD + (k ? 30 * vary * (rnd() * 2 - 1) : 0)) * Math.PI) / 180;
        segs.push({ t0: t, t1: t + ms, rel: p.along != null || p.turn != null, along: (p.along || 0) * vf() * sc, turn: (p.turn || 0) * vf() * sc * sc, ax: (p.mag || 0) * vf() * sc * Math.cos(d), ay: (p.mag || 0) * vf() * sc * Math.sin(d) });
        t += ms;
      }
      const v0d = a.v0 && !Array.isArray(a.v0) ? a.v0.dir || 0 : Array.isArray(a.v0) && Math.hypot(a.v0[0], a.v0[1]) > 1e-6 ? (Math.atan2(a.v0[1], a.v0[0]) * 180) / Math.PI : 0;
      let hd = ((((a.heading == null ? v0d : a.heading) + fanD) * Math.PI) / 180), ux = Math.cos(hd), uy = Math.sin(hd);
      accFn = (tt, vx, vy) => {
        const sp = Math.hypot(vx, vy);
        if (sp > 2) { ux = vx / sp; uy = vy / sp; }
        let i = 0;
        while (i < segs.length - 1 && tt >= segs[i].t1) i++;
        const g = segs[i];
        if (!g || tt >= g.t1) return [0, 0];
        if (!g.rel) return [g.ax, g.ay];
        return [g.along * ux - g.turn * uy, g.along * uy + g.turn * ux];
      };
      acc = [[0, 0, 0], [t, 0, 0]];
    } else if (Array.isArray(a.pushes)) {
      acc = [];
      let t = 0;
      for (const p of a.pushes) {
        const ms = Math.max(1, (p.ms || 100) * vf()), mag = (p.mag || 0) * vf() * sc, dir = (((p.dir || 0) + fanD + (k ? 3 * vary * (rnd() * 2 - 1) * 10 : 0)) * Math.PI) / 180;
        const ax = mag * Math.cos(dir), ay = mag * Math.sin(dir);
        acc.push([t, ax, ay], [t + ms - 0.5, ax, ay]);
        t += ms;
      }
      acc.push([t, 0, 0]);
    }
    if (!Array.isArray(acc) || !acc.length) throw new Error('gesture needs pushes: [{dir, mag, ms}, ...] or acc: [[t, ax, ay], ...]');
    const T = (a.duration || acc[acc.length - 1][0]) + (a.coast || 0);
    let v0 = a.v0 || [0, 0];
    if (!Array.isArray(v0)) { const d = ((v0.dir || 0) * Math.PI) / 180; v0 = [(v0.speed || 0) * Math.cos(d), (v0.speed || 0) * Math.sin(d)]; }
    const fr = (fanD * Math.PI) / 180, cf = Math.cos(fr), sf = Math.sin(fr);
    v0 = [(v0[0] * cf - v0[1] * sf) * vf() * sc, (v0[0] * sf + v0[1] * cf) * vf() * sc];
    const step = (a.repeat && a.repeat.step) || [0, 0], jit = a.repeat && a.repeat.jitter != null ? a.repeat.jitter : 0.4;
    const s0 = this.mm(pt(a.start, 'start'));
    const start = [s0[0] + step[0] * k + (k ? jit * (rnd() * 2 - 1) : 0), s0[1] + step[1] * k + (k ? jit * (rnd() * 2 - 1) : 0)];
    // stagger: each repeat starts a little ahead of or behind the others
    // along its own heading, so a family has no hard starting edge
    const sg = a.repeat && a.repeat.stagger ? a.repeat.stagger * (a.repeat.stagger_forward ? rnd() : rnd() * 2 - 1) : 0;
    if (sg) { const h0 = Math.atan2(v0[1], v0[0]) || (((a.heading || 0) * Math.PI) / 180); start[0] += sg * Math.cos(h0); start[1] += sg * Math.sin(h0); }
    // each gesture its own tremor unless a seed is given
    const seed = a.seed != null ? a.seed : Math.round(s0[0] * 7919 + s0[1] * 104729) % 100003;
    return HAND.thin(HAND.integrate({ start, v0, acc, accFn, duration: T, looseness: a.looseness == null ? 0.5 : a.looseness, seed: seed + (R.together ? 0 : 101 * k) }), 0.4);
  }
  _gesture(a) {
    const n = a.repeat ? Math.max(1, Math.min(200, a.repeat.n || 1)) : 1;
    const rnd = this.pencilRand(Object.assign({ seed: (a.seed || 5) * 7 + 3 }, a));
    const out = [];
    for (let k = 0; k < n; k++) {
      const m = this.gestureMotion(a, k, rnd, n);
      if (this.medium === 'gouache' && a.color != null && k === 0) {
        // a colour asked for by eye: mixed on the palette from the tubes
        const m = mixFor(a.color);
        a = Object.assign({}, a, { pigments: m.pigments });
        if (m.dE > 4) (this.warnings = this.warnings || []).push(`${a.label || 'gesture'}: ${a.color} is out of the palette's reach (best mix ${m.names}, ΔE ${m.dE})`);
      }
      if (this.medium !== 'pencil') {
        // brushes take the same motion
        const pts = m.pts.map((q, i) => { const fr = this.frac(q); return [+fr[0].toFixed(4), +fr[1].toFixed(4), Array.isArray(a.pressure) ? +interp(a.pressure.map((c) => c[0]), a.pressure.map((c) => c[1]), m.ts[i]).toFixed(3) : a.pressure == null ? 0.6 : a.pressure]; });
        out.push(Object.assign({ type: 'stroke', pts, ts: m.ts }, pick(a, ['tool', 'brush', 'size', 'load', 'water', 'pigments', 'marble', 'flatAngle', 'rinse'])));
        continue;
      }
      const tool = a.tool || 'pencil';
      const pf = k ? 0.85 + 0.3 * rnd() : 1;
      let grade = 'HB', pressure = typeof a.pressure === 'number' ? a.pressure : 0.6;
      if (tool === 'pencil' && a.tone != null && a.repeat && !a.grade) {
        // tone: the value the area should read as once the repeats sit
        // |step| mm apart (as hatch does: the tone table is for 1.2 mm)
        let value = this.pencilOver(num(a.tone, 'tone (L*)', 15, 95), a.over);
        const curve = this.cal && this.cal.pencil && this.cal.pencil.hatchCurve;
        if (curve && curve.length > 2) value = clamp(invert(curve.map((c) => c[0]), curve.map((c) => c[1]), value), 15, 95);
        // with the side of the lead the table is for strokes 2.2 mm apart
        const st = a.repeat.step || [1.2, 0], spacing = clamp(Math.hypot(st[0], st[1]), 0.5, 6), side = !!a.side;
        if (side && curve) value = this.pencilOver(num(a.tone, 'tone (L*)', 15, 95), a.over);
        const cover = clamp((side ? 2.2 : 1.2) / spacing, 0.3, 1.6), pl = this.paperL || 94;
        const choice = this.pencilChoose(clamp(pl - (pl - value) / cover, 15, 95), side ? 'side' : 'tone', a);
        grade = choice.grade; if (typeof a.pressure !== 'number') pressure = choice.pressure;
      } else if (tool === 'pencil') {
        const choice = a.grade ? { grade: a.grade, pressure } : this.pencilChoose(this.pencilOver(a.value == null ? 60 : a.value, a.over), a.side ? 'side' : 'line', a);
        grade = choice.grade; if (typeof a.pressure !== 'number') pressure = choice.pressure;
      }
      out.push(this.timedStroke(m, grade, pressure * pf, { tool, sharp: a.width && tool !== 'eraser' ? clamp(a.width / 2, 0.12, 1.6) : 0.3,
        eraser: a.eraser, eraserSize: tool === 'eraser' ? clamp(a.width == null ? 4 : a.width, 0.6, 30) : undefined, side: a.side || 0, taper: a.taper_mm || (tool === 'eraser' ? [0.6, 0.8] : [1.5, 4]), lift: tool === 'eraser' ? 0.5 : 0.2, pressureCurve: Array.isArray(a.pressure) ? a.pressure : null, pigments: a.pigments, seed: (a.seed || 5) + 13 * k, weightVar: a.weight_var }));
    }
    return out;
  }
  // A first, rough sketch of an outline: the path drawn in short searching
  // strokes that overlap, wander a little, overshoot their ends, and go over
  // some places twice — light enough to be drawn over.
  _rough(a) {
    const path = a.path || (a.from && a.to ? [a.from, a.to] : null);
    if (!Array.isArray(path) || path.length < 2) throw new Error('rough needs path: [[x, y], ...]');
    const dense = this.resample(this.smoothPath(path.map((q) => this.mm(pt(q, 'path point'))), 6), 0.5);
    const L = this.lengthMM(dense);
    const value = a.value == null ? 78 : a.value;
    const { grade, pressure } = this.pencilChoose(this.pencilOver(value, a.over), 'line', a);
    const rnd = this.pencilRand(a);
    const passes = a.passes || 2, piece = a.length || 26;
    const out = [];
    const sub = (s0, s1) => {
      const q = [];
      for (const p of [s0, s1]) { /* bounds */ }
      let acc = 0;
      for (let i = 0; i < dense.length; i++) {
        if (i) acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
        if (acc >= s0 && acc <= s1) q.push(dense[i]);
      }
      return q;
    };
    for (let pass = 0; pass < passes; pass++) {
      let s0 = -rnd() * piece * 0.5;
      while (s0 < L) {
        const len = piece * (0.6 + 0.8 * rnd());
        const a0 = Math.max(0, s0), a1 = Math.min(L, s0 + len);
        let q = sub(a0, a1);
        if (q.length >= 3) {
          // each searching stroke sits a little off the line
          const off = (rnd() - 0.5) * (a.wander == null ? 1.6 : a.wander);
          const d0 = q[0], d1 = q[q.length - 1], dl = Math.hypot(d1[0] - d0[0], d1[1] - d0[1]) || 1;
          const nx = -(d1[1] - d0[1]) / dl, ny = (d1[0] - d0[0]) / dl;
          q = q.map((p) => [p[0] + nx * off, p[1] + ny * off]);
          if (pass % 2) q = q.reverse();
          out.push(this.handStroke(q, grade, pressure * (0.75 + 0.45 * rnd()), { speed: 150 + 90 * rnd(), looseness: a.looseness || 3, gain: 2.6, seed: 1 + Math.floor(rnd() * 1e6), overshoot: 1 + 3 * rnd(), taper: [2, 4], lift: 0.25, sharp: 0.3, pigments: a.pigments, weightVar: 0.3 }));
        }
        s0 += len * (0.7 + 0.2 * rnd());
      }
    }
    return out;
  }
  // a hand's line through the given points (Catmull-Rom), not a polyline
  smoothPath(ptsMM, per = 6) {
    if (ptsMM.length < 3) return ptsMM;
    const out = [];
    const P = [ptsMM[0], ...ptsMM, ptsMM[ptsMM.length - 1]];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      for (let k = 0; k < per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    out.push(ptsMM[ptsMM.length - 1]);
    return out;
  }
  _pencilLine(a) {
    const path = a.path || (a.from && a.to ? [a.from, a.to] : null);
    if (!Array.isArray(path) || path.length < 2) throw new Error('line needs path: [[x, y], ...]');
    const width = a.width == null ? 0.7 : num(a.width, 'width (mm)', 0.2, 12);
    const side = width > 2.2 ? clamp((width - 2.2) / 4.5, 0, 1) : 0;
    const sharp = side ? 0.35 : clamp(width / 2, 0.12, 1.1);
    const { grade, pressure } = this.pencilChoose(this.pencilOver(num(a.value == null ? 45 : a.value, 'value (L*)', 15, 95), a.over), side ? 'side' : 'line', a);
    const taper = a.taper_mm || (a.taper ? [a.taper[0] * 10, a.taper[1] * 10] : [4, 8]);
    return [this.pencilStroke(path.map((q) => this.mm(pt(q, 'path point'))), grade, pressure, { sharp, side, taper, lift: 0.15, speed: a.speed || 120, pigments: a.pigments, hand: a.hand, looseness: a.looseness, seed: 1 + Math.floor(this.pencilRand(a)() * 1e6), weightVar: a.weight_var })];
  }
  _hatch(a) {
    const rings = this.pencilRings(a);
    let value = this.pencilOver(num(a.value == null ? 60 : a.value, 'value (L*)', 15, 95), a.over);
    // measured: what a hatching asked for at each value really comes out as;
    // ask for the value that lands on the one wanted
    const curve = this.cal && this.cal.pencil && this.cal.pencil.hatchCurve;
    if (curve && curve.length > 2 && !(a.grade && a.pressure != null) && !a.raw) value = clamp(invert(curve.map((c) => c[0]), curve.map((c) => c[1]), value), 15, 95);
    // darker tones are built in layers (cross-hatching), as a draughtsman does
    const base = a.angle == null ? 45 : a.angle;
    const nAuto = a.grade && a.pressure != null ? 1 : value < 40 ? 4 : value < 55 ? 3 : value < 70 ? 2 : 1;
    const layers = a.layers || [base, base - 90, base - 45, base + 45].slice(0, nAuto);
    // each layer carries part of the darkness (layers multiply)
    const Yt = Math.pow((value + 16) / 116, 3), Yp = Math.pow(((this.paperL || 94) + 16) / 116, 3);
    const perLayer = 116 * Math.cbrt(Yp * Math.pow(Math.min(1, Yt / Yp), 1 / layers.length)) - 16;
    const spacing = a.spacing || clamp(1.0 + (perLayer - 60) / 25, 0.9, 2.4);
    // the tone table is for 1.2 mm apart: other spacings change how much is covered
    const cover = clamp(1.2 / spacing, 0.4, 1.4);
    const eq = (this.paperL || 94) - ((this.paperL || 94) - perLayer) / cover;
    const { grade, pressure } = this.pencilChoose(clamp(eq, 15, 95), 'tone', a);
    const rnd = this.pencilRand(a);
    const out = [];
    for (const ang of layers) {
      let segs = this.pencilScan(rings, ang, spacing, rnd, a.jitter == null ? 1.2 : a.jitter);
      if (a.length) {
        // strokes of about this length (feathers, grass): each scan line cut
        // into staggered pieces with small gaps
        const cut = [];
        for (const sg of segs) {
          const d = [sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]], L = Math.hypot(d[0], d[1]);
          let t = -rnd() * a.length * 0.6;
          while (t < L) {
            const len = a.length * (0.7 + 0.6 * rnd());
            const t0 = Math.max(0, t), t1 = Math.min(L, t + len);
            if (t1 - t0 > 2) cut.push({ a: [sg.a[0] + (d[0] * t0) / L, sg.a[1] + (d[1] * t0) / L], b: [sg.a[0] + (d[0] * t1) / L, sg.a[1] + (d[1] * t1) / L] });
            t += len + 0.5 + 1.5 * rnd();
          }
        }
        segs = cut;
      }
      // a hand hatches in bursts: a run of 5-9 strokes at one slightly
      // different angle, each stroke a little off that, its ends running
      // past or stopping short of the edge
      if (a.loose !== false) {
        let burst = 0, bang = 0;
        segs = segs.map((sg) => {
          if (burst-- <= 0) { burst = 5 + Math.floor(rnd() * 5); bang = (rnd() - 0.5) * 10; }
          const da = ((bang + (rnd() - 0.5) * 5) * Math.PI) / 180;
          const mx = (sg.a[0] + sg.b[0]) / 2, my = (sg.a[1] + sg.b[1]) / 2;
          let dx = sg.b[0] - mx, dy = sg.b[1] - my;
          const c = Math.cos(da), sn = Math.sin(da);
          [dx, dy] = [c * dx - sn * dy, sn * dx + c * dy];
          const L0 = Math.hypot(dx, dy) || 1, ux = dx / L0, uy = dy / L0;
          const e0 = (rnd() - 0.45) * 2 * (a.ends == null ? 2.5 : a.ends), e1 = (rnd() - 0.45) * 2 * (a.ends == null ? 2.5 : a.ends);
          return { a: [mx - dx - ux * e0, my - dy - uy * e0], b: [mx + dx + ux * e1, my + dy + uy * e1] };
        }).filter((sg) => Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) > 1.5);
      }
      segs.forEach((sg, i) => {
        const pts = i % 2 ? [sg.b, sg.a] : [sg.a, sg.b];
        // a hand-drawn hatch line bows a little and lifts at its ends
        const m = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], d = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], Ld = Math.hypot(d[0], d[1]) || 1;
        const bow = (a.bow == null ? 0.012 : a.bow) * Ld;
        const mid = [m[0] - (d[1] / Ld) * bow, m[1] + (d[0] / Ld) * bow];
        out.push(this.pencilStroke([pts[0], mid, pts[1]], grade, pressure * (0.85 + 0.3 * rnd()), { sharp: a.sharp == null ? 0.3 : a.sharp, taper: [Math.min(1.5, 0.15 * Ld), Math.min(6, 0.45 * Ld)], lift: 0.3, speed: (a.speed || 280) * (0.8 + 0.4 * rnd()), pigments: a.pigments, hand: a.hand, looseness: a.looseness == null ? 1.4 : a.looseness, gain: 4, seed: 1 + Math.floor(rnd() * 1e6), overshoot: 0.5 + 1.5 * rnd(), weightVar: 0.12 }));
      });
    }
    return out;
  }
  _tone(a) {
    const rings = this.pencilRings(a);
    const { grade, pressure } = this.pencilChoose(this.pencilOver(num(a.value == null ? 70 : a.value, 'value (L*)', 15, 95), a.over), 'side', a);
    const rnd = this.pencilRand(a);
    const segs = this.pencilScan(rings, a.angle == null ? 25 : a.angle, a.spacing || 2.2, rnd, 0.6);
    const out = segs.map((sg, i) => this.pencilStroke(i % 2 ? [sg.b, sg.a] : [sg.a, sg.b], grade, pressure, { side: a.side == null ? 0.75 : a.side, sharp: 0.35, taper: [2, 2], lift: 0.5, speed: a.speed || 320, pigments: a.pigments }));
    if (a.blend) out.push(...this._blend(Object.assign({}, a, { angle: (a.angle == null ? 25 : a.angle) + 90, strength: a.blend === true ? 0.75 : a.blend })));
    return out;
  }
  _blend(a) {
    const rings = this.pencilRings(a);
    const rnd = this.pencilRand(a);
    const segs = this.pencilScan(rings, a.angle == null ? 0 : a.angle, a.spacing || 1.8, rnd, 0.4);
    return segs.map((sg, i) => this.pencilStroke(i % 2 ? [sg.b, sg.a] : [sg.a, sg.b], 'HB', a.strength == null ? 0.75 : a.strength, { tool: 'stump', sharp: a.sharp == null ? 1.6 : a.sharp, taper: [1, 1], lift: 0.6, speed: 200 }));
  }
  _erase(a) {
    if (a.path) return [Object.assign(this.pencilStroke(a.path.map((q) => this.mm(pt(q, 'path point'))), 'HB', a.strength == null ? 0.8 : a.strength, { tool: 'eraser', taper: [0, 0], speed: 150 }), { eraser: a.eraser || 'vinyl', eraserSize: a.width == null ? 2.4 : a.width })];
    const rings = this.pencilRings(a);
    const segs = this.pencilScan(rings, a.angle == null ? 0 : a.angle, a.spacing || 1.6, this.pencilRand(a), 0);
    return segs.map((sg, i) => Object.assign(this.pencilStroke(i % 2 ? [sg.b, sg.a] : [sg.a, sg.b], 'HB', a.strength == null ? 0.8 : a.strength, { tool: 'eraser', taper: [0, 0], speed: 150 }), { eraser: a.eraser || 'vinyl', eraserSize: a.width == null ? 2.4 : a.width }));
  }

  // ---------------------------------------------------------- codebook
  book() {
    const cb = typeof this.codebook === 'function' ? (this.codebook = this.codebook()) : this.codebook;
    if (!cb) throw new Error('no stroke codebook for this medium and paper yet (ink codebook build <run>)');
    return cb;
  }
  pigs(a) { return a.pigments || (this.medium === 'ink' ? { 0: 1 } : null) || { 0: 1 }; }

  // one entry, its mark's start put on `from` and its end on `to`
  codeMark(a, id) {
    const cb = this.book();
    const k = cb.byId.get(id);
    if (k == null) throw new Error(`no codebook entry ${id}`);
    const e = cb.entries[k];
    const A = this.mm(pt(a.from, 'from')), B = a.to ? this.mm(pt(a.to, 'to')) : null;
    const ang = B ? Math.atan2(B[1] - A[1], B[0] - A[0]) : ((a.angle || 0) * Math.PI) / 180;
    const span = Math.max(0.5, e.d.x1 - e.d.x0);
    const scale = B ? clamp(Math.hypot(B[0] - A[0], B[1] - A[1]) / span, 0.8, 1.25) : 1;
    const c = Math.cos(ang), sn = Math.sin(ang);
    // the gesture's origin sits x0 (scaled) behind the mark's start
    const pose = { x: A[0] - c * e.d.x0 * scale, y: A[1] - sn * e.d.x0 * scale, angle: ang, mirror: !!a.mirror, scale };
    return CB.placeGesture(e.g, pose, this.sheetMM, this.pigs(a));
  }

  // The mark a fit asks for, as a codebook target (sheet mm).
  fitTarget(a) {
    // a target measured already (sheet mm): { pts, w, v, cov }
    if (a.target) { const t = CB.makeTarget(a.target.pts, a.target.w, a.target.v, a.target.cov); return t; }
    const path = a.path || (a.from && a.to ? [a.from, a.to] : null);
    if (!Array.isArray(path) || path.length < 2) throw new Error('fit needs path: [[x, y], ...] (the mark\'s centreline)');
    let ptsMM = path.map((q) => this.mm(pt(q, 'path point')));
    let w = a.widths || null, v = a.values || null, cov = a.coverage;
    const measure = a.width == null && !a.widths;
    if (measure || a.value == null && !a.values) {
      if (!this.profile) throw new Error('fit: give width and value, or a target to measure them from');
      const pr = this.profile(path, a.extend);
      if (measure) { w = pr.w; ptsMM = pr.pts; if (cov == null) cov = pr.cov; }
      if (a.value == null && !a.values) v = pr.v;
    }
    const t0 = CB.makeTarget(ptsMM, w || 1, v || 50, cov);
    if (!w) t0.w = CB.taperedWidths(t0.len, a.width, a.ends || [Math.min(12, 0.3 * t0.len), Math.min(15, 0.35 * t0.len)]);
    if (!v) t0.v = new Array(CB.P).fill(a.value);
    t0.wMean = t0.w.reduce((x, y) => x + y, 0) / CB.P || 1;
    return t0;
  }

  // Candidates for a fit: the k nearest marks, each aligned to the target,
  // and their interpolation. Returns [{ label, actions, match }].
  fitCandidates(a, n) {
    const cb = this.book();
    const t = this.fitTarget(a);
    const k = a.k || n || 8;
    const opts = { direction: a.direction === 'forward' ? 'forward' : a.direction === 'reverse' ? 'reverse' : 'either', weights: a.weights, sizes: a.sizes, kinds: a.kinds || ['stroke'] };
    const ms = cb.nearest(t, Math.max(k, 32), opts);
    if (!ms.length) throw new Error('fit: nothing in the codebook matches');
    const place = (g, d, m, mirror) => {
      const tp = m.reversed ? t.pts.slice().reverse() : t.pts;
      const pose = CB.alignPose({ d }, mirror, tp);
      return { actions: CB.placeGesture(g, pose, this.sheetMM, this.pigs(a)), pose };
    };
    const out = [];
    const seen = new Set();
    // interpolations around the best few matches (each with its own size and
    // direction), then the matches themselves
    for (const lead of ms.slice(0, 3)) {
      const pool = [lead, ...ms.filter((m) => m !== lead)];
      for (const kk of [3, 6]) {
        const B = CB.blendMatches(pool, kk);
        const key = B.from.map((f) => f.id).join(',');
        if (B.from.length < 2 || seen.has(key)) continue;
        seen.add(key);
        const r = place(B.g, B.d, lead, B.flip ? !lead.mirror : lead.mirror);
        out.push({ label: `blend of ${B.from.length} around ${lead.entry.id} (${key})`, actions: r.actions, match: { blend: B.from, d: +lead.d.toFixed(3), rms: +r.pose.rms.toFixed(2), g: B.g } });
      }
      const S = lead.entry.g.kind === 'stroke' ? CB.solveMatches(pool, lead.reversed ? CB.reverseTarget(t) : t) : null;
      if (S) {
        const r = place(S.g, S.d, lead, S.flip ? !lead.mirror : lead.mirror);
        out.push({ label: `solved around ${lead.entry.id} (from ${S.from.length})`, actions: r.actions, match: { solve: S.from, d: +lead.d.toFixed(3), rms: +r.pose.rms.toFixed(2), g: S.g } });
      }
    }
    ms.slice(0, k).forEach((m, i) => {
      const r = place(m.entry.g, m.entry.d, m, m.mirror);
      out.push({ label: `#${i + 1} code ${m.entry.id}${m.reversed ? ' reversed' : ''}${m.mirror ? ' mirrored' : ''} (d ${m.d.toFixed(2)})`, actions: r.actions, match: { id: m.entry.id, d: +m.d.toFixed(3), rms: +r.pose.rms.toFixed(2), g: m.entry.g } });
    });
    // the hand-made library's own answers for the same mark, so a fit is
    // never worse than writing a line or a blade
    if (a.library !== false) {
      const fr = t.pts.map((q) => this.frac(q).map((x) => +x.toFixed(4)));
      const sorted = t.w.slice().sort((x, y) => x - y), wMed = sorted[Math.floor(CB.P / 2)], wMax = sorted[CB.P - 2];
      const vDark = t.v.slice().sort((x, y) => x - y)[3];
      const jMax = t.w.indexOf(Math.max(...t.w));
      const lib = [
        [`library line ${wMed.toFixed(1)} mm L${Math.round(vDark)}`, { stroke: 'line', path: [fr[0], fr[8], fr[16], fr[CB.P - 1]], width: +wMed.toFixed(1), value: Math.round(vDark) }],
        // a blade grows from its base (the wider end) to its tip
        [`library blade ${wMax.toFixed(1)} mm`, jMax < CB.P / 2 ? { stroke: 'blade', from: fr[0], to: fr[CB.P - 1], width: +wMax.toFixed(1), value: Math.round(vDark) } : { stroke: 'blade', from: fr[CB.P - 1], to: fr[0], width: +wMax.toFixed(1), value: Math.round(vDark) }],
      ];
      for (const [label, b] of lib) {
        try { out.push({ label, actions: this['_' + b.stroke](Object.assign({ type: 'lib' }, b)).map((x) => Object.assign({ label }, x)), match: { library: b.stroke } }); } catch {}
      }
    }
    return { target: t, candidates: out };
  }

  _fit(a) {
    const r = this.fitCandidates(a, a.k || 6);
    const mode = a.mode || 'blend';
    const c = mode === 'nearest' ? r.candidates.find((x) => x.match.id != null) : r.candidates[0];
    return c.actions;
  }
  _code() { throw new Error('use "stroke": "code:<id>"'); }

  savedRecipe(a, name) {
    const r = this.saved && this.saved[name];
    if (!r) throw new Error(`no saved stroke "${name}" (have: ${Object.keys(this.saved || {}).join(', ') || 'none'})`);
    const A0 = this.mm(r.from), A1 = this.mm(r.to);
    const B0 = this.mm(a.from || r.from), B1 = this.mm(a.to || (a.from ? [a.from[0] + r.to[0] - r.from[0], a.from[1] + r.to[1] - r.from[1]] : r.to));
    const va = [A1[0] - A0[0], A1[1] - A0[1]], vb = [B1[0] - B0[0], B1[1] - B0[1]];
    const la = Math.hypot(...va) || 1, lb = Math.hypot(...vb) || 1;
    const k = lb / la, th = Math.atan2(vb[1], vb[0]) - Math.atan2(va[1], va[0]);
    const cs = Math.cos(th) * k, sn = Math.sin(th) * k;
    const T = (p) => { const q = this.mm(p), x = q[0] - A0[0], y = q[1] - A0[1]; const o = this.frac([B0[0] + x * cs - y * sn, B0[1] + x * sn + y * cs]); return p.length > 2 ? [+o[0].toFixed(4), +o[1].toFixed(4), p[2]] : [+o[0].toFixed(4), +o[1].toFixed(4)]; };
    const deg = (th * 180) / Math.PI;
    return JSON.parse(JSON.stringify(r.actions)).map((x) => {
      if (x.pts) x.pts = x.pts.map(T);
      if (x.at) x.at = T(x.at);
      if (x.poly) x.poly = x.poly.map(T);
      if (x.rings) x.rings = x.rings.map((ring) => ring.map(T));
      if (x.rect) { const [x0, y0, x1, y1] = x.rect; x.poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(T); delete x.rect; }
      if (x.type === 'dab') { x.angle = (x.angle || 0) + deg; if (x.length) x.length *= k; }
      if (x.type === 'wash' && x.angle != null) x.angle += deg;
      if (a.value != null && x.load != null && r.value != null) x.load = +clamp(x.load * (this.paperL - a.value) / Math.max(1, this.paperL - r.value), 0.01, 0.95).toFixed(3);
      return Object.assign(x, { label: a.label || x.label || name });
    });
  }
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }
function pigmentKey(p) {
  if (p == null) return 0;
  if (typeof p === 'number') return p;
  if (typeof p === 'object' && !Array.isArray(p)) { const ks = Object.keys(p); return ks.length === 1 && /^\d+$/.test(ks[0]) ? +ks[0] : null; }
  return null;
}
function num(v, name, lo, hi) {
  if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new Error(`${name} must be a number in ${lo}..${hi} (got ${JSON.stringify(v)})`);
  return v;
}
function pt(p, name) {
  if (!Array.isArray(p) || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) throw new Error(`${name} must be [x, y] in sheet fractions`);
  return p;
}

// ------------------------------------------------------------ calibration
// Sheets of test strokes painted raw (no compensation) on scrap and
// measured: widths and end lags per size × pressure, value per load for
// each kind of mark, and how much of a blade's path the mark covers.
export function calibrationSheets(medium) {
  const ink = medium === 'ink';
  const brush = ink ? 'fude' : 'round';
  const pig = { 0: 1 };
  const sheets = [];
  const grid = (sizes, pressures, name) => {
    const acts = [], cells = [];
    sizes.forEach((size, r) => pressures.forEach((p, c) => {
      const x0 = 0.03 + c * 0.24, y = 0.09 + r * 0.235;
      const path = [[x0 + 0.075, y], [x0 + 0.205, y]];
      acts.push({ type: 'lib', stroke: 'line', raw: true, path, width: 1, value: 50, size, pressure: p, load: 0.5, brush, pigments: pig, label: `w s${size} p${p}` });   // natural texture
      cells.push({ kind: 'width', size, pressure: p, axis: path, box: [x0, y - 0.11, x0 + 0.24, y + 0.11] });
    }));
    sheets.push({ name, actions: acts, cells });
  };
  const P = [0.3, 0.45, 0.6, 0.8];
  grid([0, 1, 2, 3], P, 'widths-small');
  grid([4, 5, 6, 8], P, 'widths-large');
  // values: lines, dry-brush, bands at loads; blades at size × press; mist
  {
    const acts = [], cells = [];
    const loads = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.85];
    loads.forEach((ld, i) => {
      const x = 0.05 + i * 0.1;
      const lp = [[x, 0.05], [x, 0.3]];
      acts.push({ type: 'lib', stroke: 'line', raw: true, path: lp, width: 1, value: 50, size: 2, pressure: 0.5, load: ld, brush, pigments: pig, label: `line ${ld}` });
      cells.push({ kind: 'value', mark: 'line', load: ld, axis: lp, box: [x - 0.045, 0.02, x + 0.045, 0.33] });
      const dp = [[x, 0.37], [x, 0.6]];
      acts.push({ type: 'lib', stroke: 'drybrush', raw: true, path: dp, width: 1, value: 50, size: 3, pressure: 0.5, load: ld, brush, pigments: pig, label: `dry ${ld}` });
      cells.push({ kind: 'value', mark: 'drybrush', load: ld, axis: dp, box: [x - 0.045, 0.34, x + 0.045, 0.63] });
    });
    [0.03, 0.05, 0.08, 0.12, 0.18, 0.26].forEach((ld, i) => {
      const y = 0.68 + i * 0.05;
      acts.push({ type: 'lib', stroke: 'band', raw: true, x0: 0.05, x1: 0.45, y, width: 1, value: 50, size: 5, pressure: 0.4, load: ld, brush, pigments: pig, label: `band ${ld}` });
      cells.push({ kind: 'value', mark: 'band', load: ld, axis: [[0.05, y], [0.45, y]], box: [0.02, y - 0.022, 0.48, y + 0.022] });
    });
    [0.005, 0.01, 0.02, 0.035].forEach((ld, i) => {
      const x0 = 0.52 + (i % 2) * 0.24, y0 = 0.68 + Math.floor(i / 2) * 0.16;
      const rect = [x0, y0, x0 + 0.18, y0 + 0.1];
      acts.push({ type: 'wash', tool: 'water', rect: [x0 - 0.015, y0 - 0.015, x0 + 0.195, y0 + 0.115], brush: 'fude', size: 9, water: 0.8, spacing: 0.55, label: `mist pre-wet` });
      acts.push({ type: 'wash', tool: 'brush', rect, brush: 'fude', size: 9, load: ld, water: 0.6, pressure: 0.45, speed: 400, spacing: 0.8, pigments: pig, label: `mist ${ld}` });
      cells.push({ kind: 'value', mark: 'mist', load: ld, axis: [[x0 + 0.03, y0 + 0.05], [x0 + 0.15, y0 + 0.05]], box: [x0 + 0.03, y0 + 0.02, x0 + 0.15, y0 + 0.08], area: true });
    });
    sheets.push({ name: 'values', actions: acts, cells });
  }
  {
    const acts = [], cells = [];
    const sizes = ink ? [2, 3, 4, 6] : [3, 4, 6, 8], presses = [0.45, 0.6, 0.75];
    sizes.forEach((size, r) => presses.forEach((press, c) => {
      const x0 = 0.05 + c * 0.32, y = 0.15 + r * 0.22;
      const from = [x0, y], len = 60;
      acts.push({ type: 'dab', at: from, angle: 0, length: len, press, brush, size, load: 0.45, water: 0.26, speed: 560, pigments: pig, label: `blade s${size} p${press}` });
      cells.push({ kind: 'blade', size, press, axis: [from, [x0 + len / 304.8, y]], box: [x0 - 0.02, y - 0.1, x0 + 0.3, y + 0.1] });
    }));
    // wash values for the lib's wash (region fill)
    sheets.push({ name: 'blades', actions: acts, cells });
  }
  return sheets;
}

// A well-spaced sampler of every library stroke, asked for in mark space:
// painted after the raw calibration to measure what is still off (and kept
// as the library's visual reference).
export function verificationSheet(medium) {
  const ink = medium === 'ink';
  const pig = ink ? { 0: 1 } : { 4: 1 };
  const V = (v) => (ink ? v : Math.min(90, v + 10));
  const a = [];
  const xr = [[0.05, 0.27], [0.38, 0.6], [0.71, 0.93]];
  // lines: widths at L40, then values at 3 mm
  [1.5, 3, 6].forEach((w, i) => a.push({ type: 'lib', stroke: 'line', label: `line ${w}mm L${V(40)}`, path: [[xr[i][0], 0.06], [(xr[i][0] + xr[i][1]) / 2, 0.075], [xr[i][1], 0.06]], width: w, value: V(40), pigments: pig }));
  [[3, 78], [3, 55], [6, 28]].forEach(([w, v], i) => a.push({ type: 'lib', stroke: 'line', label: `line ${w}mm L${v}`, path: [[xr[i][0], 0.15], [xr[i][1], 0.15]], width: w, value: v, pigments: pig }));
  // the darkest marks a painting needs: wide, near-black
  [[5, 20, 0], [9, 14, 1]].forEach(([w, v, i]) => a.push({ type: 'lib', stroke: 'line', label: `line ${w}mm L${v}`, path: [[xr[i][0], 0.205], [xr[i][1], 0.205]], width: w, value: v, pigments: pig }));
  // dry-brush pale and dark
  [[4, 0, 75], [5, 1, 45]].forEach(([w, i, v]) => a.push({ type: 'lib', stroke: 'drybrush', label: `drybrush ${w}mm L${v}`, path: [[xr[i][0], 0.29], [xr[i][1], 0.27]], width: w, value: V(v), pigments: pig }));
  // dabs pale and dark
  a.push({ type: 'lib', stroke: 'dab', label: 'dab 16mm L78', at: [0.76, 0.28], length: 16, width: 3.5, angle: 0, value: V(78), pigments: pig });
  a.push({ type: 'lib', stroke: 'dab', label: 'dab 16mm L35', at: [0.9, 0.28], length: 16, width: 5, angle: 0, value: V(35), pigments: pig });
  // blades: widths at L40, and a pale one
  [[4, 0.05, 40], [8, 0.25, 40], [12, 0.45, 40], [6, 0.65, 80]].forEach(([w, x, v]) => a.push({ type: 'lib', stroke: 'blade', label: `blade ${w}mm L${v}`, from: [x, 0.56], to: [x + 0.1, 0.38], width: w, value: V(v), curve: 0.15, pigments: pig }));
  a.push({ type: 'lib', stroke: 'dab', label: 'dab 20mm L55', at: [0.88, 0.47], length: 20, width: 5, angle: 70, value: V(55), pigments: pig });
  // bands pale → mid
  [[89, 0.64], [84, 0.7], [78, 0.76]].forEach(([v, y]) => a.push({ type: 'lib', stroke: 'band', label: `band L${v}`, x0: 0.05, x1: 0.3, y, width: 3, value: v, pigments: pig }));
  a.push({ type: 'lib', stroke: 'stack', label: 'stack', at: [0.45, 0.64], count: 5, lengths: [26, 8], width: 3, value: V(80), pigments: pig });
  a.push({ type: 'lib', stroke: 'mist', label: 'mist L90', rect: [0.62, 0.63, 0.95, 0.77], value: 90, pigments: pig });
  a.push({ type: 'lib', stroke: 'wash', label: 'wash L70', rect: [0.06, 0.86, 0.5, 0.96], value: V(70), pigments: pig });
  return a;
}

// Residual errors per kind of mark from a measured verification sheet.
export function residuals(sheet, measured, prev) {
  const by = {};
  for (const r of measured) {
    if (!r.found) continue;
    const a = sheet[r.i];
    const kind = a.stroke === 'dab' ? 'dab' : a.stroke;
    (by[kind] = by[kind] || []).push({ r, a });
  }
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
  const out = JSON.parse(JSON.stringify(prev || {}));
  for (const [kind, list] of Object.entries(by)) {
    const o = out[kind] || { start: 0, end: 0, width: 1, dark: [] };
    // geometry: damped, outliers dropped, and never from dry-brush (its mark
    // is broken into streaks, so its measured ends and width mean little)
    const geom = kind !== 'drybrush';
    const DAMP = 0.7, sane = (v) => Number.isFinite(v) && Math.abs(v) < 20;
    if (geom) {
      const ss = kind === 'blade' ? list.map(({ r, a }) => r.a * lenMM(a.from, a.to)) : list.map(({ r }) => r.start_mm);
      const es = kind === 'blade' ? list.map(({ r, a }) => (1 - r.b) * lenMM(a.from, a.to)) : list.map(({ r }) => r.end_mm);
      const s1 = ss.filter(sane), e1 = es.filter(sane);
      if (s1.length) o.start = clamp(o.start + DAMP * med(s1), -15, 15);
      if (e1.length) o.end = clamp(o.end + DAMP * med(e1), -15, 15);
    }
    if (geom) o.width *= med(list.map(({ r, a }) => (a.width ? clamp(r.width_mm / a.width, 0.5, 2) : 1))) || 1;
    // width by darkness: heavy ink spreads wider than the load-0.5 width table
    const wpts = {};
    for (const { r, a } of list) {
      if (!geom || !a.width || a.value == null || !(r.width_mm > 0)) continue;
      const key = Math.round(Math.max(1, 95 - a.value) / 10) * 10;
      (wpts[key] = wpts[key] || []).push(clamp(r.width_mm / a.width, 0.5, 2.5));
    }
    const wcurve = (o.wdark || []).map((q) => q.slice());
    for (const [key, fs] of Object.entries(wpts)) {
      const D = +key, f = med(fs);
      const i = wcurve.findIndex((q) => q[0] === D);
      if (i >= 0) wcurve[i][1] = +clamp(wcurve[i][1] * f, 0.5, 2.5).toFixed(3); else wcurve.push([D, +f.toFixed(3)]);
    }
    wcurve.sort((p, q) => p[0] - q[0]);
    o.wdark = wcurve;
    // darkness curve: at each asked darkness, multiply the correction by
    // wanted/measured (points merged by darkness, so pale and dark marks of
    // the same kind get their own factors)
    const paperL = 95;
    const pts = {};
    for (const { r, a } of list) {
      if (a.value == null || !Number.isFinite(r.L)) continue;
      const Dw = Math.max(1, paperL - a.value), Dm = Math.max(0.5, paperL - r.L);
      const key = Math.round(Dw / 5) * 5;
      (pts[key] = pts[key] || []).push(clamp(Dw / Dm, 0.33, 3));
    }
    const curve = (o.dark || []).map((q) => q.slice());
    for (const [key, fs] of Object.entries(pts)) {
      const D = +key, f = med(fs);
      const i = curve.findIndex((q) => Math.abs(q[0] - D) < 2.5);
      const prevF = i >= 0 ? curve[i][1] : curve.length ? interp(curve.map((q) => q[0]).sort((x, y) => x - y), curve.slice().sort((x, y) => x[0] - y[0]).map((q) => q[1]), D) : 1;
      const nf = clamp(prevF * f, 0.75, 1.35);
      if (i >= 0) curve[i][1] = +nf.toFixed(3); else curve.push([D, +nf.toFixed(3)]);
    }
    curve.sort((p, q) => p[0] - q[0]);
    out[kind] = { start: +o.start.toFixed(2), end: +o.end.toFixed(2), width: +o.width.toFixed(3), dark: curve, wdark: o.wdark };
  }
  return out;
}
const lenMM = (A, B) => Math.hypot((B[0] - A[0]) * 304.8, (B[1] - A[1]) * 228.6);

// Turn measurements into the tables the Library reads.
export function fitCalibration(measured, meta) {
  const cal = Object.assign({ version: 1, created: new Date().toISOString() }, meta);
  const W = measured.filter((m) => m.kind === 'width' && m.found);
  cal.width = {
    sizes: [...new Set(W.map((m) => m.size))].sort((a, b) => a - b),
    rows: W.map((m) => ({ size: m.size, pressure: m.pressure, width: m.width_mm, start: m.start_mm, end: m.end_mm, L: m.L })),
  };
  const V = measured.filter((m) => m.kind === 'value' && m.found);
  cal.value = {};
  for (const mark of ['line', 'drybrush', 'band', 'mist']) {
    const rows = V.filter((m) => m.mark === mark).map((m) => ({ load: m.load, L: m.L })).sort((a, b) => a.load - b.load);
    // keep the table monotone (darker with load) so it can be inverted
    for (let i = 1; i < rows.length; i++) rows[i].L = Math.min(rows[i].L, rows[i - 1].L - 0.05);
    if (rows.length) cal.value[mark] = { rows, ref: mark === 'line' ? { size: 2, pressure: 0.5 } : mark === 'drybrush' ? { size: 3, pressure: 0.5 } : null };
  }
  if (cal.value.line) { cal.value.blade = cal.value.line; cal.value.wash = cal.value.line; }
  const B = measured.filter((m) => m.kind === 'blade' && m.found);
  cal.blade = { rows: B.map((m) => ({ size: m.size, press: m.press, width: m.width_mm, a: m.a, b: m.b, L: m.L })) };
  return cal;
}
