// GLSL for the watercolor simulation.
//
// State lives in float textures at simulation resolution:
//   W    (w, s, salt, set)   surface water depth, water held in the paper's
//                            fibres, salt crystals, how "set" the dried paint is
//   F    (right, left, up, down)  outflow through each cell wall (virtual pipes)
//   G0/1 pigment suspended in the surface water, 8 pigments in two vec4s
//   D0/1 pigment settled onto the paper
//
// One simulation step = flux → water → pigment. Brush input is splatted
// into accumulation buffers and folded in by the apply pass once per frame.
(function () {
  'use strict';

  const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  const NOISE = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd(ivec2 p, uint seed) {
  uvec2 u = uvec2(p + 1048576);
  return float(pcg(u.x ^ pcg(u.y ^ seed))) * (1.0 / 4294967295.0);
}
vec2 rnd2(ivec2 p, uint seed) {
  uvec2 u = uvec2(p + 1048576);
  uint h = pcg(u.x ^ pcg(u.y ^ seed));
  return vec2(float(h), float(pcg(h))) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, uint seed) {
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rnd(i, seed), b = rnd(i + ivec2(1, 0), seed);
  float c = rnd(i + ivec2(0, 1), seed), d = rnd(i + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, uint seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int k = 0; k < 5; k++) {
    s += a * vnoise(p, seed + uint(k) * 101u);
    n += a;
    p = m * p + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s / n;
}
vec2 worley(vec2 p, uint seed) {
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      vec2 r = vec2(o) + rnd2(i + o, seed) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return sqrt(vec2(d1, d2));
}
`;

  // Conductance of the paper surface across each cell edge: long, thin pulp
  // fibres make some paths far easier than others, which is what turns a
  // soft wet-in-wet bleed into a feathered one and gives blooms their
  // ragged fronts. The fibres curve, run in two felted layers, and use two
  // incommensurate noise octaves so the value-noise lattice never shows up
  // as a regular period. Computed once per sheet into a texture.
  const FS_FIBRE = HEAD + NOISE + `
uniform ivec2 uSize;
uniform vec2 uStretch;     // fibre length and width scale (per cell)
uniform float uContrast;   // 0: felted rag paper, 1: long-fibred xuan
out vec4 o;
float fibre(vec2 m) {
  vec2 w = vec2(vnoise(m * 0.03, 81u), vnoise(m * 0.03 + 11.0, 83u)) - 0.5;
  m += w * 18.0;
  float t1 = vnoise(m * 0.019, 71u) * 6.2832, t2 = vnoise(m * 0.015 + 40.0, 73u) * 6.2832 + 1.3;
  vec2 d1 = vec2(cos(t1), sin(t1)), d2 = vec2(cos(t2), sin(t2));
  vec2 a = vec2(dot(m, d1), dot(m, vec2(-d1.y, d1.x))) * uStretch;
  vec2 b = vec2(dot(m, d2), dot(m, vec2(-d2.y, d2.x))) * uStretch;
  float fa = 0.62 * vnoise(a, 61u) + 0.38 * vnoise(a * vec2(1.618, 1.414) + 7.7, 62u);
  float fb = 0.62 * vnoise(b + 17.0, 67u) + 0.38 * vnoise(b * vec2(1.618, 1.414) + 3.1, 68u);
  float f = smoothstep(0.32, 0.82, max(fa, fb));
  return mix(0.25 + 1.9 * f * f, 0.03 + 5.5 * f * f * f, uContrast);
}
void main() {
  vec2 p = gl_FragCoord.xy - 0.5;
  o = vec4(fibre(p + vec2(0.5, 0.0)), fibre(p + vec2(0.0, 0.5)), 0.0, 0.0);   // +x edge, +y edge
}
`;

  // fibre conductance on the edge from p toward neighbour k (+x, -x, +y, -y)
  const FIB = `
uniform sampler2D uFibre;
float fibreEdge(ivec2 p, int k) {
  if (k == 0) return texelFetch(uFibre, p, 0).x;
  if (k == 1) return texelFetch(uFibre, p - ivec2(1, 0), 0).x;
  if (k == 2) return texelFetch(uFibre, p, 0).y;
  return texelFetch(uFibre, p - ivec2(0, 1), 0).y;
}
`;

  const VS_TRI = HEAD + `
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  // ---------------------------------------------------------------- paper
  // Height field in millimetres of sheet space. Cold and rough press are
  // felt-blanket bumps (cellular noise, domain-warped) plus pulp fibres.
  const PAPER_FN = `
uniform int uType;   // 0 hot press, 1 cold press, 2 rough, 3 xuan, 4 bristol, 5 drawing, 6 toothy, 7 board, 8 canvas
float fiberField(vec2 p) {
  float s = 0.0;
  for (int k = 0; k < 5; k++) {
    float a = float(k) * 2.39996 + 0.3;
    vec2 d = vec2(cos(a), sin(a));
    vec2 q = vec2(dot(p, d), dot(p, vec2(-d.y, d.x))) * vec2(1.1, 7.5);
    float n = vnoise(q + float(k) * 31.7, 7u + uint(k));
    n = 1.0 - abs(n * 2.0 - 1.0);
    n = n * n; n = n * n * n;
    s += n;
  }
  return clamp(s * 0.55, 0.0, 1.0);
}
// Raw (unnormalised) heights. tooth is the felt-bump relief alone, without
// fibres or fine grain: it is what granulating pigment settles into and
// what shapes a wash's edge. Normalisation happens in a second pass using
// statistics read back from the sim-resolution sheet.
float paperHeight(vec2 p, out float tooth) {
  float fib = fiberField(p);
  float fine = fbm(p * 3.2, 11u);
  if (uType == 3) {
    // xuan: thin, nearly flat, laid from long bast fibres that show
    float lo = fbm(p * 0.5, 5u);
    vec2 d = vec2(0.94, 0.34);
    vec2 q = vec2(dot(p, d), dot(p, vec2(-d.y, d.x)));
    float longF = vnoise(q * vec2(0.35, 5.0) + fbm(p * 0.2, 9u) * 3.0, 19u);
    longF = pow(1.0 - abs(longF * 2.0 - 1.0), 8.0);
    tooth = lo;
    return 0.3 * lo + 0.2 * fine + 0.5 * fib + 0.45 * longF;
  }
  if (uType == 7) {
    // illustration board: a hard, smooth hot-pressed surface with only a
    // faint grain, for gouache
    float grain = 0.55 * vnoise(p * 3.4, 81u) + 0.25 * vnoise(p * 7.1 + 2.2, 83u) + 0.2 * fbm(p * 1.1, 85u);
    float lo = fbm(p * 0.2, 87u);
    tooth = 0.6 * grain + 0.4 * lo;
    return 0.35 * grain + 0.65 * lo + 0.05 * fib;
  }
  if (uType == 8) {
    // primed cotton canvas: warp and weft about 0.6 mm apart passing over
    // and under each other, the gesso rounding the weave and partly filling
    // its hollows
    vec2 q = p / 0.6 + (vec2(fbm(p * 0.35, 91u), fbm(p * 0.35 + 9.0, 93u)) - 0.5) * 0.7;
    vec2 f = fract(q) - 0.5;
    vec2 ci = floor(q);
    float up = mod(ci.x + ci.y, 2.0);
    float across = cos(3.14159 * f.x), along = 0.55 + 0.45 * cos(3.14159 * f.y);
    float across2 = cos(3.14159 * f.y), along2 = 0.55 + 0.45 * cos(3.14159 * f.x);
    float w = up > 0.5 ? across * along : across2 * along2;
    float slub = 0.85 + 0.3 * vnoise(vec2(ci.x * 0.37, p.y * 0.08), 95u);   // uneven thread thickness
    w = pow(clamp(w * slub, 0.0, 1.0), 0.7);
    float fine = 0.5 * vnoise(p * 6.0, 97u) + 0.5 * vnoise(p * 11.0 + 4.0, 99u);
    tooth = 0.8 * w + 0.2 * fine;
    return 0.75 * w + 0.15 * fine + 0.1 * fbm(p * 0.3, 101u);
  }
  if (uType >= 4) {
    // drawing papers: a fine, even tooth of pressed pulp (a few tenths of a
    // mm) with hardly any relief beyond it: 4 bristol (smooth), 5 drawing,
    // 6 toothy, with the laid lines of a mould-made sheet
    float grain = 0.5 * vnoise(p * 3.1, 61u) + 0.3 * vnoise(p * 5.7 + 3.3, 63u) + 0.2 * fbm(p * 1.3, 65u);
    float lo = fbm(p * 0.25, 67u);
    float laid = uType == 6 ? pow(0.5 + 0.5 * cos(p.y * 6.2832 / 1.05 + 0.4 * sin(p.x * 0.3)), 6.0) : 0.0;
    if (uType == 4) { tooth = 0.35 * grain + 0.65 * lo; return 0.25 * grain + 0.75 * lo + 0.15 * fib; }
    tooth = 0.85 * grain + 0.25 * laid;
    return 0.8 * grain + 0.15 * lo + 0.12 * fib + 0.3 * laid;
  }
  if (uType == 0) {
    float lo = fbm(p * 0.7, 5u);
    tooth = lo;
    return 0.5 * lo + 0.5 * fine + 0.35 * fib;
  }
  float sc = uType == 1 ? 0.62 : 0.34;
  vec2 warp = vec2(fbm(p * 0.3, 21u), fbm(p * 0.3 + 31.0, 23u)) - 0.5;
  vec2 q = p * sc + warp * 2.2;
  float b1 = 1.0 - smoothstep(0.0, 1.15, worley(q, 3u).x);
  float b2 = 1.0 - smoothstep(0.0, 1.1, worley(q * 1.85 + 7.0, 9u).x);
  float mid = fbm(q * 1.4 + 3.0, 15u);
  float t = uType == 1
    ? 0.46 * b1 + 0.26 * b2 + 0.28 * mid
    : 0.56 * b1 + 0.22 * b2 + 0.22 * mid;
  tooth = t;
  return t + (uType == 1 ? 0.12 * fine + 0.08 * fib : 0.09 * fine + 0.05 * fib);
}
`;

  // Simulation-resolution paper, raw: (height, pinning noise, sizing noise, tooth)
  const FS_PAPER_RAW = HEAD + NOISE + PAPER_FN + `
uniform vec2 uMM;
uniform ivec2 uRes;
out vec4 o;
void main() {
  vec2 cell = uMM / vec2(uRes);
  vec2 base = gl_FragCoord.xy * cell;
  float h = 0.0, tooth = 0.0, t;
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      h += paperHeight(base + (vec2(i, j) - 0.5) * 0.5 * cell, t);
      tooth += t;
    }
  float pin = 0.65 * vnoise(base * 0.55, 41u) + 0.35 * vnoise(base * 1.3 + 9.0, 43u) + 0.1 * fiberField(base);
  float sizing = fbm(base * 0.05, 51u);
  o = vec4(h * 0.25, pin, sizing, tooth * 0.25);
}
`;

  // Normalised sim paper: (height 0-1, pinning 0-1, sizing ~0.6-1.4, tooth 0-1)
  const FS_PAPER_NORM = HEAD + `
uniform sampler2D uSrc;
uniform vec4 uNorm0, uNorm1;   // (h mean, h sd, tooth mean, tooth sd), (pin mean, sd, sizing mean, sd)
uniform vec2 uGrain;           // how pronounced this paper's tooth and edge noise are
out vec4 o;
void main() {
  vec4 r = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  float h = clamp(0.5 + 0.19 * (r.x - uNorm0.x) / uNorm0.y, 0.0, 1.0);
  float t = clamp(0.5 + 0.19 * uGrain.x * (r.w - uNorm0.z) / uNorm0.w, 0.0, 1.0);
  float pin = clamp(0.5 + 0.17 * uGrain.y * (r.y - uNorm1.x) / uNorm1.y, 0.0, 1.0);
  float sz = 1.0 + 0.16 * clamp((r.z - uNorm1.z) / uNorm1.w, -2.5, 2.5);
  o = vec4(h, pin, sz, t);
}
`;

  // Display-resolution paper, pass 1: raw height and tooth
  const FS_PAPER_HI1 = HEAD + NOISE + PAPER_FN + `
uniform vec2 uMM;
uniform ivec2 uRes;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy * (uMM / vec2(uRes));
  float tooth;
  float h = paperHeight(p, tooth);
  o = vec4(h, tooth, 0.0, 0.0);
}
`;

  // pass 2: normalise, and slope (per mm) for relief lighting
  const FS_PAPER_HI2 = HEAD + `
uniform sampler2D uSrc;
uniform ivec2 uRes;
uniform vec2 uMM;
uniform vec4 uNorm0;
uniform vec2 uGrain;
out vec4 o;
float H(ivec2 q) { return 0.5 + 0.19 * (texelFetch(uSrc, clamp(q, ivec2(0), uRes - 1), 0).x - uNorm0.x) / uNorm0.y; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 px = uMM / vec2(uRes);
  float dx = (H(p + ivec2(1, 0)) - H(p - ivec2(1, 0))) / (2.0 * px.x);
  float dy = (H(p + ivec2(0, 1)) - H(p - ivec2(0, 1))) / (2.0 * px.y);
  float t = clamp(0.5 + 0.19 * uGrain.x * (texelFetch(uSrc, p, 0).y - uNorm0.z) / uNorm0.w, 0.0, 1.0);
  o = vec4(clamp(H(p), 0.0, 1.0), dx, dy, t);
}
`;

  // ---------------------------------------------------------------- flux
  // Virtual-pipe shallow water: flow is driven by differences in water
  // surface height (paper relief + board tilt + water depth), keeps some
  // momentum, and is throttled in thin films (viscous drag grows as the
  // film thins). Water only advances onto dry paper when its head beats a
  // pinning threshold that varies with the fibres, so edges stay put and
  // come out ragged the way real washes do. Damp paper pins far less,
  // which is what lets a fresh drop race into a drying wash (a bloom).
  const FS_FLUX = HEAD + FIB + `
uniform sampler2D uW, uFlux, uPaper, uG0, uG1;
uniform ivec2 uSize;
uniform vec2 uTilt;
uniform float uPaperAmp, uFlowK, uDamp, uPinT, uMobW, uWetEps, uCap, uMarangoni, uVisc, uWick, uWickDry;
out vec4 oFlux;

float conc(ivec2 q, float w) {
  if (w < uWetEps) return 0.0;
  vec4 a = texelFetch(uG0, q, 0) + texelFetch(uG1, q, 0);
  return (a.x + a.y + a.z + a.w) / w;
}

bool inside(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y; }

// How much of a dry cell's 3x3 neighbourhood is already wet. A dry cell
// beside a straight edge scores ~2.2, one at the tip of a finger ~1, one in a
// notch ~4. Scaling the pinning threshold by it stands in for surface
// tension: contact lines stay round instead of growing lattice spikes.
float support(ivec2 q) {
  float s = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 r = q + ivec2(i, j);
      if (!inside(r)) continue;
      float wgt = (i == 0 || j == 0) ? 1.0 : 0.6;
      s += texelFetch(uW, r, 0).x >= uPinT * 0.2 ? wgt : 0.0;
    }
  return s;
}

ivec2 p0;

float pipe(float fOld, float H0, float w0, float c0, ivec2 q, int k) {
  if (!inside(q)) return 0.0;
  vec4 Wq = texelFetch(uW, q, 0);
  vec4 Pq = texelFetch(uPaper, q, 0);
  float Hq = Pq.w * uPaperAmp + dot(uTilt, vec2(q)) + Wq.x;
  float dh = H0 - Hq;
  // momentum only survives in deep water; thin films are viscous
  float f = fOld * uDamp * (w0 * w0 / (w0 * w0 + 0.0064)) + uFlowK * dh;
  if (Wq.x < uPinT * 0.2 && Wq.z <= 0.0) {
    float capq = uCap * (0.75 + 0.5 * Pq.x);
    // damp fibres wick water in readily: this is what lets a drop race
    // outward into a drying wash and push its pigment into a bloom
    float damp = smoothstep(0.06, 0.4, Wq.y / capq);
    float thr = uPinT * mix(1.0, 0.1, damp) * (0.6 + 0.8 * Pq.y);
    if (dh < thr) {
      f = 0.0;
    } else {
      // advancing onto dry paper: only the head in excess of the threshold
      // drives the front, and tips advance slower than notches
      float sup = support(q);
      float curv = pow(clamp(2.2 / max(sup, 0.5), 0.55, 3.0), 1.2);
      f = uFlowK * max(0.0, dh - thr * curv) * clamp(sup / 2.2, 0.3, 1.4);
    }
    // Damp fibres are already wetted, so water creeps onto them as a thin
    // film without needing any head at all. Following the fibres, this is
    // what drives the ragged, cauliflower front of a bloom.
    f += min((uWick * damp * damp + uWickDry) * max(0.0, w0 - uPinT * 0.35) * fibreEdge(p0, k), 0.2 * w0);
  } else {
    // Marangoni: paint carries gum arabic, which lowers surface tension,
    // so pigment-laden water is pulled out toward clearer water.
    f += uMarangoni * max(0.0, c0 - conc(q, Wq.x)) * min(w0, Wq.x) * fibreEdge(p0, k);
  }
  return max(f, 0.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p0 = p;
  vec4 W0 = texelFetch(uW, p, 0);
  float w = W0.x;
  if (w <= 1e-6) { oFlux = vec4(0.0); return; }
  vec4 P0 = texelFetch(uPaper, p, 0);
  float H0 = P0.w * uPaperAmp + dot(uTilt, vec2(p)) + w;
  float c0 = conc(p, w);
  vec4 f0 = texelFetch(uFlux, p, 0);
  vec4 f = vec4(
    pipe(f0.x, H0, w, c0, p + ivec2(1, 0), 0),
    pipe(f0.y, H0, w, c0, p - ivec2(1, 0), 1),
    pipe(f0.z, H0, w, c0, p + ivec2(0, 1), 2),
    pipe(f0.w, H0, w, c0, p - ivec2(0, 1), 3));
  f *= (w * w) / (w * w + uMobW * uMobW);
  f *= 1.0 / (1.0 + uVisc * c0);   // thick paint (lots of pigment and gum) is viscous
  float tot = f.x + f.y + f.z + f.w;
  float lim = w * 0.98;
  if (tot > lim) f *= lim / tot;
  oFlux = f;
}
`;

  // ---------------------------------------------------------------- water
  // Moves surface water by the new fluxes, soaks some into the paper,
  // wicks damp water through the fibres, and evaporates. Evaporation is
  // faster along a wet edge (more exposed surface), which draws water and
  // pigment outward: the coffee-ring that gives watercolor its dark rims.
  const FS_WATER = HEAD + `
uniform sampler2D uW, uFlux, uPaper;
uniform ivec2 uSize;
uniform float uWetEps, uCap, uAbsorb, uEvap, uEdgeEvap, uEvapCap, uCapDiff, uCapT;
uniform float uSaltRate, uSetRate, uLoosen, uDryS;
out vec4 oW;

bool inside(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W0 = texelFetch(uW, p, 0);
  vec4 P0 = texelFetch(uPaper, p, 0);
  vec4 f0 = texelFetch(uFlux, p, 0);
  float w = W0.x - (f0.x + f0.y + f0.z + f0.w);
  float s0 = W0.y;
  float cap0 = uCap * (0.75 + 0.5 * P0.x);
  float dryN = 0.0, sDryN = 0.0, wetAround = 0.0;
  float ds = 0.0;
  const ivec2 D[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + D[k];
    if (!inside(q)) continue;
    vec4 fq = texelFetch(uFlux, q, 0);
    w += k == 0 ? fq.y : k == 1 ? fq.x : k == 2 ? fq.w : fq.z;
    vec4 Wq = texelFetch(uW, q, 0);
    vec4 Pq = texelFetch(uPaper, q, 0);
    dryN += Wq.x < uWetEps ? 1.0 : 0.0;
    sDryN += Wq.y < uDryS * 3.0 ? 1.0 : 0.0;
    wetAround += (Wq.x >= uWetEps || Wq.y > uDryS * 3.0) ? 1.0 : 0.0;
    float pair = 0.5 * (P0.y + Pq.y);
    float gate = step(uCapT * (0.5 + pair), max(s0, Wq.y));
    float kd = min(uCapDiff * (0.35 + 0.65 * 0.25 * (P0.y + Pq.y + P0.z + Pq.z)), 0.2);   // < 0.25 keeps explicit diffusion stable
    ds += kd * gate * (Wq.y - s0);
  }
  w = max(w, 0.0);
  float s = max(s0 + ds, 0.0);

  float absorb = min(w, uAbsorb * P0.z * max(0.0, cap0 - s));
  w -= absorb;
  s += absorb;

  if (w > 0.0) w = max(0.0, w - uEvap * (1.0 + uEdgeEvap * dryN));
  // damp paper dries fastest at the edge of the damp zone, which draws the
  // water held in the sheet outward (and anything it carries with it)
  if (w < uWetEps) s = max(0.0, s - uEvapCap * (1.0 + 1.5 * sDryN));

  float salt = W0.z;
  if (salt > 0.0) {
    float take = min(w, uSaltRate * salt);
    float takeS = min(s, uSaltRate * salt * 0.6);
    w -= take;
    s -= takeS;
    salt = max(0.0, salt - (take + takeS) * 0.035);
    if (w < uWetEps && s < uDryS * 3.0 && wetAround < 0.5) salt = 0.0;
  }

  float setF = W0.w;
  if (w < uWetEps && s < uDryS) setF += (1.0 - setF) * uSetRate;
  else if (w >= uWetEps) setF -= setF * uLoosen;

  oW = vec4(w, s, salt, setF);
}
`;

  // ---------------------------------------------------------------- pigment
  // Carries suspended pigment with the water (upwind, mass-conserving),
  // lets it diffuse inside wet regions, and trades it with the paper:
  // heavy pigments settle quickly and into the valleys (granulation),
  // staining pigments hold on, flowing water scours fresh deposits back up.
  // When a cell's water is gone, whatever pigment it carried is left behind.
  const FS_PIGMENT = HEAD + NOISE + FIB + `
uniform sampler2D uW, uWn, uFlux, uG0, uG1, uD0, uD1, uPaper;
uniform ivec2 uSize;
uniform vec4 uRho0, uRho1, uOmega0, uOmega1, uGam0, uGam1;
uniform float uWetEps, uDepRate, uDepThin, uLiftRate, uShear, uPigDiff, uSaltRate, uStrand, uFilter;
layout(location = 0) out vec4 oG0;
layout(location = 1) out vec4 oG1;
layout(location = 2) out vec4 oD0;
layout(location = 3) out vec4 oD1;
#ifdef FINES
// Fines: the finest carbon and glue, which ride the water through the sheet
// ahead of the ink and strand where that water evaporates, leaving a pale
// halo with a faint tide line at its edge. Tracked for the first four
// pigment slots (the sumi inks, indigo and ochre).
uniform sampler2D uFN;
uniform float uFines, uCapDiff, uCapT, uEvapCap, uDryS;
layout(location = 4) out vec4 oFN;
#endif

bool inside(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W0 = texelFetch(uW, p, 0);
  float w = W0.x;
  vec4 f0 = texelFetch(uFlux, p, 0);
  vec4 g0 = texelFetch(uG0, p, 0), g1 = texelFetch(uG1, p, 0);
  vec4 P0 = texelFetch(uPaper, p, 0);
  float outF = f0.x + f0.y + f0.z + f0.w;
  float keep = w > 1e-7 ? clamp(1.0 - outF / w, 0.0, 1.0) : 1.0;
  vec4 n0 = g0 * keep, n1 = g1 * keep;
  float wt = w - outF;
  bool wet = w > uWetEps;
  vec4 c0 = wet ? g0 / w : vec4(0.0), c1 = wet ? g1 / w : vec4(0.0);
  const ivec2 D[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  vec4 caught0 = vec4(0.0), caught1 = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + D[k];
    if (!inside(q)) continue;
    float wq = texelFetch(uW, q, 0).x;
    vec4 fq = texelFetch(uFlux, q, 0);
    float fin = k == 0 ? fq.y : k == 1 ? fq.x : k == 2 ? fq.w : fq.z;
    wt += fin;
    vec4 gq0 = texelFetch(uG0, q, 0), gq1 = texelFetch(uG1, q, 0);
    if (fin > 0.0 && wq > 1e-7) {
      // on absorbent paper the water travels through the fibres, which
      // catch a little of the carbon at every step, so ink fades out
      // behind the wetting front instead of stopping at a hard edge
      float r = min(fin / wq, 1.0);
      // dense ink clogs the fibres and is strained out close to the
      // stroke; dilute ink runs on with the water toward the front
      float cq = dot(gq0 + gq1, vec4(1.0)) / wq;
      float filt = uFilter * (0.25 + 0.75 * smoothstep(0.5, 4.0, cq));
      n0 += gq0 * r * (1.0 - filt);
      n1 += gq1 * r * (1.0 - filt);
      caught0 += gq0 * r * filt;
      caught1 += gq1 * r * filt;
    }
    if (wet && wq > uWetEps) {
      // conductance varies smoothly with the fibres; symmetric, so conservative
      float e = 0.5 * (P0.y + texelFetch(uPaper, q, 0).y);
      float wm = min(w, wq);
      float kd = uPigDiff * wm * (wm / (wm + 0.035)) * (0.3 + 1.2 * e * e) * fibreEdge(p, k);
      kd = min(kd, 0.2 * wm);
      n0 += kd * (gq0 / wq - c0);
      n1 += kd * (gq1 / wq - c1);
    }
  }
  n0 = max(n0, 0.0);
  n1 = max(n1, 0.0);

  // salt drinks the water around it, and the pigment that water carried
  float salt = W0.z;
  float fr = salt > 0.0 ? clamp(uSaltRate * salt / max(wt, 1e-5), 0.0, 1.0) : 0.0;
  n0 *= 1.0 - fr;
  n1 *= 1.0 - fr;
  float wr = wt * (1.0 - fr);

  vec4 d0 = texelFetch(uD0, p, 0), d1 = texelFetch(uD1, p, 0) + caught1;
#ifndef FINES
  d0 += caught0;
#endif
  vec4 Wn = texelFetch(uWn, p, 0);
  float wn = Wn.x;
  if (wn < uWetEps) {
    d0 += n0; d1 += n1;
    n0 = vec4(0.0); n1 = vec4(0.0);
  } else {
    // pigment stranded by the water that evaporated or soaked in this step
    float strand = clamp((wr - wn) / max(wr, 1e-5), 0.0, 1.0) * uStrand;
#ifdef FINES
    caught0 += n0 * strand;   // what soaks into the sheet, sorted below
#else
    d0 += n0 * strand;
#endif
    n0 *= 1.0 - strand;
    d1 += n1 * strand; n1 *= 1.0 - strand;
    float h = P0.w;
    float thin = uDepThin / (uDepThin + wn);
    float shear = 1.0 + uShear * min(outF / max(w, 1e-4), 0.25);
    float lift = uLiftRate * (1.0 - 0.96 * Wn.w) * shear;
    vec4 dn0 = n0 * (1.0 - 0.45 * h * uGam0) * uRho0 * (uDepRate * thin);
    vec4 dn1 = n1 * (1.0 - 0.45 * h * uGam1) * uRho1 * (uDepRate * thin);
    vec4 up0 = d0 * (1.0 - 0.45 * (1.0 - h) * uGam0) / uOmega0 * lift;
    vec4 up1 = d1 * (1.0 - 0.45 * (1.0 - h) * uGam1) / uOmega1 * lift;
    n0 += up0 - dn0; d0 += dn0 - up0;
    n1 += up1 - dn1; d1 += dn1 - up1;
  }
#ifdef FINES
  // of the ink the fibres strain out, most stays put; the fines go into
  // the water held in the sheet
  vec4 fn = texelFetch(uFN, p, 0);
  vec4 fnN = fn + caught0 * uFines;
  d0 += caught0 * (1.0 - uFines);
  // carried by the same capillary exchange the water pass applies
  float s0 = W0.y, sEdge = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + D[k];
    if (!inside(q)) continue;
    float sq = texelFetch(uW, q, 0).y;
    vec4 Pq = texelFetch(uPaper, q, 0);
    float gate = step(uCapT * (0.5 + 0.5 * (P0.y + Pq.y)), max(s0, sq));
    float kd = min(uCapDiff * (0.35 + 0.65 * 0.25 * (P0.y + Pq.y + P0.z + Pq.z)), 0.2);
    float e = kd * gate * (sq - s0);
    sEdge += sq < uDryS * 3.0 ? 1.0 : 0.0;
    if (e > 0.0) fnN += texelFetch(uFN, q, 0) * (e / max(sq, 1e-5));
    else fnN += fn * (e / max(s0, 1e-5));
  }
  fnN = max(fnN, 0.0);
  // stranded as the sheet's water evaporates: fastest where it is thinnest,
  // which is the edge of the damp zone, so the fines pile up into a line
  float sN = Wn.y;
  float frS = sN < uDryS ? 1.0 : (wn < uWetEps ? clamp(uEvapCap * (1.0 + 1.5 * sEdge) / max(sN, 1e-5), 0.0, 1.0) : 0.0);
  d0 += fnN * frS;
  fnN *= 1.0 - frS;
  oFN = fnN;
#endif
  oG0 = max(n0, 0.0);
  oG1 = max(n1, 0.0);
  oD0 = max(d0, 0.0);
  oD1 = max(d1, 0.0);
}
`;

  // ---------------------------------------------------------------- brush
  // Instanced dabs splatted additively into four accumulation targets.
  const VS_STAMP = HEAD + `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;  // x, y, radius, angle        (capsule: x0, y0, radius at x0, radius at x1)
layout(location = 2) in vec4 iB;  // target water, strength, contact, seed
layout(location = 3) in vec4 iC;  // pigment concentration 0-3
layout(location = 4) in vec4 iD;  // pigment concentration 4-7
layout(location = 5) in vec4 iE;  // vx, vy, thirst, dryness
layout(location = 6) in vec4 iF;  // salt, shape, x1, y1 (capsule end)
uniform vec2 uSize;
out vec2 vLocal;
flat out vec4 vB, vC, vD, vE, vF;
flat out vec2 vSeg, vDir, vRad;
void main() {
  vB = iB; vC = iC; vD = iD; vE = iE; vF = iF;
  vDir = vec2(1.0, 0.0);
  vec2 world;
  if ((iF.y > 3.5 && iF.y < 4.5) || iF.y > 5.5) {
    // a bristle tuft lying on the paper (or a pencil's contact moving):
    // a capsule from (x0, y0) to (x1, y1)
    vec2 A = iA.xy, B = iF.zw;
    vec2 d = B - A;
    float len = length(d);
    vec2 t = len > 1e-4 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-t.y, t.x);
    float m = max(max(iA.z, iA.w), 0.6) + 1.0;
    vec2 local = vec2(mix(-m, len + m, aCorner.x * 0.5 + 0.5), aCorner.y * m);
    world = A + t * local.x + n * local.y;
    vLocal = local;
    vSeg = vec2(len, max(iA.z, 0.5));
    vRad = vec2(iA.z, iA.w);
    vDir = t;
  } else {
    float ext = 1.2;
    float r = max(iA.z, 0.9);
    vec2 q = aCorner * ext;
    float c = cos(iA.w), s = sin(iA.w);
    world = iA.xy + mat2(c, s, -s, c) * (q * r);
    vLocal = q * (r / max(iA.z, 0.01));
    vSeg = vec2(0.0);
    vRad = vec2(0.0);
  }
  gl_Position = vec4(world / uSize * 2.0 - 1.0, 0.0, 1.0);
}
`;

  const FS_STAMP = HEAD + NOISE + `
uniform sampler2D uPaper, uSeal;
uniform float uSealGlyph;   // 1 when uSeal holds rendered characters
uniform float uHair;        // how much a drying tuft follows its hairs rather than the paper grain
uniform float uPaintHair;   // gouache: how much the film a tuft leaves varies with its hairs (ridges and furrows)
uniform float uPaintEdge;   // gouache: where a tuft's footprint begins to soften
in vec2 vLocal;
flat in vec4 vB, vC, vD, vE, vF;
flat in vec2 vSeg, vDir, vRad;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  vec2 q = vLocal;
  float d = length(q);
  float shape = vF.y;
  float h = texelFetch(uPaper, ivec2(gl_FragCoord.xy), 0).x;
  float seed = vB.w;
  if (shape > 1.5 && shape < 2.5) {
    // salt grain: a small faceted crystal
    float a = atan(q.y, q.x);
    float facet = 0.8 + 0.2 * vnoise(vec2(a * 1.6 + seed * 40.0, seed * 9.0), 13u);
    float g = 1.0 - smoothstep(facet - 0.25, facet, d);
    o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0);
    o3 = vec4(g * vF.x, 0.0, 0.0, 0.0);
    return;
  }
  if (shape > 4.5) {
    // carved seal (hanko), white-text style: paste everywhere but the cut
    // strokes, pressed unevenly so the paste breaks up at the edges
    vec2 u = q;
    float inBox = 1.0 - smoothstep(0.9, 0.96, max(abs(u.x), abs(u.y)));
    float cut = 0.0;
    if (uSealGlyph > 0.5) {
      // characters cut by hand: the edges wander a little
      vec2 st = u / 0.9 * 0.5 + 0.5;
      st += (vec2(vnoise(u * 9.0 + seed * 20.0, 31u), vnoise(u * 9.0 + 7.0, 37u)) - 0.5) * 0.014;
      cut = smoothstep(0.35, 0.65, texture(uSeal, vec2(st.x, 1.0 - st.y)).r);
    } else for (int k = 0; k < 7; k++) {
      float fk = float(k);
      float a = rnd(ivec2(k, 1), uint(seed * 997.0));
      float b = rnd(ivec2(k, 2), uint(seed * 997.0));
      float c = rnd(ivec2(k, 3), uint(seed * 997.0));
      vec2 lo = vec2(-0.7) + vec2(a, b) * 1.1, hi = lo + (c > 0.5 ? vec2(0.08, 0.35 + 0.3 * a) : vec2(0.35 + 0.3 * b, 0.08));
      lo.x += fk < 3.5 ? -0.05 : 0.1;
      vec2 m1 = step(lo, u) * step(u, min(hi, vec2(0.78)));
      cut = max(cut, m1.x * m1.y);
    }
    float press = smoothstep(0.15, 0.55, vnoise(u * 7.0 + seed * 30.0, 23u) * 0.7 + vnoise(u * 23.0, 29u) * 0.3 + 0.2);
    float cov0 = inBox * (1.0 - cut) * press * vB.y;
    o0 = vec4(cov0 * vB.x, 0.0, 0.0, cov0);
    o1 = cov0 * vC; o2 = cov0 * vD;
    o3 = vec4(0.0);
    return;
  }
  float cov;
  if (shape > 3.5) {
    // bristle tuft: distance to the segment. Running dry, hairs gather into
    // clumps: the tufts of a clump keep ink along the same lines across the
    // stroke (fixed to the position across the direction of travel, so the
    // lines run unbroken along it), with gaps between clumps and between
    // hairs — a dry stroke breaks into streaks along its length (kasure),
    // not into dots. The paper's peaks still modulate it.
    float px = clamp(q.x, 0.0, vSeg.x);
    float rr = max(mix(vRad.x, vRad.y, vSeg.x > 1e-4 ? px / vSeg.x : 0.0), 0.5);   // the radius tapers from one end to the other
    float dd = length(vec2(q.x - px, q.y)) / rr;
    float fp = 1.0 - smoothstep(uPaintHair > 0.0 ? uPaintEdge : 0.55, 1.0, dd);   // body colour holds a crisper edge than a wash
    float contact = vB.z;
    float w = dot(gl_FragCoord.xy, vec2(-vDir.y, vDir.x));   // across the stroke, in cells
    float u = dot(gl_FragCoord.xy, vDir);                      // along it
    // the whole brush shares one arrangement of hairs across the stroke (a
    // new one each time it is loaded), so every tuft covering a line leaves
    // the same gaps; clumps add a little of their own
    float sseed = floor(vE.w) / 997.0, clump = fract(vE.w);
    // hairs skip and pick up again: the lines drift and break slowly along the stroke
    float wd = w + 1.5 * (vnoise(vec2(u * 0.03 + sseed * 11.0, sseed * 5.0), 47u) - 0.5);
    float hair = vnoise(vec2(wd * 0.12 + sseed * 23.0, sseed * 7.0 + 1.0), 41u) * 0.45   // between clumps, ~2.5 mm
               + vnoise(vec2(wd * 0.45 + sseed * 57.0, 3.0), 43u) * 0.3                  // between hairs, ~0.7 mm
               + vnoise(vec2(wd * 0.45 + sseed * 13.0, u * 0.08), 53u) * 0.1             // a hair lifting for a moment
               + vnoise(vec2(wd * 0.3 + clump * 31.0, clump * 9.0), 59u) * 0.15;         // this clump's own
    hair = smoothstep(0.2, 0.8, hair);
    float gate = mix(h, hair, uHair);
    float cm = contact >= 0.999 ? 1.0 : smoothstep(1.0 - contact - 0.1, 1.0 - contact + 0.06, gate);
    cov = fp * cm * vB.y;
    if (uPaintHair > 0.0) {
      // paint lies thicker where hairs bunch and thinner between them
      float ridge = vnoise(vec2(wd * 0.9 + sseed * 71.0, u * 0.015), 61u) * 0.6 + hair * 0.4;
      o0 = vec4(cov * vB.x * (1.0 + uPaintHair * (ridge - 0.5) * 2.0), cov * vE.z, 0.0, cov);
      o1 = cov * vC;
      o2 = cov * vD;
      o3 = vec4(0.0, cov * vE.x, cov * vE.y, 0.0);
      return;
    }
  } else if (shape > 2.5) {
    // lifting sponge / tissue: soft, uneven pressure
    float blot = 0.75 + 0.25 * vnoise(q * 2.2 + seed * 40.0, 21u);
    cov = (1.0 - smoothstep(0.25, 1.0, d)) * blot * vB.y;
  } else if (shape > 0.5) {
    // droplet from spatter: a round bead with a slightly lumpy rim
    float a = atan(q.y, q.x);
    float rim = 1.0 + 0.12 * (vnoise(vec2(a * 2.0 + seed * 50.0, seed * 7.0), 17u) - 0.5);
    cov = (1.0 - smoothstep(0.86 * rim, rim, d)) * vB.y;
  } else {
    // round brush: bristle streaks across the stroke, a ragged rim, and
    // contact only with the paper's peaks as the brush runs dry
    float dry = vE.w;
    float bristle = vnoise(vec2(q.y * 5.5 + seed * 97.0, seed * 13.0), 3u) * 0.65
                  + vnoise(vec2(q.y * 13.0 + seed * 31.0, seed * 5.0), 4u) * 0.35;
    float a = atan(q.y, q.x);
    float rim = 1.0 + 0.07 * (vnoise(vec2(a * 2.5 + seed * 23.0, 1.0), 6u) - 0.5);
    float fp = 1.0 - smoothstep(0.8 * rim, rim, d);
    float streak = mix(1.0, smoothstep(0.30 + 0.25 * dry, 0.52 + 0.2 * dry, bristle), dry);
    float contact = vB.z;
    float cm = contact >= 0.999 ? 1.0 : smoothstep(1.0 - contact - 0.1, 1.0 - contact + 0.06, h);
    cov = fp * streak * cm * vB.y;
  }
  o0 = vec4(cov * vB.x, cov * vE.z, 0.0, cov);
  o1 = cov * vC;
  o2 = cov * vD;
  o3 = vec4(0.0, cov * vE.x, cov * vE.y, 0.0);
}
`;

  // Folds the accumulated brush input into the state. cov is contact time
  // (in units of the brush's contact rate), so everything here is either an
  // exponential relaxation or linear in cov: applying a stroke in one batch
  // or in many gives the same result. The brush behaves like a reservoir at
  // a given wetness: it gives water where the paper is drier than it, and a
  // thirsty (damp) brush drinks where the paper is wetter. Where it touches
  // wet paint the two waters mix.
  const FS_APPLY = HEAD + `
uniform sampler2D uW, uG0, uG1, uFlux, uA0, uA1, uA2, uA3;
uniform float uBrushK, uMix, uDrag;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oG0;
layout(location = 2) out vec4 oG1;
layout(location = 3) out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W0 = texelFetch(uW, p, 0);
  vec4 g0 = texelFetch(uG0, p, 0), g1 = texelFetch(uG1, p, 0);
  vec4 f = texelFetch(uFlux, p, 0);
  vec4 a0 = texelFetch(uA0, p, 0), a3 = texelFetch(uA3, p, 0);
  W0.z = min(W0.z + a3.x, 2.0);
  float cov = a0.w;
  if (cov > 1e-5) {
    float str = 1.0 - exp(-cov * uBrushK);
    float target = a0.x / cov;
    float thirst = a0.y / cov;
    vec4 cb0 = texelFetch(uA1, p, 0) / cov, cb1 = texelFetch(uA2, p, 0) / cov;
    float w = W0.x;
    float dw = (target - w) * str;
    if (dw > 0.0) {
      dw *= 1.0 - thirst;   // a thirsty brush or tissue never wets dry paper
      w += dw;
      g0 += cb0 * dw;
      g1 += cb1 * dw;
    } else {
      float take = -dw * thirst;
      float fr = take / max(w, 1e-6);
      g0 *= 1.0 - fr;
      g1 *= 1.0 - fr;
      w -= take;
      W0.y *= 1.0 - 0.3 * thirst * str;
    }
    // a loaded brush trades paint with the wet paper; a clean wet brush
    // mostly dilutes, and only a thirsty one scrubs pigment up
    float loaded = smoothstep(0.0, 0.2, dot(cb0 + cb1, vec4(1.0)));
    float m = 1.0 - exp(-cov * uMix * max(loaded * (1.0 - 0.6 * thirst), 0.35 * thirst));
    if (w > 1e-4) {
      g0 = mix(g0, cb0 * w, m);
      g1 = mix(g1, cb1 * w, m);
    }
    // bristles moving through wet paint push it along (linear in contact time)
    vec2 v = a3.yz * uDrag;
    float vm = length(v);
    if (vm > 0.6) v *= 0.6 / vm;
    f += vec4(max(v.x, 0.0), max(-v.x, 0.0), max(v.y, 0.0), max(-v.y, 0.0)) * w;
    W0.x = w;
  }
  oW = W0;
  oG0 = max(g0, 0.0);
  oG1 = max(g1, 0.0);
  oF = f;
}
`;

  // Reads the paper under each bristle tuft so the brush can pick up
  // water and pigment. One point per tuft, written to pixel (i, 0).
  const VS_GATHER = HEAD + `
layout(location = 0) in vec2 aP;
uniform float uWidth;
out vec2 vP;
void main() {
  vP = aP;
  gl_Position = vec4((float(gl_VertexID) + 0.5) / uWidth * 2.0 - 1.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;
  const FS_GATHER = HEAD + `
uniform sampler2D uW, uG0, uG1;
uniform ivec2 uSize;
uniform int uPaint;   // gouache: only the part of the film still wet enough to work counts
in vec2 vP;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 q = clamp(ivec2(vP), ivec2(0), uSize - 1);
  o0 = texelFetch(uW, q, 0);
  o1 = texelFetch(uG0, q, 0);
  o2 = texelFetch(uG1, q, 0);
  if (uPaint == 1) {
    float f = smoothstep(0.0, 0.35, o0.y);
    o0.x *= f; o1 *= f; o2 *= f;
  }
}
`;

  // ---------------------------------------------------------------- utility
  const FS_COPY = HEAD + `
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
`;

  // Marks everything that has fully dried as set, before the sim sleeps.
  const FS_FINALIZE = HEAD + `
uniform sampler2D uW;
uniform float uWetEps, uDryS;
out vec4 o;
void main() {
  vec4 W = texelFetch(uW, ivec2(gl_FragCoord.xy), 0);
  if (W.x < uWetEps && W.y < uDryS) W = vec4(0.0, 0.0, 0.0, 1.0);
  o = W;
}
`;

  // Block reduction used to tell when the sheet has dried: (max w, max s,
  // wet cells, damp cells).
  const FS_REDUCE = HEAD + `
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform int uMode;
uniform float uWetEps, uDampT;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      ivec2 q = base + ivec2(x, y);
      if (q.x >= uSrcSize.x || q.y >= uSrcSize.y) continue;
      vec4 v = texelFetch(uSrc, q, 0);
      if (uMode == 0) {
        acc.x = max(acc.x, v.x);
        acc.y = max(acc.y, v.y);
        acc.z += v.x > uWetEps * 10.0 ? 1.0 : 0.0;
        acc.w += (v.x <= uWetEps * 10.0 && v.y > uDampT) ? 1.0 : 0.0;
      } else {
        acc.xy = max(acc.xy, v.xy);
        acc.zw += v.zw;
      }
    }
  o = acc;
}
`;

  // Per-frame composite at sim resolution into filterable half floats.
  const FS_COMPOSITE = HEAD + `
