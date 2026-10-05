// The hand. A stroke is a motion, not a curve: the pencil (or brush) has
// momentum, and where it goes is the integral of how it was pushed.
//
// Two ways to make one:
//   integrate(g)  the agent writes the acceleration over time (mm/s²) from a
//                 start point and velocity; the trajectory is what that
//                 push produces, with the hand's tremor on top.
//   follow(path)  the hand is asked to draw along a path. It plans a natural
//                 motion (slower round tight curves — the 2/3 power law of
//                 human drawing — and a smooth start and stop), then tracks
//                 that plan the way a hand does: muscles with finite gain,
//                 slow drift and fast tremor, corrected by eye. It lands near
//                 the path, never exactly on it.
// Both return points every dt ms with their times and speeds, in mm.

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Smooth noise in x and y (mm/s²): a few sines with random phases, slow drift
// (1-3 Hz, larger) and physiological tremor (8-12 Hz, small). looseness
// scales it: 1 a careful hand, 3 a quick rough sketch. At looseness 1 an
// open-loop stroke of 100 mm in 0.4 s lands within about 5 mm (Schmidt's
// law: the scatter grows with distance over time).
export function handNoise(seed, looseness = 1) {
  const r = mulberry32((seed >>> 0) || 7);
  const comp = [];
  for (let k = 0; k < 4; k++) comp.push({ f: 1 + 2 * r(), a: 50 * looseness, px: r() * 6.283, py: r() * 6.283 });
  for (let k = 0; k < 3; k++) comp.push({ f: 8 + 4 * r(), a: 260 * Math.sqrt(looseness), px: r() * 6.283, py: r() * 6.283 });
  return (tMs) => {
    const t = tMs / 1000;
    let x = 0, y = 0;
    for (const c of comp) { x += c.a * Math.sin(6.2832 * c.f * t + c.px); y += c.a * Math.sin(6.2832 * c.f * t + c.py); }
    return [x, y];
  };
}

// acc: [[t ms, ax, ay], ...] (mm/s²), linear between keys and held after
// the last; or accFn(t, vx, vy) for a push that depends on how the hand is
// already moving (along / across its own heading). start mm; v0 mm/s.
// Semi-implicit Euler at dt ms.
export function integrate(g) {
  const dt = g.dt || 2, T = g.duration || (g.acc && g.acc.length ? g.acc[g.acc.length - 1][0] : 300);
  const keys = (g.acc || [[0, 0, 0]]).slice().sort((a, b) => a[0] - b[0]);
  const accAt = (t) => {
    if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const f = (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0] || 1); return [keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * f, keys[i - 1][2] + (keys[i][2] - keys[i - 1][2]) * f]; }
    const l = keys[keys.length - 1]; return [l[1], l[2]];
  };
  const noise = handNoise(g.seed || 11, g.looseness == null ? 0.6 : g.looseness);
  let x = g.start[0], y = g.start[1], vx = (g.v0 || [0, 0])[0], vy = (g.v0 || [0, 0])[1];
  const pts = [[x, y]], ts = [0], speed = [Math.hypot(vx, vy)];
  for (let t = dt; t <= T + 1e-9; t += dt) {
    const [ax, ay] = g.accFn ? g.accFn(t, vx, vy) : accAt(t), [nx, ny] = noise(t);
    vx += (ax + nx) * dt / 1000; vy += (ay + ny) * dt / 1000;
    x += vx * dt / 1000; y += vy * dt / 1000;
    pts.push([x, y]); ts.push(+t.toFixed(1)); speed.push(Math.hypot(vx, vy));
  }
  return { pts, ts, speed };
}

