// In-page painting robot for the Ink simulation. Injected by ink.mjs into a
// page loaded with ?blank&res=...&orient=...; drives the app's own painter so
// strokes go through exactly the same brush, pickup and deposition code as a
// person painting. Time is virtual: nothing moves unless the bot steps frames,
// Math.random is a seeded generator, and performance.now() reads the bot's
// clock, so a list of actions replays to the same picture.
(function () {
  'use strict';
  if (window.inkBot) return;
  const app = window.inkApp, engine = window.inkEngine, brush = window.inkBrush;
  const LIB = window.WC_PIGMENTS;
  if (!app || !engine || !brush) throw new Error('inkApp is not ready');

  const FRAME = 1000 / 60;
  const WASH_SETTLE = 12, WASH_LIFT = 24;   // ms: wash passes land and lift quickly
  const TEX = ['W', 'F', 'G0', 'G1', 'D0', 'D1', 'FN'];
  const BRUSHES = ['round', 'flat', 'mop', 'rigger', 'fude', 'filbert'];
  const PAINT_TOOLS = ['brush', 'water', 'spatter'];
  const TOOLS = ['brush', 'water', 'lift', 'spatter', 'salt', 'seal', 'pencil', 'stump', 'eraser'];
  const PENCIL_TOOLS = ['pencil', 'stump', 'eraser'];
  const GRADES = ['4H', '2H', 'HB', '2B', '4B', '6B', '8B'];
  const STICKY = ['tool', 'brush', 'size', 'pigments', 'load', 'water', 'pressure', 'speed', 'tip', 'flatAngle', 'lift', 'settle', 'rinse', 'grade', 'sharp', 'side', 'eraser', 'eraserSize', 'marble'];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ------------------------------------------------------------ clock + rng
  let clock = 0;
  let rng = 1;
  const rand = () => {
    let t = (rng = (rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = rand;
  performance.now = () => clock;
  app.hold(true);
  app.painter.keepBoard = true;
  app.state.showBrush = false;
  app.state.reload = true;
  app.state.splineInput = true;
  engine.syncProbe = true;
  engine.exposure = 1;

  // Recording: every few frames, the sheet (and the brush while it is on
  // the paper) is grabbed as a JPEG for a time-lapse of the painting.
  let rec = null;
  let label = '';
  function grab(cam) {
    ensureDisplay();
    // a cut that waits: k more frames of the brush at work in the old view
    if (rec.pending && app.painter.running && rec.pending.k-- <= 0) { rec.view = rec.pending.to; rec.pending = null; }
    const v = rec.view;   // the camera: the part of the sheet in frame (sheet fractions, y down)
    engine.render(v || undefined);
    const W = rec.w, H = Math.round((W * engine.ny) / engine.nx);
    if (!rec.c) { rec.c = document.createElement('canvas'); rec.c.width = W; rec.c.height = H; rec.g = rec.c.getContext('2d'); }
    const g = rec.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.drawImage(engine.canvas, 0, 0, W, H);
    const painting = app.painter.running;
    if (rec.brush) {
      if (v) {
        const s = W / ((v[2] - v[0]) * engine.nx);
        app.drawTool(g, { scale: s, ox: -v[0] * engine.nx * s, oy: -v[1] * engine.ny * s, ny: engine.ny }, painting);
      } else app.drawTool(g, { scale: W / engine.nx, ox: 0, oy: 0, ny: engine.ny }, painting);
    }
    rec.frames.push({ t: +(clock / 1000).toFixed(3), label, painting, cam: !!cam, view: v ? v.map((x) => +x.toFixed(4)) : null, jpg: rec.c.toDataURL('image/jpeg', rec.q) });
  }
  // move the camera to a box over n frames (no time passes on the sheet):
  // eased, and by way of a wider view that holds both when the two are far apart
  function cameraMove(to, n) {
    if (!rec) return 0;
    rec.pending = null;
    if (!(n > 0)) { rec.view = to && to[2] - to[0] < 0.999 ? to : null; return 0; }   // a cut
    const from = rec.view || [0, 0, 1, 1];
    to = to || [0, 0, 1, 1];
    const ease = (u) => u * u * (3 - 2 * u);
    const lerp = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);
    const wa = from[2] - from[0], wb = to[2] - to[0];
    const ca = [(from[0] + from[2]) / 2, (from[1] + from[3]) / 2], cb = [(to[0] + to[2]) / 2, (to[1] + to[3]) / 2];
    const far = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > 0.6 * Math.max(wa, wb) && Math.max(wa, wb) < 0.9;
    let path = [from, to];
    if (far) {
      // a view holding both, at the sheet's aspect
      let u0 = Math.min(from[0], to[0]), v0 = Math.min(from[1], to[1]), u1 = Math.max(from[2], to[2]), v1 = Math.max(from[3], to[3]);
      const w = Math.max(u1 - u0, v1 - v0) * 1.1, cx = (u0 + u1) / 2, cy = (v0 + v1) / 2;
      let mid = [cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2];
      const dx = Math.max(0, -mid[0]) - Math.max(0, mid[2] - 1), dy = Math.max(0, -mid[1]) - Math.max(0, mid[3] - 1);
      mid = [mid[0] + dx, mid[1] + dy, mid[2] + dx, mid[3] + dy];
      if (w >= 1) mid = [0, 0, 1, 1];
      path = [from, mid, to];
    }
    const segs = path.length - 1, per = Math.max(2, Math.round(n / segs));
    for (let s = 0; s < segs; s++) for (let k = 1; k <= per; k++) { rec.view = lerp(path[s], path[s + 1], ease(k / per)); if (rec.view[2] - rec.view[0] > 0.999) rec.view = null; grab(true); }
    rec.view = to[2] - to[0] > 0.999 ? null : to;
    return segs * per;
  }
  const frame = () => {
    clock += FRAME;
    app.simFrame(FRAME);
    if (rec && !rec.paused && ++rec.n % (rec.sparse ? rec.sparseEvery : rec.every) === 0) grab();
  };
  const sparsely = (fn) => { const was = rec && rec.sparse; if (rec) rec.sparse = true; try { return fn(); } finally { if (rec) rec.sparse = was; } };
  const runFor = (ms) => sparsely(() => { for (let t = 0; t < ms; t += FRAME) frame(); });

  // ------------------------------------------------------------ settings
  let cur = null;     // sticky brush settings
  let board = null;   // tilt, dryer, humidity
  function defaults(medium) {
    const ink = medium === 'ink';
    if (medium === 'pencil') return { tool: 'pencil', brush: 'round', size: 4, pigments: { 0: 1 }, load: 0.5, water: 0.6, pressure: 0.5, speed: 120, tip: false, flatAngle: null, lift: null, settle: null, rinse: null, grade: 'HB', sharp: 0.3, side: 0, eraser: 'vinyl', eraserSize: 4 };
    // gouache: load = how much paint the brush picks up, water = how far it is thinned
    if (medium === 'gouache') return { tool: 'brush', brush: 'filbert', size: 4, pigments: { 0: 1 }, load: 0.65, water: 0.1, pressure: 0.55, speed: 200, tip: false, flatAngle: null, lift: null, settle: null, rinse: null };
    return {
      tool: 'brush', brush: ink ? 'fude' : 'round', size: ink ? 5 : 4,
      pigments: { 0: 1 }, load: ink ? 0.4 : 0.5, water: ink ? 0.55 : 0.6,
      pressure: 0.6, speed: 250, tip: false, flatAngle: null, lift: null, settle: null, rinse: null,
    };
  }

  function pigmentIndex(key) {
    const P = LIB.PIGMENTS;
    if (typeof key === 'number' || /^\d+$/.test(String(key))) {
      const i = +key;
      if (i >= 0 && i < P.length) return i;
    }
    const k = String(key).toLowerCase().trim();
    let i = P.findIndex((p) => [p.name, p.short, p.code].some((s) => s.toLowerCase() === k));
    if (i < 0) i = P.findIndex((p) => [p.name, p.short, p.code].some((s) => s.toLowerCase().includes(k)));
    if (i < 0) throw new Error(`unknown pigment "${key}" (have: ${P.map((p) => p.short).join(', ')})`);
    return i;
  }
  function mixArray(spec) {
    const m = new Array(8).fill(0);
    if (Array.isArray(spec)) spec.forEach((k) => { m[pigmentIndex(k)] += 1; });
    else if (typeof spec === 'string' || typeof spec === 'number') m[pigmentIndex(spec)] = 1;
    else for (const k in spec) m[pigmentIndex(k)] += Math.max(0, +spec[k]);
    if (!m.some((v) => v > 0)) throw new Error('pigments must name at least one pigment with a positive amount');
    return m;
  }
  function checkUnit(name, v) {
    if (v == null) return;
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`${name} must be a number in 0..1 (got ${JSON.stringify(v)})`);
  }
  function resolve(a, base) {
    const s = Object.assign({}, base);
    for (const k of STICKY) if (a[k] !== undefined) s[k] = a[k];
    if (!BRUSHES.includes(s.brush)) throw new Error(`brush must be one of ${BRUSHES.join(', ')}`);
    if (!(Number.isInteger(s.size) && s.size >= 0 && s.size <= 9)) throw new Error('size must be an integer 0..9');
    if (!TOOLS.includes(s.tool)) throw new Error(`tool must be one of ${TOOLS.join(', ')}`);
    const dryMedia = app.state.medium === 'pencil';
    if (dryMedia && !PENCIL_TOOLS.includes(s.tool)) throw new Error(`on the pencil sheet, tool must be one of ${PENCIL_TOOLS.join(', ')}`);
    if (!dryMedia && PENCIL_TOOLS.includes(s.tool)) throw new Error(`the ${s.tool} is for the pencil medium`);
    if (app.state.medium === 'gouache' && !PAINT_TOOLS.includes(s.tool)) throw new Error(`with gouache, tool must be one of ${PAINT_TOOLS.join(', ')}`);
    if (s.grade != null && !GRADES.includes(s.grade)) throw new Error(`grade must be one of ${GRADES.join(', ')}`);
    if (s.sharp != null && !(s.sharp >= 0.05 && s.sharp <= 2)) throw new Error('sharp (the point\'s radius) must be 0.05..2 mm');
    checkUnit('side', s.side);
    if (s.eraser != null && !['vinyl', 'kneaded'].includes(s.eraser)) throw new Error('eraser must be vinyl or kneaded');
    if (s.eraserSize != null && !(s.eraserSize >= 0.6 && s.eraserSize <= 30)) throw new Error('eraserSize (mm across) must be 0.6..30');
    ['load', 'water', 'pressure'].forEach((k) => checkUnit(k, s[k]));
    if (!(s.speed > 0)) throw new Error('speed must be a positive number of mm/s');
    s.mix = mixArray(s.pigments);
    return s;
  }

  // ------------------------------------------------------------ geometry
  const sheet = app.sheetMM;              // [w, h] in mm
  const widthOf = (type, size) => window.BristleBrush.TYPES[type].size(size).width;
  const pt = (p, where) => {
    if (!Array.isArray(p) || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) throw new Error(`${where}: points are [x, y] or [x, y, pressure] with x, y in 0..1`);
    return p;
  };
  function toPainterPts(pts, s) {
    return pts.map((p, i) => {
      pt(p, `point ${i}`);
      const pr = p.length > 2 && p[2] != null ? clamp(+p[2], 0, 1) : s.pressure;
      return [clamp(p[0], -0.05, 1.05), clamp(p[1], -0.05, 1.05), pr];
    });
  }

  // Scanline fill of a region (sheet fractions) with passes spaced a
  // fraction of the brush width apart, alternating direction, at an angle.
  // rings: outer outline plus any holes, filled by the even-odd rule, so
  // lights inside a shape can be left as bare paper.
  function washPasses(rings, s, a, wobble) {
    const ang = ((a.angle || 0) * Math.PI) / 180;
    const c = Math.cos(-ang), sn = Math.sin(-ang);
    const rot = (p, cs, sn2) => [p[0] * cs - p[1] * sn2, p[0] * sn2 + p[1] * cs];
    // work in mm so angles and spacing are isotropic
    const R = rings.map((ring, j) => ring.map((p, i) => { pt(p, `ring ${j} point ${i}`); return rot([p[0] * sheet[0], p[1] * sheet[1]], c, sn); }));
    const width = widthOf(s.brush, s.size);
    const spacing = Math.max(0.6, width * (a.spacing || 0.6));
    // the brush lands over ~settle ms and keeps travelling ~lift/2 ms as it
    // comes off, so pull the pass ends in by that much
    const travel = (s.speed * (WASH_SETTLE + WASH_LIFT * 0.5)) / 1000;
    const inset = width * (a.inset == null ? 0.3 : a.inset) + travel * 0.5;
    let y0 = Infinity, y1 = -Infinity;
    for (const ring of R) for (const p of ring) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const out = [];
    let dir = 1;
    for (let y = y0 + spacing * 0.5; y < y1; y += spacing) {
      const xs = [];
      for (const ring of R) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
        }
      }
      xs.sort((u, v) => u - v);
      const segs = [];
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = xs[i] + inset, xb = xs[i + 1] - inset;
        if (xb - xa > width * 0.25) segs.push([xa, xb]);
      }
      if (dir < 0) segs.reverse();
      for (const [xa, xb] of segs) {
        const from = dir > 0 ? xa : xb, to = dir > 0 ? xb : xa;
        const n = Math.max(2, Math.ceil(Math.abs(to - from) / 6));
        const line = [];
        for (let k = 0; k <= n; k++) {
          const x = from + ((to - from) * k) / n;
          const wob = wobble ? (rand() - 0.5) * spacing * 0.12 : 0;
          const q = rot([x, y + wob], Math.cos(ang), Math.sin(ang));
          line.push([q[0] / sheet[0], q[1] / sheet[1]]);
        }
        out.push(line);
      }
      dir = -dir;
    }
    return out;
  }

  // ------------------------------------------------------------ painting
  // A painter rinses before changing colour or going paler; the dip keeps
  // 12% of what was in the hair, which would muddy a pale tone. rinse:
  // true/false forces it either way (false keeps a deliberately dirty brush).
  let lastPaint = null;
  function maybeRinse(s) {
    if (s.tool !== 'brush' && s.tool !== 'spatter') return;
    const tot = (m) => m.reduce((a, b) => a + b, 0) || 1;
    const changed = !lastPaint || s.mix.some((v, i) => Math.abs(v / tot(s.mix) - lastPaint.mix[i] / tot(lastPaint.mix)) > 0.02);
    const paler = lastPaint && s.load < lastPaint.load - 0.02;
    const want = s.rinse == null ? changed || paler : !!s.rinse;
    if (want && brush.loaded) { brush.dip(null, s.water, 0.04); brush.dip(null, s.water, 0.04); }
    lastPaint = { mix: s.mix.slice(), load: s.load };
  }
  // any painter item (a press, for now) with this brush setting
  function paintItem(item, s) {
    maybeRinse(s);
    const set = { type: 'set', tool: s.tool, mix: Object.assign({}, s.mix), water: s.water, load: s.load, tip: !!s.tip };
    if (brush.type !== s.brush || brush.sizeIdx !== s.size) { set.brush = s.brush; set.size = s.size; }
    const p = app.painter;
    p.queue = [set, item];
    p.cur = null;
    p.running = true;
    let guard = 0;
    while (p.running) {
      frame();
      if (++guard > 60 * 600) { p.stop(); throw new Error('press did not finish'); }
    }
  }
  function paintPath(pts, s) {
    maybeRinse(s);
    const set = {
      type: 'set', tool: s.tool, mix: Object.assign({}, s.mix), water: s.water, load: s.load, tip: !!s.tip,
    };
    if (s.marble != null) set.marble = s.marble;
    if (PENCIL_TOOLS.includes(s.tool)) Object.assign(set, { grade: s.grade || 'HB', sharp: s.sharp == null ? 0.3 : s.sharp, side: s.side || 0, eraser: s.eraser || 'vinyl', eraserSize: s.eraserSize == null ? 4 : s.eraserSize });
    if (brush.type !== s.brush || brush.sizeIdx !== s.size) { set.brush = s.brush; set.size = s.size; }
    if (s.flatAngle != null) set.flatAngle = s.flatAngle;
    const stroke = { type: 'stroke', pts: toPainterPts(pts, s), speed: s.speed, pressure: s.pressure };
    if (s.ts) stroke.ts = s.ts;
    if (s.lift != null) stroke.lift = s.lift;
    if (s.settle != null) stroke.settle = s.settle;
    const p = app.painter;
    p.queue = [set, pts.length ? stroke : { type: 'wait', ms: 0 }];
    p.cur = null;
    p.running = true;
    let guard = 0;
    while (p.running) {
      frame();
      if (++guard > 60 * 600) { p.stop(); throw new Error('stroke did not finish in 10 minutes of sim time'); }
    }
  }

  function dryUntil(maxS, useDryer) {
    return sparsely(() => {
      const was = app.state.dryer;
      if (useDryer) app.setDryer(true);
      let t = 0;
      const max = (maxS || 240) * 1000;
      while (engine.awake && t < max) { frame(); t += FRAME; }
      if (useDryer) app.setDryer(was);
      return { seconds: +(t / 1000).toFixed(1), dry: !engine.awake };
    });
  }

  const num = (v, name, lo, hi) => {
    if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number in ${lo}..${hi} (got ${JSON.stringify(v)})`);
    return v;
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // Turn one action into a job, checking everything first. c is the sticky
  // brush setting in effect at this point of the batch. Uses no randomness.
  function prepare(a, c) {
    switch (a.type) {
      case 'set': {
        const s = resolve(a, c);
        delete s.mix;
        return { cur: s, job: () => { cur = clone(s); } };
      }
      case 'stroke': {
        if (!Array.isArray(a.pts) || a.pts.length < 2) throw new Error('stroke needs pts: at least two [x, y(, pressure)] points');
        const s = resolve(a, c);
        toPainterPts(a.pts, s);
        if (a.ts != null) {
          // timed points (ms from the start): the stroke keeps the hand's own speed
          if (!Array.isArray(a.ts) || a.ts.length !== a.pts.length || a.ts.some((v, i) => !(v >= 0) || (i && v < a.ts[i - 1]))) throw new Error('ts must give a time (ms, not decreasing) for every point');
          s.ts = a.ts;
        }
        return { job: () => paintPath(a.pts, s) };
      }
      case 'dab': {
        // A press-and-lift touch, like a bamboo leaf: lands on the tip, swells
        // to full pressure a third of the way, and lifts off to a point. Fast
        // by default (the flick is what makes the taper).
        const s = resolve(Object.assign({}, a, { speed: a.speed == null ? 600 : a.speed }), c);
        const at = pt(a.at, 'at');
        const ang = ((a.angle || 0) * Math.PI) / 180;
        const lenMM = a.length == null ? widthOf(s.brush, s.size) * 4 : num(a.length, 'length (mm)', 0.5, 400);
        const press = a.press == null ? s.pressure : num(a.press, 'press', 0, 1);
        const curve = a.curve == null ? 0 : num(a.curve, 'curve', -1, 1);
        let prof = a.profile || [[0, 0.03], [0.08, 0.25], [0.3, 1], [0.55, 0.78], [0.8, 0.34], [0.93, 0.1], [1, 0]];
        if (!Array.isArray(prof) || prof.length < 2) throw new Error('profile is a list of pressure factors, or of [t, factor] pairs');
        if (!Array.isArray(prof[0])) prof = prof.map((f, k) => [k / (prof.length - 1), f]);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const pts = prof.map(([t, f]) => {
          const along = t * lenMM, off = Math.sin(Math.PI * t) * curve * lenMM * 0.5;
          return [at[0] + (ca * along - sa * off) / sheet[0], at[1] + (sa * along + ca * off) / sheet[1], clamp(f * press, 0, 1)];
        });
        return { job: () => paintPath(pts, s) };
      }
      case 'wash': {
        const s = resolve(a, c);
        let rings = a.rings || (a.poly ? [a.poly] : null);
        if (a.rect) {
          if (!Array.isArray(a.rect) || a.rect.length !== 4) throw new Error('rect is [x0, y0, x1, y1]');
          const [x0, y0, x1, y1] = a.rect;
          rings = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
        }
        if (!Array.isArray(rings) || !rings.length || rings.some((r) => !Array.isArray(r) || r.length < 3)) {
          throw new Error('wash needs rect: [x0, y0, x1, y1], poly: [[x, y], ...] or rings: [outer, hole, ...] (3+ points each)');
        }
        if (a.spacing != null) num(a.spacing, 'spacing', 0.1, 3);
        if (!washPasses(rings, s, a, false).length) throw new Error('wash region is thinner than the brush; use a smaller brush or a stroke');
        const ws = Object.assign({}, s, { settle: s.settle == null ? WASH_SETTLE : s.settle, lift: s.lift == null ? WASH_LIFT : s.lift });
        return { job: () => { for (const line of washPasses(rings, ws, a, true)) paintPath(line, ws); } };
      }
      case 'lift': case 'spatter': case 'salt': case 'seal': {
        if (a.type === 'salt' && LIB.medium === 'ink') throw new Error('salt is a watercolor technique; not available in ink');
        if (a.type === 'seal' && LIB.medium !== 'ink') throw new Error('the seal is only in the ink medium');
        const s = resolve(Object.assign({}, a, { tool: a.type }), c);
        const pts = a.pts || (a.at ? [pt(a.at, 'at'), [a.at[0] + 0.002, a.at[1]]] : null);
        if (!Array.isArray(pts) || pts.length < 2) throw new Error(`${a.type} needs pts (2+ points) or at: [x, y]`);
        toPainterPts(pts, s);
        return { job: () => paintPath(pts, s) };
      }
      case 'press': {
        // the brush straight down onto one spot: pressure in, hold, lift
        const s = resolve(a, c);
        const at = pt(a.at, 'at');
        const peak = a.press == null ? s.pressure : num(a.press, 'press', 0, 1);
        const item = { type: 'press', at: [clamp(at[0], -0.05, 1.05), clamp(at[1], -0.05, 1.05)], press: peak,
          down: a.down == null ? 120 : num(a.down, 'down (ms)', 10, 3000), hold: a.hold == null ? 150 : num(a.hold, 'hold (ms)', 0, 5000),
          up: a.up == null ? 120 : num(a.up, 'up (ms)', 10, 3000) };
        if (a.tilt) item.tilt = [num(a.tilt[0], 'tilt x', -1, 1), num(a.tilt[1], 'tilt y', -1, 1)];
        return { job: () => paintItem(item, s) };
      }
      case 'wait': {
        const sec = a.s == null ? 1 : num(a.s, 's (seconds)', 0, 1200);
        return { job: () => runFor(sec * 1000) };
      }
      case 'dry': {
        const max = a.max == null ? 240 : num(a.max, 'max (seconds)', 1, 1800);
        return { job: () => dryUntil(max, a.dryer !== false) };
      }
      case 'tilt': {
        const x = a.x == null ? 0 : num(a.x, 'x', -1, 1), y = a.y == null ? 0 : num(a.y, 'y', -1, 1);
        return { job: () => { board.tilt = [x, y]; app.setTilt(x, y); } };
      }
      case 'dryer': return { job: () => { board.dryer = !!a.on; app.setDryer(board.dryer); } };
      case 'humidity': {
        const v = num(a.value, 'value (% RH)', 20, 85);
        return { job: () => { board.humidity = v; app.setHumidity(v); } };
      }
      default: throw new Error(`unknown action type "${a.type}" (stroke, dab, press, wash, set, lift, spatter, salt, seal, wait, dry, tilt, dryer, humidity)`);
    }
  }
  function plan(actions) {
    let c = clone(cur);
    return actions.map((a, i) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`action ${i} is not an object`);
      try {
        const r = prepare(a, c);
        if (r.cur) c = r.cur;
        return r.job;
      } catch (e) {
        throw new Error(`action ${i} (${a.type}): ${e.message}`);
      }
    });
  }

  // ------------------------------------------------------------ snapshots
  const snaps = new Map();
  let maxResident = 12;
  function copyTex(src, dst) { engine._run(engine.pCopy, { uSrc: src }, [dst], engine.nx, engine.ny); }
  function brushState() {
    const o = {};
    for (const k of Object.keys(brush)) {
      const v = brush[k];
      if (k === 'T' || k === 'S') continue;
      if (ArrayBuffer.isView(v)) o[k] = v.slice();
      else if (Array.isArray(v)) o[k] = JSON.parse(JSON.stringify(v));
      else if (v === null || ['number', 'boolean', 'string'].includes(typeof v)) o[k] = v;
    }
    return o;
  }
  function setBrushState(o) {
    if (brush.type !== o.type || brush.sizeIdx !== o.sizeIdx) brush.configure(o.type, o.sizeIdx);
    for (const k in o) {
      const v = o[k];
      brush[k] = ArrayBuffer.isView(v) ? v.slice() : Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
    }
  }
  function capture() {
    const tex = TEX.map((k) => { const t = engine._tex(engine.nx, engine.ny, 'f32'); copyTex(engine[k].r, t); return t; });
    const st = app.state;
    return {
      tex,
      engine: {
        awake: engine.awake, simAccum: engine._simAccum, dryReadings: engine._dryReadings, framesSinceProbe: engine._framesSinceProbe,
        status: Object.assign({}, engine.status), lastT: engine._lastT || 0,
      },
      app: {
        tool: st.tool, brushType: st.brushType, sizeIdx: st.sizeIdx, water: st.water, load: st.load, mix: st.mix.slice(), tipDip: st.tipDip, pressure: st.pressure,
      },
      brush: brushState(),
      board: JSON.parse(JSON.stringify(board)),
      cur: JSON.parse(JSON.stringify(cur)),
      lastPaint: lastPaint && { mix: lastPaint.mix.slice(), load: lastPaint.load },
      clock, rng,
    };
  }
  function apply(s) {
    TEX.forEach((k, i) => copyTex(s.tex[i], engine[k].r));
    if (engine._probe) { engine.gl.deleteSync(engine._probe); engine._probe = null; }
    engine.stampCount = 0;
    engine.awake = s.engine.awake;
    engine._simAccum = s.engine.simAccum;
    engine._dryReadings = s.engine.dryReadings;
    engine._framesSinceProbe = s.engine.framesSinceProbe;
    engine.status = Object.assign({}, s.engine.status);
    engine._lastT = s.engine.lastT;
    engine.dirty = true;
    Object.assign(app.state, s.app, { mix: s.app.mix.slice() });
    setBrushState(s.brush);
    board = JSON.parse(JSON.stringify(s.board));
    app.setTilt(board.tilt[0], board.tilt[1]);
    app.setDryer(board.dryer);
    app.setHumidity(board.humidity);
    engine.awake = s.engine.awake;   // setTilt woke the engine; keep the captured wake state
    cur = JSON.parse(JSON.stringify(s.cur));
    lastPaint = s.lastPaint && { mix: s.lastPaint.mix.slice(), load: s.lastPaint.load };
    clock = s.clock;
    rng = s.rng;
  }
  function free(s) {
    for (const t of s.tex) { engine._dropFbosFor(t); engine.gl.deleteTexture(t); }
  }
  function remember(id, s) {
    if (snaps.has(id)) free(snaps.get(id));
    snaps.delete(id);
    snaps.set(id, s);
    while (snaps.size > maxResident) {
      const [old, v] = snaps.entries().next().value;
      free(v);
      snaps.delete(old);
    }
  }
  // Run fn on a throwaway copy of the present, then put the present back.
  function aside(fn) {
    const keep = capture();
    const paused = rec && rec.paused;
    if (rec) rec.paused = true;
    try { return fn(); } finally { apply(keep); free(keep); if (rec) rec.paused = paused; }
  }

  // ------------------------------------------------------------ output
  let displayW = 1536;
  function ensureDisplay() {
    const w = displayW, h = Math.round((displayW * engine.ny) / engine.nx);
    if (engine.canvas.width !== w || engine.canvas.height !== h || !engine.paperHi) {
      engine.canvas.width = w; engine.canvas.height = h;
      engine._genPaperHi();
    }
  }
  function render() {
    ensureDisplay();
    engine.render();
    return engine.canvas.toDataURL('image/png');
  }
  let smallC = null;
  function small(w) {
    ensureDisplay();
    engine.render();
    const h = Math.round((w * engine.ny) / engine.nx);
    if (!smallC || smallC.width !== w) { smallC = document.createElement('canvas'); smallC.width = w; smallC.height = h; }
    const g = smallC.getContext('2d');
    g.drawImage(engine.canvas, 0, 0, w, h);
    return smallC.toDataURL('image/png');
  }
  function renderPixels() {
    ensureDisplay();
    engine.render();
    const c = document.createElement('canvas');
    c.width = engine.canvas.width; c.height = engine.canvas.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(engine.canvas, 0, 0);
    return { png: c.toDataURL('image/png'), data: g.getImageData(0, 0, c.width, c.height), w: c.width, h: c.height };
  }

  function info() {
    const brushes = {};
    for (const b of BRUSHES) {
      brushes[b] = [];
      for (let i = 0; i < 10; i++) { const S = window.BristleBrush.TYPES[b].size(i); brushes[b].push({ size: i, label: S.label, widthMM: +S.width.toFixed(1) }); }
    }
    return {
      medium: LIB.medium, paper: app.state.paper, sheetMM: sheet, sim: [engine.nx, engine.ny], display: [displayW, Math.round((displayW * engine.ny) / engine.nx)],
      pigments: LIB.PIGMENTS.map((p, i) => ({
        index: i, name: p.name, short: p.short, code: p.code, opacity: p.opacity, staining: p.staining, granulating: p.granulating,
        preview: { masstone: LIB.reflectRGB(one(i, 3)), mid: LIB.reflectRGB(one(i, 0.8)), tint: LIB.reflectRGB(one(i, 0.15)) },
      })),
      brushes, tools: LIB.medium === 'gouache' ? PAINT_TOOLS : LIB.medium === 'pencil' ? PENCIL_TOOLS : TOOLS.filter((t) => !PENCIL_TOOLS.includes(t) && (LIB.medium === 'ink' ? t !== 'salt' : t !== 'seal')),
      papers: LIB.medium === 'ink' ? ['xuan', 'xuanHalf', 'xuanSized'] : LIB.medium === 'pencil' ? ['bristol', 'drawing', 'toothy'] : LIB.medium === 'gouache' ? ['board', 'canvas', 'cold'] : ['hot', 'cold', 'rough'],
      defaults: cur, board, clock: +(clock / 1000).toFixed(2),
    };
  }
  const one = (i, c) => { const a = new Array(8).fill(0); a[i] = c; return a; };

  function status() {
    return {
      clock: +(clock / 1000).toFixed(2), awake: engine.awake, wet: engine.status.wet, damp: engine.status.damp,
      resident: [...snaps.keys()], cur, board,
    };
  }

  // ------------------------------------------------------------ calibration
  // Paint each pigment at five loads on scrap paper, dry it, and measure the
  // colour the paper actually shows, so plans can pick loads by value.
  function calibrate(opts) {
    opts = opts || {};
    const loads = opts.loads || [0.1, 0.25, 0.45, 0.7, 0.95];
    const water = opts.water == null ? 0.5 : opts.water;
    const P = LIB.PIGMENTS.length;
    const cols = loads.length, rows = P;
    return aside(() => {
      engine.clear();
      const ink = LIB.medium === 'ink';
      const cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = 0.06 + (c / cols) * 0.9, y0 = 0.04 + (r / rows) * 0.93;
          const w = 0.9 / cols * 0.62, h = 0.93 / rows * 0.55;
          const rect = [x0, y0, x0 + w, y0 + h];
          const res = bot.run([{ type: 'wash', rect, brush: ink ? 'fude' : 'round', size: 6, pigments: { [r]: 1 }, load: loads[c], water, pressure: 0.75, speed: 200, spacing: 0.45, tip: false }]);
          if (res.error) throw new Error('calibration: ' + res.error);
          cells.push({ pigment: r, name: LIB.PIGMENTS[r].short, load: loads[c], water, rect });
        }
      }
      const dried = dryUntil(600, true);
      const px = renderPixels();
      const { data, w, h } = px;
      for (const cell of cells) {
        const [x0, y0, x1, y1] = cell.rect;
        const cx0 = Math.round((x0 + (x1 - x0) * 0.3) * w), cx1 = Math.round((x0 + (x1 - x0) * 0.7) * w);
        const cy0 = Math.round((y0 + (y1 - y0) * 0.3) * h), cy1 = Math.round((y0 + (y1 - y0) * 0.7) * h);
        const ch = [[], [], []];
        for (let y = cy0; y < cy1; y += 2) for (let x = cx0; x < cx1; x += 2) {
          const o = (y * w + x) * 4;
          ch[0].push(data.data[o]); ch[1].push(data.data[o + 1]); ch[2].push(data.data[o + 2]);
        }
        cell.rgb = ch.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });
      }
      // bare paper colour from the margin
      const pap = [[], [], []];
      for (let y = Math.round(h * 0.985); y < h - 2; y++) for (let x = 10; x < w - 10; x += 7) {
        const o = (y * w + x) * 4;
        pap[0].push(data.data[o]); pap[1].push(data.data[o + 1]); pap[2].push(data.data[o + 2]);
      }
      const paper = pap.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });
      return { png: px.png, swatches: cells, paper, medium: LIB.medium, paperType: app.state.paper, dried };
    });
  }

  // ------------------------------------------------------------ search
  // Many candidates from one state, scored in the page on a small readback:
  // restore, paint, (dry), compare with the target where the candidate
  // changed the sheet — the judge's local measures, without images or Python.
  const EV = { W: 384, H: 0, T: null, key: null, paperL: 95 };
  const lab = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const Y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
  };
  function blur3(a, w, h) {   // separable [1 2 1]/4, twice ≈ σ 1
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass ? o : a;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; t[i] = 0.25 * src[i - (x > 0)] + 0.5 * src[i] + 0.25 * src[i + (x < w - 1)]; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = 0.25 * t[i - (y > 0 ? w : 0)] + 0.5 * t[i] + 0.25 * t[i + (y < h - 1 ? w : 0)]; }
    }
    return o;
  }
  function filt(a, w, h, r, mx) {   // separable square max (mx) or min filter
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    const pick = mx ? Math.max : Math.min;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = a[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, a[y * w + k]);
      t[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = t[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, t[k * w + x]);
      o[y * w + x] = v;
    }
    return o;
  }
  let evCanvas = null;
  function readL() {
    ensureDisplay();
    engine.render();
    if (!evCanvas) { evCanvas = document.createElement('canvas'); evCanvas.width = EV.W; evCanvas.height = EV.H; }
    const g = evCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(engine.canvas, 0, 0, EV.W, EV.H);
    const d = g.getImageData(0, 0, EV.W, EV.H).data;
    const L = new Float32Array(EV.W * EV.H);
    for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = lab(d[i], d[i + 1], d[i + 2]);
    return blur3(L, EV.W, EV.H);
  }
  // ---- structure: the local structure tensor (edge strength and direction,
  // smoothed so a sub-millimetre shift does not count), at 0.4 mm per pixel
  const SW = 768;
  let sCanvas = null;
  function lumAt(src, W, H) {
    if (!sCanvas || sCanvas.width !== W) { sCanvas = document.createElement('canvas'); sCanvas.width = W; sCanvas.height = H; }
    const g = sCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const L = new Float32Array(W * H);
    for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = lab(d[i], d[i + 1], d[i + 2]);
    return blur3(L, W, H);
  }
  // edge strength and direction at 0.4 mm, pooled to 0.8 mm cells, then
  // compared at two tolerances (≈0.8 mm and ≈2 mm), like the tone terms:
  // structure is what kind of marks are here (crisp or soft, which way they
  // run, how dense), not exactly where each edge falls
  function tensor(L, W, H) {
    const w2 = W >> 1, h2 = H >> 1;
    const xx = new Float32Array(w2 * h2), xy = new Float32Array(w2 * h2), yy = new Float32Array(w2 * h2);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1]) / 8;
      const gy = (L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1]) / 8;
      const j = Math.min(h2 - 1, y >> 1) * w2 + Math.min(w2 - 1, x >> 1);
      xx[j] += gx * gx * 0.25; xy[j] += gx * gy * 0.25; yy[j] += gy * gy * 0.25;
    }
    const sm = (a, k) => { let r = a; for (let q = 0; q < k; q++) r = blur3(r, w2, h2); return r; };
    return { W: w2, H: h2, s: [1, 5].map((k) => ({ xx: sm(xx, k), xy: sm(xy, k), yy: sm(yy, k) })) };
  }
  function readS() {   // after readL: the display is already rendered
    const W = SW, H = Math.round((SW * engine.ny) / engine.nx);
    const L = lumAt(engine.canvas, W, H);
    return { L, J: tensor(L, W, H) };
  }
  // How much closer a candidate brings the local structure to the target's,
  // where it changed the sheet: 100 = matches it there, 0 = no closer,
  // negative = further (edges where the target has none, or its edges
  // blurred away). Mean of the two tolerances.
  function structureScore(Sb, Sc) {
    const T = EV.S; if (!T) return 0;
    const W = T.J.W, H = T.J.H, n = W * H, LW = T.W;
    const ch = new Float32Array(n);
    let any = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (2 * y) * LW + 2 * x;
      if (Math.abs(Sc.L[i] - Sb.L[i]) > 2 || Math.abs(Sc.L[i + 1] - Sb.L[i + 1]) > 2) { ch[y * W + x] = 1; any++; }
    }
    if (any < 4) return 0;
    const M = filt(ch, W, H, 3, true);
    let tot = 0;
    for (let k = 0; k < 2; k++) {
      const A = Sb.J.s[k], B = Sc.J.s[k], G = T.J.s[k];
      let eb = 0, ec = 0, N = 0;
      for (let i = 0; i < n; i++) {
        if (!M[i]) continue;
        const d = (X) => { const a = X.xx[i] - G.xx[i], b = X.xy[i] - G.xy[i], c = X.yy[i] - G.yy[i]; return Math.sqrt(a * a + 2 * b * b + c * c); };
        const m = (X) => Math.sqrt(X.xx[i] * X.xx[i] + 2 * X.xy[i] * X.xy[i] + X.yy[i] * X.yy[i]);
        eb += d(A); ec += d(B); N += m(G) + m(A);
      }
      tot += N > 0 ? (100 * (eb - ec)) / N : 0;
    }
    return tot / 2;
  }
  function setTarget(dataUrl, key, paperL) {
    if (EV.key === key && EV.T) return Promise.resolve(true);
    EV.H = Math.round((EV.W * engine.ny) / engine.nx);
    evCanvas = null;
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = EV.W; c.height = EV.H;
        const g = c.getContext('2d'); g.drawImage(im, 0, 0, EV.W, EV.H);
        const d = g.getImageData(0, 0, EV.W, EV.H).data;
        const L = new Float32Array(EV.W * EV.H);
        for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = lab(d[i], d[i + 1], d[i + 2]);
        const T = blur3(L, EV.W, EV.H), W = EV.W, H = EV.H;
        EV.paperL = paperL || 95;
        const DT = T.map((v) => Math.max(0, EV.paperL - v));
        EV.T = T;
        EV.at = {};
        for (const r of [2, 6]) EV.at[r] = { DTmax: filt(DT, W, H, r, true), Tmin: filt(T, W, H, r, false), Tmax: filt(T, W, H, r, true) };
        { const SWd = SW, SH = Math.round((SW * engine.ny) / engine.nx); const L2 = lumAt(im, SWd, SH); EV.S = { W: SWd, H: SH, L: L2, J: tensor(L2, SWd, SH) }; }
        EV.key = key;
        res(true);
      };
      im.onerror = () => rej(new Error('target image failed to load'));
      im.src = dataUrl;
    });
  }
  // distance from A(p) to the range of target values within r of p
  const tolErr = (A, i, at) => Math.max(0, A[i] - at.Tmax[i], at.Tmin[i] - A[i]);
  function scoreAgainst(Lb, Lc) {
    const W = EV.W, H = EV.H, n = W * H, P = EV.paperL;
    const ch = new Float32Array(n);
    let any = 0;
    for (let i = 0; i < n; i++) if (Math.abs(Lc[i] - Lb[i]) > 2.5) { ch[i] = 1; any++; }
    if (any < 5) return { verdict: 'no change', net: 0, area: 0 };
    const M = filt(ch, W, H, 3, true);
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    const res = {};
    for (const r of [2, 6]) {
      const at = EV.at[r];
      let eb = 0, ea = 0, over = 0, cnt = 0, newInk = 0, hit = 0;
      for (let i = 0; i < n; i++) {
        if (!M[i]) continue;
        cnt++;
        eb += tolErr(Lb, i, at); ea += tolErr(Lc, i, at);
        const DC = Math.max(0, P - Lc[i]), DP = Math.max(0, P - Lb[i]);
        const tol = Math.max(4, 0.25 * at.DTmax[i]);
        over += Math.max(0, DC - at.DTmax[i] - tol);
        if (DC - DP > 4) { newInk++; if (at.DTmax[i] >= DC - tol) hit++; }
        if (r === 2) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      eb /= cnt; ea /= cnt; over /= cnt;
      const local = (100 * (eb - ea)) / Math.max(eb, 1e-6);
      res[r] = { local, over, prec: newInk ? hit / newInk : 1, net: local - 10 * over };
      area = cnt / n;
    }
    // the sheet as a whole, for comparing candidates that paint different areas
    let gb = 0, gc = 0;
    for (let i = 0; i < n; i++) { gb += tolErr(Lb, i, EV.at[2]); gc += tolErr(Lc, i, EV.at[2]); }
    const net = 0.5 * (res[2].net + res[6].net);
    const verdict = net < 0 ? 'worse' : res[2].over > 1 || res[2].prec < 0.8 ? 'flawed' : 'better';
    return {
      verdict, net: +net.toFixed(1), net_fine: +res[2].net.toFixed(1), net_coarse: +res[6].net.toFixed(1),
      local_error_change: +res[2].local.toFixed(1), precision: +res[2].prec.toFixed(2), over_dark: +res[2].over.toFixed(2),
      area: +area.toFixed(4), sheet_error_change: +((gc - gb) / n).toFixed(3),
      bbox: [+(x0 / W).toFixed(3), +(y0 / H).toFixed(3), +((x1 + 1) / W).toFixed(3), +((y1 + 1) / H).toFixed(3)],
    };
  }

  // ------------------------------------------------------------ api
  const bigs = new Map();
  let bigId = 0;
  const bot = {
    version: 1,
    // Start a fresh sheet. medium: 'watercolor' | 'ink'; paper: see info().papers
    init(o) {
      o = o || {};
      const medium = o.medium || 'watercolor';
      if (app.state.medium !== medium) app.setMedium(medium, true);
      // a run can pin an older palette and older simulation settings, so it
      // replays as it was painted
      LIB.use(medium, o.palette);
      engine._initPigmentUniforms();
      Object.assign(engine.P, window.WatercolorEngine.DEFAULTS, o.engine || {});
      const paper = o.paper || (medium === 'ink' ? 'xuan' : medium === 'pencil' ? 'drawing' : medium === 'gouache' ? 'board' : 'cold');
      if (medium === 'pencil' && !['bristol', 'drawing', 'toothy'].includes(paper)) throw new Error('pencil papers: bristol (smooth), drawing, toothy');
      if (medium === 'gouache' && !['board', 'canvas', 'cold'].includes(paper)) throw new Error('gouache papers: board, canvas, cold');
      app.setPaper(paper, true);
      for (const s of snaps.values()) free(s);
      snaps.clear();
      if (o.maxResident) maxResident = o.maxResident;
      if (o.displayWidth) displayW = o.displayWidth;
      engine.clear();
      engine._simAccum = 0; engine._dryReadings = 0; engine._framesSinceProbe = 0; engine._lastT = 0;
      if (engine._probe) { engine.gl.deleteSync(engine._probe); engine._probe = null; }
      app.painter.queue = []; app.painter.cur = null; app.painter.running = false;
      clock = 0;
      rng = (o.seed >>> 0) || 1;
      cur = defaults(medium);
      lastPaint = null;
      board = { tilt: [0, 0], dryer: false, humidity: o.humidity == null ? 55 : o.humidity };
      app.setTilt(0, 0); app.setDryer(false); app.setHumidity(board.humidity);
      brush.configure(cur.brush, cur.size);
      brush.loaded = false; brush.placed = false; brush.pointer = null;
      app.state.brushType = cur.brush; app.state.sizeIdx = cur.size;
      engine.awake = false;
      bot.runId = o.runId || null;
      bot.head = null;
      return info();
    },
    info, status,
    // Apply a list of actions. Stops at the first invalid action and reports
    // how many were applied, so the caller can log exactly what happened.
    // o.footprints: width in px of a small render taken after every action,
    // so a checkpoint's judge can tell which action put ink where.
    run(actions, o) {
      o = o || {};
      if (!Array.isArray(actions)) throw new Error('actions must be an array');
      let jobs;
      try { jobs = plan(actions); } catch (e) { return { done: 0, error: String(e.message), invalid: true }; }
      const t0 = clock;
      let done = 0;
      const footprints = [];
      try {
        for (const j of jobs) {
          const a = actions[done];
          label = a.label || a.type;
          j();
          done++;
          // a footprint after every action, or only after the listed ones
          // (a library stroke can expand to hundreds of raw strokes)
          if (o.footprints && (!o.at || o.at.includes(done - 1))) footprints.push(small(o.footprints));
        }
        label = '';
      } catch (e) {
        return { done, error: `action ${done} (${actions[done].type}) failed while painting: ${e.message}`, midway: true };
      }
      const r = { done, seconds: +((clock - t0) / 1000).toFixed(2), clock: +(clock / 1000).toFixed(2), awake: engine.awake };
      if (o.footprints) r.footprints = footprints;
      return r;
    },
    validate(actions) {
      try { plan(actions); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message) }; }
    },
    snapshot(id) { remember(id, capture()); bot.head = id; return [...snaps.keys()]; },
    has(id) { return snaps.has(id); },
    restore(id) {
      const s = snaps.get(id);
      if (!s) return false;
      apply(s);
      snaps.delete(id); snaps.set(id, s);   // most recently used
      bot.head = id;
      return true;
    },
    drop(id) { const s = snaps.get(id); if (s) { free(s); snaps.delete(id); } },
    render,
    // What the sheet will look like once everything now wet has dried; the
    // present state is untouched.
    previewDry(o) {
      o = o || {};
      return aside(() => {
        const r = engine.awake ? dryUntil(o.max || 240, o.dryer !== false) : { seconds: 0, dry: true };
        return Object.assign(r, { png: render() });
      });
    },
    // Paint on a blank scrap of the same paper and show it dried; the
    // painting is untouched.
    scratch(actions, o) {
      o = o || {};
      return aside(() => {
        engine.clear();
        const res = bot.run(actions);
        const d = dryUntil(o.max || 240, true);
        return { done: res.done, error: res.error, paintSeconds: res.seconds, drySeconds: d.seconds, dry: d.dry, png: render() };
      });
    },
    // Apply actions to the painting as it stands, look at the dried result,
    // then put everything back.
    lookahead(actions, o) {
      o = o || {};
      return aside(() => {
        const res = bot.run(actions);
        const d = dryUntil(o.max || 240, true);
        return { done: res.done, error: res.error, paintSeconds: res.seconds, drySeconds: d.seconds, dry: d.dry, png: render() };
      });
    },
    calibrate,
    // The app's own demo painting for this medium, dried: a sample of what
    // the simulation's paper, pigments and brushes look like.
    demoSample(seed) {
      return aside(() => {
        engine.clear();
        const p = app.painter;
        p.start(LIB.medium === 'ink' ? app.bambooScript(seed || 424242) : app.demoScript());
        let guard = 0;
        while (p.running && ++guard < 60 * 900) frame();
        app.setTilt(0, 0);
        dryUntil(300, true);
        return { png: render() };
      });
    },
    setMaxResident(n) { maxResident = Math.max(1, n | 0); },
    // The simulation state as raw floats (base64), to re-render a painting
    // later without replaying it; loadState puts such a dump back.
    dumpState(names) {
      const out = { nx: engine.nx, ny: engine.ny };
      // everything a snapshot holds besides the textures, so a dump can be
      // resumed from exactly as if the painting had been replayed to here
      const st = app.state;
      out.meta = JSON.stringify({
        engine: { awake: engine.awake, simAccum: engine._simAccum, dryReadings: engine._dryReadings, framesSinceProbe: engine._framesSinceProbe, status: engine.status, lastT: engine._lastT || 0 },
        app: { tool: st.tool, brushType: st.brushType, sizeIdx: st.sizeIdx, water: st.water, load: st.load, mix: st.mix.slice(), tipDip: st.tipDip, pressure: st.pressure, marble: st.marble },
        brush: Object.fromEntries(Object.entries(brushState()).map(([k, v]) => [k, ArrayBuffer.isView(v) ? { __ta: v.constructor.name, a: Array.from(v) } : v])),
        board, cur, lastPaint, clock, rng,
      });
      for (const k of names || TEX) {
        const u = new Uint8Array(engine.readTexture(k).buffer);
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        out[k] = btoa(s);
      }
      return out;
    },
    loadState(o) {
      const gl = engine.gl;
      if (o.meta) {
        const m = JSON.parse(o.meta);
        if (engine._probe) { gl.deleteSync(engine._probe); engine._probe = null; }
        engine.stampCount = 0;
        engine.awake = m.engine.awake; engine._simAccum = m.engine.simAccum; engine._dryReadings = m.engine.dryReadings;
        engine._framesSinceProbe = m.engine.framesSinceProbe; engine.status = m.engine.status; engine._lastT = m.engine.lastT;
        Object.assign(app.state, m.app);
        setBrushState(Object.fromEntries(Object.entries(m.brush).map(([k, v]) => [k, v && v.__ta ? new window[v.__ta](v.a) : v])));
        board = m.board; app.setTilt(board.tilt[0], board.tilt[1]); app.setDryer(board.dryer); app.setHumidity(board.humidity);
        engine.awake = m.engine.awake;
        cur = m.cur; lastPaint = m.lastPaint; clock = m.clock; rng = m.rng;
      }
      for (const k of Object.keys(o)) {
        if (k === 'meta') continue;
        if (!engine[k] || !engine[k].r) continue;
        const v = o[k] && o[k].__big ? bigs.get(o[k].__big) : o[k];
        if (o[k] && o[k].__big) bigs.delete(o[k].__big);
        const s = atob(v), u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        gl.bindTexture(gl.TEXTURE_2D, engine[k].r);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, engine.nx, engine.ny, gl.RGBA, gl.FLOAT, new Float32Array(u.buffer));
      }
      engine.dirty = true;
      return true;
    },
    setTarget,
    // evaluate({ candidates: [[actions], ...], dry: true, shots: false }): each
    // candidate from the present state, scored where it painted (with shots, a
    // jpeg of it too); the present is untouched
    evaluate(o) {
      if (!EV.T) throw new Error('no target set (setTarget)');
      const t0 = clock;
      const w0 = Date.now();
      // band: the outline(s) the new ink should stay inside (sheet fractions);
      // ink landing outside it costs the candidate
      let band = null;
      if (o.band && o.band.length) {
        const c = document.createElement('canvas'); c.width = EV.W; c.height = EV.H;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        for (const poly of o.band) { g.beginPath(); poly.forEach(([x, y], i) => (i ? g.lineTo(x * EV.W, y * EV.H) : g.moveTo(x * EV.W, y * EV.H))); g.closePath(); g.fill(); }
        const d = g.getImageData(0, 0, EV.W, EV.H).data;
        band = new Float32Array(EV.W * EV.H);
        for (let i = 0; i < band.length; i++) band[i] = d[i * 4] > 127 ? 1 : 0;
      }
      const results = aside(() => {
        const base = capture();
        const wS = o.structure == null ? 1 : o.structure;
        let Sb = null;
        const Lb = (() => { if (o.dry !== false && engine.awake) { dryUntil(240, true); const L = readL(); if (wS) Sb = readS(); apply(base); return L; } const L = readL(); if (wS) Sb = readS(); return L; })();
        const out = [];
        for (let k = 0; k < o.candidates.length; k++) {
          apply(base);
          const t1 = Date.now();
          const r = bot.run(o.candidates[k]);
          if (r.error) { out.push({ i: k, error: r.error }); continue; }
          let dried = null;
          if (o.dry !== false) dried = dryUntil(o.max || 240, true);
          const Lc = readL();
          const sc = scoreAgainst(Lb, Lc);
          if (wS && Sb && sc.verdict !== 'no change') {
            const st = structureScore(Sb, readS());
            sc.structure = +st.toFixed(1);
            sc.net_tone = sc.net;
            sc.net = +(sc.net + wS * st).toFixed(1);
          }
          if (band) {
            let tot = 0, out_ = 0;
            for (let q = 0; q < Lc.length; q++) { const dd = Lb[q] - Lc[q] - 1.5; if (dd > 0) { tot += dd; if (!band[q]) out_ += dd; } }
            const f = tot > 0 ? out_ / tot : 0;
            sc.outside = +f.toFixed(3);
            sc.net_unbanded = sc.net;
            sc.net = +(sc.net > 0 ? sc.net * Math.pow(1 - f, 2) : sc.net - 20 * f).toFixed(1);
          }
          out.push(Object.assign({ i: k, ms: Date.now() - t1, paint_s: r.seconds, dry_s: dried ? dried.seconds : 0 }, sc));
          if (o.shots) out[out.length - 1].jpg = engine.canvas.toDataURL('image/jpeg', 0.9);   // readL left the display rendered
        }
        free(base);
        return out;
      });
      clock = t0;
      return { results, ms: Date.now() - w0 };
    },
    // record({ every: 4, sparseEvery: 30, width: 1280, quality: 0.85, brush: true }) or record(null)
    record(o) {
      if (!o) { rec = null; return false; }
      if (rec && rec.w === (o.width || 1280)) { Object.assign(rec, { every: o.every || 4, sparseEvery: o.sparseEvery || 30, q: o.quality || 0.85, brush: o.brush !== false }); return true; }
      rec = { every: o.every || 4, sparseEvery: o.sparseEvery || 30, w: o.width || 1280, q: o.quality || 0.85, brush: o.brush !== false, n: 0, frames: [], sparse: false, paused: false };
      return true;
    },
    frameCount() { return rec ? rec.frames.length : 0; },
    takeFrames(n) { return rec ? rec.frames.splice(0, n || 8) : []; },
    grabNow() { if (rec) grab(); return bot.frameCount(); },
    cameraMove(to, n) { return cameraMove(to, n || 0); },
    // cut to `to` after k more recorded frames with the brush on the paper
    // (a painter keeps looking at the whole sheet a moment before leaning in)
    cameraCutAfter(to, k) {
      if (!rec) return 0;
      to = to && to[2] - to[0] < 0.999 ? to : null;
      if (k > 0) rec.pending = { to, k }; else cameraMove(to, 0);
      return k;
    },
    cameraView() { return rec ? rec.view || null : null; },
    // Large strings (PNG data URLs) go back to the command line in pieces:
    // one DevTools message tops out at a few megabytes.
    _pack(r) {
      const big = (v) => typeof v === 'string' && v.length > 262144;
      const stash = (v) => { const id = 'b' + (++bigId); bigs.set(id, v); return { __big: id, n: v.length }; };
      if (big(r)) return stash(r);
      // images inside arrays (footprints) go back one at a time too: a few
      // MB returned in one message kills the headless page
      const many = (v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.length > 32768);
      if (r && typeof r === 'object') for (const k of Object.keys(r)) {
        if (big(r[k])) r[k] = stash(r[k]);
        else if (many(r[k])) r[k] = r[k].map((x) => (typeof x === 'string' && x.length > 32768 ? stash(x) : x));
      }
      return r;
    },
    _take(id, start, len) { const v = bigs.get(id); return v == null ? null : v.slice(start, start + len); },
    _free(id) { bigs.delete(id); },
    // large arguments arrive in pieces too
    _put(id, piece) { bigs.set(id, (bigs.get(id) || '') + piece); return true; },
  };
  window.inkBot = bot;
})();