uniform sampler2D uW, uG0, uG1, uD0, uD1, uPaper, uFN;
uniform float uPaperAmp;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W = texelFetch(uW, p, 0);
  o0 = texelFetch(uG0, p, 0) + texelFetch(uD0, p, 0) + texelFetch(uFN, p, 0);
  o1 = texelFetch(uG1, p, 0) + texelFetch(uD1, p, 0);
  float b = texelFetch(uPaper, p, 0).w * uPaperAmp;
  o2 = vec4(W.x, W.y, W.z, b + W.x);
}
`;

  // ---------------------------------------------------------------- display
  // Kubelka–Munk layer over the paper, relief lighting from the paper's
  // height field, and a specular sheen off the water surface while wet.
  const FS_DISPLAY = HEAD + NOISE + `
uniform sampler2D uC0, uC1, uC2, uPaperHi;
uniform vec2 uRes, uSim;
uniform vec3 uK[8];
uniform vec3 uS[8];
uniform vec4 uGran0, uGran1;
uniform vec3 uPaperColor, uLight;
uniform float uExposure, uRelief, uGranDisp, uCap, uWaterNormal, uPulp, uPencil;
out vec4 o;

void km(vec3 K, vec3 S, out vec3 R, out vec3 T) {
  vec3 a = 1.0 + K / S;
  vec3 b = sqrt(a * a - 1.0);
  vec3 bs = b * S;
  vec3 sh = sinh(bs), ch = cosh(bs);
  vec3 c = a * sh + b * ch;
  R = sh / c;
  T = b / c;
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 ph = texture(uPaperHi, uv);
  vec4 c0 = texture(uC0, uv), c1 = texture(uC1, uv);
  vec4 cw = texture(uC2, uv);

  // granulation detail from the full-resolution tooth
  float g = (0.5 - ph.w) * 2.0;
  c0 *= max(vec4(0.0), 1.0 + uGranDisp * uGran0 * g);
  c1 *= max(vec4(0.0), 1.0 + uGranDisp * uGran1 * g);
  if (uPencil > 0.5) {
    // dry media ride on the tooth: a light layer shows the paper's grain as
    // specks on its peaks with the valleys still white; as the layer builds
    // (or is pressed or blended in) the tooth fills and the grain fades
    float worked = clamp(c1.w, 0.0, 1.0);   // blended or burnished into the tooth
    vec4 f0 = max(1.0 - exp(-c0 * 2.5), vec4(worked)), f1 = max(1.0 - exp(-c1 * 2.5), vec4(worked));
    c0 *= max(vec4(0.0), 1.0 - 0.9 * (1.0 - f0) * g);
    c1 *= max(vec4(0.0), 1.0 - 0.9 * (1.0 - f1) * g);
  }

  vec3 K = c0.x * uK[0] + c0.y * uK[1] + c0.z * uK[2] + c0.w * uK[3]
         + c1.x * uK[4] + c1.y * uK[5] + c1.z * uK[6] + c1.w * uK[7];
  vec3 S = c0.x * uS[0] + c0.y * uS[1] + c0.z * uS[2] + c0.w * uS[3]
         + c1.x * uS[4] + c1.y * uS[5] + c1.z * uS[6] + c1.w * uS[7];

  float wet = smoothstep(0.004, 0.05, cw.x);
  float damp = clamp(cw.y / uCap, 0.0, 1.0);
  float wetLook = max(wet, damp * 0.6);
  K *= 1.0 + 0.16 * wetLook;
  float pulp = 1.0 + uPulp * (0.022 * (ph.x - 0.5) + 0.012 * (ph.w - 0.5));
  vec3 Rp = uPaperColor * pulp * (1.0 - 0.085 * wetLook);

  vec3 R, T;
  km(K + 1e-5, S + 1e-4, R, T);
  vec3 col = R + T * T * Rp / (1.0 - R * Rp);

  // paper relief under a raking light; standing water fills the tooth
  vec3 n = normalize(vec3(-ph.yz * uRelief, 1.0));
  float lit = dot(n, uLight) / uLight.z;
  col *= mix(1.0, lit, 0.5 * (1.0 - 0.7 * wet));

  if (wet > 0.0) {
    vec2 px = 1.5 / uSim;
    float hx = texture(uC2, uv + vec2(px.x, 0.0)).w - texture(uC2, uv - vec2(px.x, 0.0)).w;
    float hy = texture(uC2, uv + vec2(0.0, px.y)).w - texture(uC2, uv - vec2(0.0, px.y)).w;
    vec3 nw = normalize(vec3(-hx * uWaterNormal, -hy * uWaterNormal, 1.0) + vec3(-ph.yz * uRelief * 0.05, 0.0));
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), nw);
    float spec = pow(max(dot(r, uLight), 0.0), 48.0);
    vec3 soft = normalize(uLight + vec3(0.0, 0.0, 1.2));
    float sheen = pow(max(dot(r, soft), 0.0), 14.0);
    float fres = pow(1.0 - clamp(nw.z, 0.0, 1.0), 3.0);
    col += wet * (spec * 0.2 + sheen * 0.03 + fres * 0.1);
  }

  // undissolved salt crystals: small, faceted, catching the light
  float salt = cw.z;
  if (salt > 0.02) {
    float facet = rnd(ivec2(gl_FragCoord.xy * 0.5), 77u);
    float sv = smoothstep(0.08, 0.6, salt);
    vec3 crystal = vec3(0.86, 0.87, 0.86) * (0.8 + 0.3 * facet);
    col = mix(col, crystal, sv * 0.9);
  }

  vec2 lv = uv - vec2(0.25, 0.8);
  col *= uExposure * (1.03 - 0.07 * dot(lv, lv));
  o = vec4(toSrgb(col), 1.0);
}
`;

  // ---------------------------------------------------------------- pencil
  // A pencil's contact sweeping from one point to the next. Graphite comes
  // off where the lead rides on the paper: a light touch only catches the
  // tops of the tooth, pressing harder reaches down into it. Segments of one
  // stroke abut without overlapping (caps only at its ends), so a stroke
  // lays each spot once. Out: (fill fraction, fill x capacity, blend, erase).
  const FS_PENCIL = HEAD + NOISE + `