// A path (mm, dense enough to be smooth) resampled by arc length.
function arc(path) {
  const S = [0];
  for (let i = 1; i < path.length; i++) S.push(S[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  return S;
}
function at(path, S, s) {
  let j = 1;
  while (j < path.length - 1 && S[j] < s) j++;
  const f = clamp((s - S[j - 1]) / (S[j] - S[j - 1] || 1), 0, 1);
  return [path[j - 1][0] + (path[j][0] - path[j - 1][0]) * f, path[j - 1][1] + (path[j][1] - path[j - 1][1]) * f];
}

// opts: speed (mean mm/s), looseness, seed, dt, gain (tracking bandwidth Hz),
// overshoot (mm carried past the end), lag.
export function follow(path, opts = {}) {
  const dt = opts.dt || 2;
  const S = arc(path), L = S[S.length - 1] || 1;
  // planned speed along the path: the 2/3 power law (slower where it
  // curves), inside a minimum-jerk start and stop
  const n = Math.max(8, Math.ceil(L / 0.5));
  const curv = [];
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n, h = Math.min(2, L / 6);
    const a = at(path, S, Math.max(0, s - h)), b = at(path, S, s), c = at(path, S, Math.min(L, s + h));
    const ux = b[0] - a[0], uy = b[1] - a[1], wx = c[0] - b[0], wy = c[1] - b[1];
    const cross = ux * wy - uy * wx, la = Math.hypot(ux, uy) || 1e-6, lb = Math.hypot(wx, wy) || 1e-6, lc = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1e-6;
    curv.push(Math.abs(2 * cross) / (la * lb * lc));   // 1/radius, mm⁻¹
  }
  const vmean = opts.speed || 120;
  // pace: time per mm from the power law (slower where it curves); then the
  // whole movement runs on a minimum-jerk clock (a bell-shaped speed in
  // time, mean speed as asked)
  const pl = (i) => Math.min(1.6, Math.pow(0.12 / Math.max(curv[i], 0.02), 1 / 3));
  const phi = [0];
  for (let i = 1; i <= n; i++) phi.push(phi[i - 1] + 2 / (pl(i - 1) + pl(i)));
  for (let i = 0; i <= n; i++) phi[i] /= phi[n];
  const T2 = (1000 * L) / vmean;
  const minjerk = (u) => { u = clamp(u, 0, 1); return u * u * u * (10 - 15 * u + 6 * u * u); };
  const planAt = (t) => {
    const m = minjerk(t / T2);
    let i = 1;
    while (i < n && phi[i] < m) i++;
    const f = clamp((m - phi[i - 1]) / (phi[i] - phi[i - 1] || 1), 0, 1);
    return at(path, S, (L * (i - 1 + f)) / n);
  };
  // track the plan: muscles of finite bandwidth, noise, and a little lag
  const fc = opts.gain || 5, kp = (6.2832 * fc) ** 2, kd = 2 * 0.75 * 6.2832 * fc;
  const noise = handNoise(opts.seed || 3, opts.looseness == null ? 1 : opts.looseness);
  const lag = opts.lag || 0;
  const p0 = planAt(0);
  let x = p0[0], y = p0[1], vx = 0, vy = 0;
  const pts = [[x, y]], ts = [0], speed = [0];
  const over = opts.overshoot || 0, Tend = T2 + (over > 0 ? 60 : 0);
  let prev = planAt(0), prev2 = prev;
  for (let t = dt; t <= Tend + 1e-9; t += dt) {
    let target = planAt(Math.min(T2, t - lag));
    if (t > T2 && over > 0) {   // the hand carries on a little past the end
      const e = planAt(T2), b = planAt(T2 - 30);
      const ux = e[0] - b[0], uy = e[1] - b[1], ul = Math.hypot(ux, uy) || 1;
      const f = (t - T2) / 60;
      target = [e[0] + (ux / ul) * over * f, e[1] + (uy / ul) * over * f];
    }
    // feed-forward from the plan's own acceleration, plus feedback
    const pvx = (target[0] - prev[0]) / (dt / 1000), pvy = (target[1] - prev[1]) / (dt / 1000);
    const pax = (target[0] - 2 * prev[0] + prev2[0]) / ((dt / 1000) ** 2), pay = (target[1] - 2 * prev[1] + prev2[1]) / ((dt / 1000) ** 2);
    prev2 = prev; prev = target;
    const [nx, ny] = noise(t);
    const ff = opts.feedforward == null ? 0.9 : opts.feedforward;
    const ax = ff * pax + kp * (target[0] - x) + kd * (pvx - vx) + nx;
    const ay = ff * pay + kp * (target[1] - y) + kd * (pvy - vy) + ny;
    vx += ax * dt / 1000; vy += ay * dt / 1000;
    x += vx * dt / 1000; y += vy * dt / 1000;
    pts.push([x, y]); ts.push(+t.toFixed(1)); speed.push(Math.hypot(vx, vy));
  }
  return { pts, ts, speed };
}

// Thin a dense motion to what a stroke needs (a point every ~0.4 mm, and
// always the last), keeping times.
export function thin(m, stepMM = 0.4) {
  const out = { pts: [m.pts[0]], ts: [m.ts[0]], speed: [m.speed[0]] };
  let last = m.pts[0];
  for (let i = 1; i < m.pts.length; i++) {
    const q = m.pts[i];
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= stepMM || i === m.pts.length - 1) { out.pts.push(q); out.ts.push(m.ts[i]); out.speed.push(m.speed[i]); last = q; }
  }
  return out;
}
