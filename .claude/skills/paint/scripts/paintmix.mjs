// Palette mixing for gouache: which paints, in what proportions, make a
// colour. Mixtures follow Kubelka–Munk with the simulation's own pigment
// coefficients (js/pigments.js), predicted as a layer thick enough to hide
// what is under it. A painter mixes from few tubes, so mixes of one to three
// colours (plus white) are searched and a simpler mix wins unless a richer
// one is clearly closer.
//
//   import { mixFor, predict } from './paintmix.mjs'
//   mixFor('#c4683a')            → { pigments: {0: 0.18, 5: 0.52, 7: 0.3}, rgb, dE }
//   mixFor([L, a, b])            (CIE L*a*b*)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let LIB = null;
function lib() {
  if (LIB) return LIB;
  const root = path.resolve(HERE, '../../../..');
  const ctx = { window: {}, Math };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js', 'pigments.js'), 'utf8'), ctx);
  LIB = ctx.window.WC_PIGMENTS;
  return LIB;
}
export function pigments() { return lib().PALETTES.gouache; }

const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const gam = (c) => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
export function lab(rgb) {
  const [r, g, b] = rgb.map(lin);
  let X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b, Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, bb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [r, g, bb].map(gam);
}
// CIEDE2000-lite: CIE94 with textile-free weights is close enough here
export function dE(p, q) {
  const dL = p[0] - q[0];
  const C1 = Math.hypot(p[1], p[2]), C2 = Math.hypot(q[1], q[2]), dC = C1 - C2;
  const da = p[1] - q[1], db = p[2] - q[2];
  const dH2 = Math.max(0, da * da + db * db - dC * dC);
  const sC = 1 + 0.045 * C1, sH = 1 + 0.015 * C1;
  return Math.sqrt(dL * dL + (dC / sC) ** 2 + dH2 / (sH * sH));
}

// sRGB of a fully hiding layer of a mix (fractions per pigment index)
export function predict(fr) {
  const P = pigments();
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let K = 0, S = 0;
    for (let i = 0; i < P.length; i++) if (fr[i]) { K += fr[i] * P[i].K[c]; S += fr[i] * P[i].S[c]; }
    const k = K / Math.max(S, 1e-6);
    out[c] = gam(1 + k - Math.sqrt(k * k + 2 * k));
  }
  return out;
}

function parseColour(c) {
  if (typeof c === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) throw new Error(`colour "${c}" is not #rrggbb`);
    const n = parseInt(m[1], 16);
    return lab([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }
  if (Array.isArray(c) && c.length === 3) return c[0] <= 100 && Math.abs(c[1]) <= 128 && Math.abs(c[2]) <= 128 && !(c[0] > 100) && c.some((v) => v < 0 || v % 1) ? c : lab(c);
  if (c && typeof c === 'object' && c.L != null) return [c.L, c.a || 0, c.b || 0];
  throw new Error('colour is "#rrggbb", [r, g, b] (0..255), or {L, a, b}');
}

const cache = new Map();
// The mix (≤ maxN colours besides white) whose masstone is closest to the
// target; each extra colour must buy at least `simpler` ΔE.
export function mixFor(colour, o = {}) {
  const T = Array.isArray(colour) && colour.length === 3 && o.lab ? colour : parseColour(colour);
  const key = T.map((v) => v.toFixed(1)).join(',') + '|' + (o.maxN || 3) + '|' + (o.avoid || []).join(',');
  if (cache.has(key)) return cache.get(key);
  const P = pigments(), n = P.length, maxN = o.maxN || 3, simpler = o.simpler == null ? 0.8 : o.simpler;
  const avoid = new Set(o.avoid || []);
  const chroma = [...Array(n).keys()].filter((i) => i > 0 && !avoid.has(i));
  const combos = [];
  const rec = (start, cur) => {
    if (cur.length) combos.push(cur.slice());
    if (cur.length === maxN) return;
    for (let i = start; i < chroma.length; i++) { cur.push(chroma[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  combos.push([]);   // white alone
  let best = null;
  for (const combo of combos) {
    const ids = [0, ...combo];
    // optimise weights on the simplex: log-weights, coordinate search from
    // a few starts (each colour leading, and white leading)
    const cost = (lw) => {
      const e = lw.map(Math.exp), s = e.reduce((a, b) => a + b, 0);
      const fr = new Array(n).fill(0);
      ids.forEach((id, k) => { fr[id] = e[k] / s; });
      return dE(lab(predict(fr)), T);
    };
    let w = null, c0 = Infinity;
    for (let lead = -1; lead < ids.length; lead++) {
      let v = ids.map((_, k) => (lead < 0 ? 0 : k === lead ? 2 : -1));
      let cv = cost(v), step = 2.0;
      for (let it = 0; it < 80 && step > 0.01; it++) {
        let improved = false;
        for (let k = 0; k < ids.length; k++) for (const d of [step, -step]) {
          const t = v.slice(); t[k] = Math.max(-12, Math.min(12, t[k] + d));   // a colour may drop out entirely
          const c = cost(t);
          if (c < cv - 1e-6) { v = t; cv = c; improved = true; }
        }
        if (!improved) step *= 0.5;
      }
      if (cv < c0) { c0 = cv; w = v; }
      if (ids.length === 1) break;
    }
    // round to a tenth of a percent (a touch of black matters), drop what
    // rounds away, and judge the mix as it will actually be made
    const e = w.map(Math.exp), s = e.reduce((a, b) => a + b, 0);
    const pig = {};
    ids.forEach((id, k) => { const r = Math.round((1000 * e[k]) / s) / 1000; if (r > 0) pig[id] = r; });
    const fr = new Array(n).fill(0);
    for (const [k, v] of Object.entries(pig)) fr[+k] = v;
    const t = fr.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) fr[i] /= t;
    const err = dE(lab(predict(fr)), T);
    const used = Object.keys(pig).filter((k) => +k !== 0).length;
    const score = err + simpler * used;
    if (!best || score < best.score) best = { score, pig, fr, dE: err };
  }
  const pig = best.pig;
  const rgb = predict(best.fr).map((v) => Math.round(v));
  const out = { pigments: pig, rgb, dE: +best.dE.toFixed(2), names: Object.keys(pig).map((k) => `${P[+k].short} ${+(pig[k] * 100).toFixed(1)}%`).join(' + ') };
  cache.set(key, out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const c of process.argv.slice(2)) {
    const t0 = Date.now();
    const m = mixFor(c);
    console.log(c, '→', m.names, `rgb(${m.rgb})`, 'ΔE', m.dE, `${Date.now() - t0} ms`);
  }
}