uniform sampler2D uPaper;
in vec2 vLocal;
flat in vec4 vB, vC, vD, vE, vF;
flat in vec2 vSeg, vDir, vRad;
out vec4 o;
void main() {
  vec2 q = vLocal;
  float len = vSeg.x;
  int caps = int(vC.z + 0.5);
  if (q.x < 0.0 && (caps & 1) == 0) discard;
  if (q.x > len && (caps & 2) == 0) discard;
  float px = clamp(q.x, 0.0, len);
  float r = max(mix(vRad.x, vRad.y, len > 1e-4 ? px / len : 0.0), 0.35);
  float d = length(vec2(q.x - px, q.y)) / r;
  vec4 pp = texelFetch(uPaper, ivec2(gl_FragCoord.xy), 0);
  float h = 0.35 * pp.x + 0.65 * pp.w;   // the tooth the lead rides on
  if (vC.y > 0.0) {
    // an eraser: it bears on the tops of the tooth first; pressed harder it
    // reaches down into the valleys (a light pass leaves a ghost of the mark
    // in them). Vinyl has a crisp edge, putty a soft one; vD = (reach,
    // edge, smear).
    float fe = 1.0 - smoothstep(mix(0.35, 0.86, vD.y), 1.0, d);
    if (fe <= 0.0) discard;
    float bear = smoothstep(1.0 - vD.x - 0.5, 1.0 - vD.x + 0.22, h);
    o = vec4(0.0, 0.0, vD.z * fe, vC.y * fe * (0.12 + 0.88 * bear));
    return;
  }
  float fp = 1.0 - smoothstep(0.72, 1.0, d);
  if (fp <= 0.0) discard;
  float reach = vB.y;
  float tooth = smoothstep(1.0 - reach - 0.42, 1.0 - reach + 0.3, h);
  // the lead's own grain: fine streaks running along the stroke
  float u = dot(gl_FragCoord.xy, vDir), w = dot(gl_FragCoord.xy, vec2(-vDir.y, vDir.x));
  float sd = vB.w * 31.0;
  float streak = 0.7 * vnoise(vec2(u * 0.07 + sd, w * 1.1), 71u) + 0.3 * vnoise(vec2(u * 0.2, w * 2.3 + sd), 73u);
  float grain = (0.68 + 0.64 * streak) * (0.94 + 0.12 * rnd(ivec2(gl_FragCoord.xy), uint(vB.w * 997.0) + 101u));
  float a = clamp(vB.x * fp * tooth * grain, 0.0, 1.0);
  o = vec4(a, a * vB.z, vC.x * fp, vC.y * fp);
}
`;
  // Fold one pass of pencil contact into the dry pigment: graphite fills
  // part of the room left under this grade's ceiling; a blending stump
  // spreads it into the neighbours (and down into the tooth); an eraser
  // lifts a share of everything.
  const FS_PENCIL_APPLY = HEAD + `
uniform sampler2D uD0, uD1, uAcc;
uniform int uSlot;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d0 = texelFetch(uD0, p, 0), d1 = texelFetch(uD1, p, 0);
  vec4 a = texelFetch(uAcc, p, 0);
  if (a.z > 0.0) {
    vec4 m0 = vec4(0.0), m1 = vec4(0.0);
    float wsum = 0.0;
    for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
      float w = 1.0 / (1.0 + float(dx * dx + dy * dy));
      m0 += w * texelFetch(uD0, p + ivec2(dx, dy), 0); m1 += w * texelFetch(uD1, p + ivec2(dx, dy), 0); wsum += w;
    }
    float k = clamp(a.z, 0.0, 0.9);
    float worked = d1.w;
    d0 = mix(d0, m0 / wsum, k) * (1.0 - 0.012 * k);
    d1 = mix(d1, m1 / wsum, k) * (1.0 - 0.012 * k);
    // slot 7: worked into the tooth (a stump presses it in; an eraser
    // dragging graphite along does not)
    d1.w = a.w > 0.0 ? worked : min(1.0, worked + 0.7 * k);
  }
  if (a.w > 0.0) {
    // an eraser lifts the loose graphite; what a stump worked into the tooth,
    // and a dense, pressed-in layer, holds on and takes several passes
    float dense = d0.x + d0.y + d0.z + d0.w + d1.x + d1.y + d1.z;
    float e = clamp(a.w, 0.0, 0.97) * (1.0 - 0.55 * d1.w) * (1.0 - 0.3 * smoothstep(0.55, 1.1, dense));
    d0 *= 1.0 - e;
    d1.xyz *= 1.0 - e;
    d1.w *= 1.0 - 0.45 * e;
  }
  if (a.x > 0.0) {
    float fill = min(a.x, 1.0);
    float cap = a.y / max(a.x, 1e-5);
    vec4 s0 = vec4(equal(ivec4(0, 1, 2, 3), ivec4(uSlot)));
    vec4 s1 = vec4(equal(ivec4(4, 5, 6, 7), ivec4(uSlot)));
    d0 += s0 * fill * max(vec4(0.0), vec4(cap) - d0);
    d1 += s1 * fill * max(vec4(0.0), vec4(cap) - d1);
  }
  o0 = d0; o1 = d1;
}
`;

  // ---------------------------------------------------------------- gouache
  // Opaque body colour reuses the state textures with other meanings:
  //   W    (film, wetness, c, s)  wet paint on the surface: film thickness (in
  //                               the brush's units), how wet it still is
  //                               (1 fresh, 0 dry), and which way the brush
  //                               last worked it (doubled-angle cos, sin)
  //   G0/1 the wet film's pigment, 8 colours (film × the paint's fraction)
  //   D0   (R, G, B, thickness)   what is already dry under it: its linear
  //                               reflectance and total thickness (0 = bare)
  //   D1   (c, s, top, 0)         the brushwork of the uppermost dry layer: its
  //                               direction and thickness (for display only)
  // A brush gives paint where the film is thinner than what it carries, a
  // nearly empty tuft takes wet paint up, and a loaded brush dragged
  // through wet paint stirs its colour in. Paint dries from the outside in
  // (thin films first); dry paint is folded into D0 as one more
  // Kubelka–Munk layer, so later paint covers it as far as its own hiding
  // power allows.
  const KM_FN = `
void km(vec3 K, vec3 S, out vec3 R, out vec3 T) {
  vec3 a = 1.0 + K / S;
  vec3 b = sqrt(a * a - 1.0);
  vec3 bs = b * S;
  vec3 sh = sinh(min(bs, vec3(30.0))), ch = cosh(min(bs, vec3(30.0)));
  vec3 c = a * sh + b * ch;
  R = sh / c;
  T = b / c;
}
uniform vec3 uK[8];
uniform vec3 uS[8];
uniform float uOpt;
vec3 paintOver(vec4 g0, vec4 g1, vec3 Rs, float darken) {
  vec4 a0 = g0 * uOpt, a1 = g1 * uOpt;
  vec3 K = a0.x * uK[0] + a0.y * uK[1] + a0.z * uK[2] + a0.w * uK[3] + a1.x * uK[4] + a1.y * uK[5] + a1.z * uK[6] + a1.w * uK[7];
  vec3 S = a0.x * uS[0] + a0.y * uS[1] + a0.z * uS[2] + a0.w * uS[3] + a1.x * uS[4] + a1.y * uS[5] + a1.z * uS[6] + a1.w * uS[7];
  vec3 R, T;
  km(K * darken + 1e-5, S + 1e-4, R, T);
  return R + T * T * Rs / (1.0 - R * Rs);
}
`;

  const FS_PAINT_APPLY = HEAD + `
uniform sampler2D uW, uG0, uG1, uA0, uA1, uA2, uA3;
uniform float uBrushK, uMix;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oG0;
layout(location = 2) out vec4 oG1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W = texelFetch(uW, p, 0);
  vec4 g0 = texelFetch(uG0, p, 0), g1 = texelFetch(uG1, p, 0);
  vec4 a0 = texelFetch(uA0, p, 0);
  float cov = a0.w;
  if (cov > 1e-5) {
    float str = 1.0 - exp(-cov * uBrushK);
    float target = a0.x / cov, thirst = a0.y / cov;
    vec4 cb0 = texelFetch(uA1, p, 0) / cov, cb1 = texelFetch(uA2, p, 0) / cov;
    float h = W.x, wet = W.y;
    float open = smoothstep(0.0, 0.35, wet);   // how workable the film still is
    float dh = (target - h) * str;
    if (dh > 0.0) {
      dh *= 1.0 - thirst;   // a tuft nearly out of paint only takes
      g0 += cb0 * dh;
      g1 += cb1 * dh;
      wet = (wet * h + dh) / max(h + dh, 1e-6);
      h += dh;
    } else {
      float take = -dh * thirst * open;
      float fr = take / max(h, 1e-6);
      g0 *= 1.0 - fr;
      g1 *= 1.0 - fr;
      h -= take;
    }
    // a loaded brush dragged through wet paint stirs its own colour in
    float loaded = smoothstep(0.0, 0.25, dot(cb0 + cb1, vec4(1.0)));
    float m = (1.0 - exp(-cov * uMix * loaded)) * open;
    if (h > 1e-5) {
      g0 = mix(g0, cb0 * h, m);
      g1 = mix(g1, cb1 * h, m);
    }
    // remember which way the brush went through this film (it shows as the
    // grain of the stroke; nothing in the physics reads it)
    vec2 v = texelFetch(uA3, p, 0).yz / cov;
    float vl = length(v);
    if (vl > 1e-3) {
      vec2 d = v / vl;
      float f = clamp(max(dh, 0.0) / max(h, 1e-6) + m, 0.0, 1.0);
      W.zw = mix(W.zw, vec2(d.x * d.x - d.y * d.y, 2.0 * d.x * d.y), f);
    }
    W.x = h; W.y = wet;
  }
  oW = W;
  oG0 = max(g0, 0.0);
  oG1 = max(g1, 0.0);
}
`;

  // Drying: thin films and the edges of strokes dry first. Wet paint levels
  // a little into its neighbours while it is very wet (softening the ridges
  // the hairs leave); dry paint becomes part of the ground.
  const FS_PAINT_STEP = HEAD + KM_FN + `
uniform sampler2D uW, uG0, uG1, uD0, uD1;
uniform ivec2 uSize;
uniform float uDt, uOpen, uLevel;
uniform vec3 uPaperColor;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oG0;
layout(location = 2) out vec4 oG1;
layout(location = 3) out vec4 oD0;
#ifdef BRUSHWORK
layout(location = 4) out vec4 oD1;
#endif
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W = texelFetch(uW, p, 0);
  vec4 g0 = texelFetch(uG0, p, 0), g1 = texelFetch(uG1, p, 0);
  vec4 d0 = texelFetch(uD0, p, 0);
  oD0 = d0;
#ifdef BRUSHWORK
  vec4 d1 = texelFetch(uD1, p, 0);
  oD1 = d1;
#endif
  // levelling: a conservative exchange of film and pigment with wetter
  // neighbours, in proportion to how fluid both still are
  if (uLevel > 0.0) {
    vec4 dg0 = vec4(0.0), dg1 = vec4(0.0);
    float dh = 0.0;
    float fp = W.y * W.y * W.x;
    for (int k = 0; k < 4; k++) {
      ivec2 q = clamp(p + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1)), ivec2(0), uSize - 1);
      vec4 Wq = texelFetch(uW, q, 0);
      float fq = Wq.y * Wq.y * Wq.x;
      float c = uLevel * uDt * min(fp, fq) / max(1e-4, max(W.x, Wq.x));
      if (c <= 0.0) continue;
      c = min(c, 0.2);
      dh += c * (Wq.x - W.x);
      dg0 += c * (texelFetch(uG0, q, 0) - g0);
      dg1 += c * (texelFetch(uG1, q, 0) - g1);
    }
    W.x += dh; g0 += dg0; g1 += dg1;
  }
  float h = W.x;
  if (h <= 1e-6) {
    oW = vec4(0.0); oG0 = vec4(0.0); oG1 = vec4(0.0);
    return;
  }
  float wet = W.y - uDt / (uOpen * (0.3 + 4.0 * h));
  if (wet <= 0.0) {
    vec3 Rs = d0.w > 0.0 ? d0.rgb : uPaperColor;
    oD0 = vec4(paintOver(g0, g1, Rs, 1.0), d0.w + h);
#ifdef BRUSHWORK
    // the new layer's brushwork shows as far as it is thick enough to hide the old
    float k = clamp(h / 0.12, 0.0, 1.0);
    oD1 = vec4(mix(d1.xy, W.zw, k), mix(d1.z, h, k), 0.0);
#endif
    oW = vec4(0.0); oG0 = vec4(0.0); oG1 = vec4(0.0);
    return;
  }
  oW = vec4(h, wet, W.z, W.w);
  oG0 = max(g0, 0.0);
  oG1 = max(g1, 0.0);
}
`;

  // Sim-resolution colour of the paint (wet film over what is dry), into
  // filterable targets for the display pass.
  const FS_PAINT_COMPOSITE = HEAD + KM_FN + `
uniform sampler2D uW, uG0, uG1, uD0, uD1;
uniform vec3 uPaperColor;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 W = texelFetch(uW, p, 0);
  vec4 d0 = texelFetch(uD0, p, 0);
  float painted = d0.w > 0.0 ? 1.0 : 0.0;
  vec3 Rs = painted > 0.5 ? d0.rgb : uPaperColor;
  vec3 col = Rs;
  if (W.x > 1e-6) {
    // wet gouache is a shade darker and richer than it dries
    col = paintOver(texelFetch(uG0, p, 0), texelFetch(uG1, p, 0), Rs, 1.0 + 0.12 * W.y);
    painted = 1.0;
  }
  o0 = vec4(col, painted);
  o1 = vec4(d0.w + W.x, W.x > 1e-6 ? W.y : 0.0, W.x, 0.0);
  vec4 d1 = texelFetch(uD1, p, 0);
  float k = clamp(W.x / 0.12, 0.0, 1.0);
  o2 = vec4(mix(d1.xy, W.zw, k), mix(d1.z, W.x, k), 0.0);
}
`;

  // Display: the paint (or bare board) under a raking light. The board's
  // tooth shows through thin paint and fills as paint builds up; the paint's
  // own thickness (brush ridges, the edges of strokes) catches the light;
  // wet paint has a satin sheen and dries matte.
  const FS_PAINT_DISPLAY = HEAD + NOISE + `
uniform sampler2D uC0, uC1, uC2, uPaperHi;
uniform vec2 uRes, uSim, uMM;
uniform vec3 uPaperColor, uLight;
uniform float uExposure, uRelief, uImpasto, uPulp, uFurrow, uGrain, uWarp;
uniform vec4 uView;   // the part of the sheet shown (uv, y up): a camera zoomed in renders it at full detail
out vec4 o;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// Catmull-Rom from the simulation grid: sharper than bilinear, without its
// stair steps; clamped to the four nearest cells so edges do not ring
vec4 cubic(sampler2D t, vec2 uv, float sharp) {
  vec2 st = uv * uSim - 0.5, i = floor(st), f = st - i;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec4 r = vec4(0.0), lo = vec4(1e9), hi = vec4(-1e9);
  ivec2 mx = ivec2(uSim) - 1;
  for (int y = -1; y <= 2; y++) {
    float wy = y == -1 ? w0.y : y == 0 ? w1.y : y == 1 ? w2.y : w3.y;
    for (int x = -1; x <= 2; x++) {
      float wx = x == -1 ? w0.x : x == 0 ? w1.x : x == 1 ? w2.x : w3.x;
      vec4 v = texelFetch(t, clamp(ivec2(i) + ivec2(x, y), ivec2(0), mx), 0);
      r += wx * wy * v;
      if ((x == 0 || x == 1) && (y == 0 || y == 1)) { lo = min(lo, v); hi = max(hi, v); }
    }
  }
  r = clamp(r, lo, hi);
  if (sharp > 1.0) {
    // an edge between cells: steepen the interpolated ramp to about a display
    // pixel, so the edge follows its smooth contour, not the grid's steps
    vec4 span = max(hi - lo, vec4(1e-5));
    vec4 tt = clamp(((r - lo) / span - 0.5) * sharp + 0.5, 0.0, 1.0);
    r = mix(r, lo + tt * span, step(vec4(0.02), span));
  }
  return r;
}
// bristle furrows: short oriented ripples (sparse Gabor noise) laid along
// the way the brush went; pm in mm, u the stroke's direction
float furrows(vec2 pm, vec2 u, float fmax, float phase) {
  vec2 v = vec2(-u.y, u.x);
  const float cell = 1.4;
  vec2 c = floor(pm / cell);
  float s = 0.0, ws = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 ci = ivec2(c) + ivec2(i, j);
      vec2 d = pm - (vec2(ci) + rnd2(ci, 811u)) * cell;
      float al = dot(d, u), ac = dot(d, v);
      // hairs bunch and part unevenly: each ripple its own spacing, length
      // and depth, and some barely there
      float ln = 2.0 + 3.0 * rnd(ci, 557u);
      float w = exp(-(al * al / (2.0 * ln * ln) + ac * ac / 1.0));
      float fr = min(fmax, 2.6) * (0.4 + 0.6 * rnd(ci, 433u));
      float depth = pow(rnd(ci, 661u), 1.5);
      s += w * depth * cos(6.2832 * fr * ac + 6.2832 * rnd(ci, 977u) + phase);
      ws += w;
    }
  return s / max(ws, 1e-3);
}
void main() {
  vec2 sv = gl_FragCoord.xy / uRes;                     // screen
  vec2 uv = mix(uView.xy, uView.zw, sv);                // sheet
  vec2 pm = uv * uMM;                                   // mm on the sheet
  vec2 mmpx = (uView.zw - uView.xy) * uMM / uRes;       // mm per display pixel
  vec4 ph = texture(uPaperHi, uv);
  // stroke edges wander a little with the board's grain instead of following the grid
  vec2 wv = vec2(vnoise(pm * 2.2, 301u), vnoise(pm * 2.2 + 17.0, 303u)) - 0.5;
  vec2 uw = uv + wv * uWarp / uSim;
  float mag = uRes.x / ((uView.z - uView.x) * uSim.x);  // display pixels per simulation cell
  vec4 c0 = cubic(uC0, uw, mag), c1 = cubic(uC1, uw, 1.0), c2 = texture(uC2, uw);
  float pulp = 1.0 + uPulp * (0.02 * (ph.x - 0.5) + 0.01 * (ph.w - 0.5));
  vec3 paper = uPaperColor * pulp;
  float thick = max(c1.x, 0.0);
  // thin paint on bare board catches only the tops of the tooth (dry brush)
  float cover = clamp(c0.a, 0.0, 1.0);
  float speck = smoothstep(0.0, 0.09, thick * (0.35 + 1.3 * ph.w));
  vec3 col = mix(paper, c0.rgb, cover * mix(speck, 1.0, smoothstep(0.08, 0.2, thick)));
  // which way the uppermost paint was brushed
  vec2 dd = c2.xy;
  float conf = clamp(length(dd) * 1.5, 0.0, 1.0);
  float ang = length(dd) > 1e-4 ? 0.5 * atan(dd.y, dd.x) : 0.0;   // atan(0, 0) is undefined
  vec2 u = vec2(cos(ang), sin(ang));
  float top = clamp(c2.z, 0.0, 0.4);
  float fmax = 0.3 / max(mmpx.x, 1e-3);                // no finer than ~3 display pixels per ripple
  // each stroke its own ripples: the phase follows the stroke's own film
  // (it changes at every stroke's edge) and its direction; strokes differ in
  // how deeply the hairs dragged
  float phase = top * 34.0 + ang * 5.0;
  float famp = uFurrow * conf * smoothstep(0.02, 0.18, top) * cover * (0.45 + 0.9 * vnoise(vec2(top * 61.0, ang * 3.0), 317u));
  // height (mm-ish): paint thickness, its furrows, and the board's tooth where paint is thin
  vec2 ex = vec2(mmpx.x * 1.5, 0.0), ey = vec2(0.0, mmpx.y * 1.5);
  float h0 = famp * furrows(pm, u, fmax, phase);
  float hx = famp * furrows(pm + ex, u, fmax, phase) - h0;
  float hy = famp * furrows(pm + ey, u, fmax, phase) - h0;
  // the paint's thickness as relief, over about a third of a millimetre: a
  // stroke's edge is a soft shoulder, not a hairline
  vec2 tex = max(1.0, 0.33 * uSim.x / uMM.x) / uSim;
  float tx = 0.5 * (texture(uC1, uw + vec2(tex.x, 0.0)).x - texture(uC1, uw - vec2(tex.x, 0.0)).x
           + 0.5 * (texture(uC1, uw + vec2(2.0 * tex.x, 0.0)).x - texture(uC1, uw - vec2(2.0 * tex.x, 0.0)).x));
  float ty = 0.5 * (texture(uC1, uw + vec2(0.0, tex.y)).x - texture(uC1, uw - vec2(0.0, tex.y)).x
           + 0.5 * (texture(uC1, uw + vec2(0.0, 2.0 * tex.y)).x - texture(uC1, uw - vec2(0.0, 2.0 * tex.y)).x));
  tx *= 1.0 / (tex.x * uSim.x); ty *= 1.0 / (tex.y * uSim.y);   // per cell, as before
  float fill = exp(-thick * 4.0);
  vec2 grad = ph.yz * uRelief * (0.3 + 0.7 * fill) + vec2(tx, ty) * uImpasto + vec2(hx / ex.x, hy / ey.y) * 0.06;
  vec3 n = normalize(vec3(-grad, 1.0));
  float lit = dot(n, uLight) / uLight.z;
  col *= mix(1.0, lit, 0.6);
  // furrow bottoms hold a little shadow, ridges a little light
  col *= 1.0 + 0.5 * h0;
  // the matte, slightly chalky body of dried gouache
  float g = vnoise(pm * 9.0, 311u) - 0.5 + 0.5 * (vnoise(pm * 23.0, 313u) - 0.5);
  col *= 1.0 + uGrain * g * cover;
  float wet = c1.y;
  if (wet > 0.01) {
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
    float spec = pow(max(dot(r, uLight), 0.0), 30.0);
    col += wet * smoothstep(0.0, 0.05, c1.z) * spec * 0.09;
  }
  vec2 lv = sv - vec2(0.25, 0.8);
  col *= uExposure * (1.03 - 0.07 * dot(lv, lv));
  o = vec4(toSrgb(col), 1.0);
}
`;

  window.WC_SHADERS = {
    VS_TRI, VS_STAMP,
    FS_PAPER_RAW, FS_PAPER_NORM, FS_PAPER_HI1, FS_PAPER_HI2, FS_FIBRE,
    FS_FLUX, FS_WATER, FS_PIGMENT,
    FS_STAMP, FS_APPLY, VS_GATHER, FS_GATHER,
    FS_COPY, FS_FINALIZE, FS_REDUCE, FS_COMPOSITE, FS_DISPLAY, FS_PENCIL, FS_PENCIL_APPLY,
    FS_PAINT_APPLY, FS_PAINT_STEP, FS_PAINT_COMPOSITE, FS_PAINT_DISPLAY,
  };
})();
