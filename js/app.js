// UI, brush model, pointer input and the demo painter.
(function () {
  'use strict';

  const LIB = window.WC_PIGMENTS;
  const swatch = (c) => LIB.swatch(c);
  const shortName = (i) => LIB.PIGMENTS[i].short;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  const mix = (a, b, t) => a + (b - a) * t;
  const PAPER_LABEL = { hot: 'Hot press', cold: 'Cold press', rough: 'Rough', xuan: 'Raw xuan', xuanHalf: 'Half-sized xuan', xuanSized: 'Sized xuan', bristol: 'Smooth bristol', drawing: 'Drawing paper', toothy: 'Toothy laid paper', board: 'Illustration board', canvas: 'Primed canvas' };
  const PAPERS = {
    watercolor: [['hot', 'Hot press'], ['cold', 'Cold press'], ['rough', 'Rough']],
    ink: [['xuan', 'Raw xuan'], ['xuanHalf', 'Half-sized'], ['xuanSized', 'Sized']],
    pencil: [['bristol', 'Bristol'], ['drawing', 'Drawing'], ['toothy', 'Toothy']],
    gouache: [['board', 'Board'], ['canvas', 'Canvas'], ['cold', 'Cold press']],
  };
  const TOOLS = ['brush', 'water', 'lift', 'spatter', 'salt', 'pencil', 'stump', 'eraser'];
  // Pencil grades: how dark one pass lays (dark), how readily the lead
  // crumbles down into the tooth and wears (soft), and how dark it can ever
  // get however much it is layered (cap, 1 = the softest pressed hard).
  const GRADES = {
    '4H': { dark: 0.3, soft: 0.1, cap: 0.24 },
    '2H': { dark: 0.38, soft: 0.2, cap: 0.33 },
    HB: { dark: 0.5, soft: 0.4, cap: 0.47 },
    '2B': { dark: 0.6, soft: 0.55, cap: 0.6 },
    '4B': { dark: 0.7, soft: 0.7, cap: 0.74 },
    '6B': { dark: 0.8, soft: 0.85, cap: 0.87 },
    '8B': { dark: 0.88, soft: 0.95, cap: 1.0 },
  };

  // How each eraser lifts graphite: vinyl is hard and rides the tops of the
  // tooth until pressed; putty conforms into it but takes only a little each
  // touch. strength: the share of loose graphite one firm pass takes; reach:
  // how far into the tooth it bears, light to firm (the valleys keep a ghost
  // of the mark until it does); edge: 1 crisp (a cut corner), 0 soft; smear:
  // how much graphite it drags along as it goes.
  const ERASERS = {
    vinyl: { strength: 0.95, reach: [0.3, 0.95], edge: 1, smear: 0.07 },
    kneaded: { strength: 0.36, reach: [0.5, 0.85], edge: 0, smear: 0 },
  };

  const state = {
    tool: 'brush',
    sizeIdx: 4,
    water: 0.6,
    load: 0.5,
    reload: true,
    mix: [0, 0, 0, 0, 1, 0, 0, 0],
    mixMode: false,
    paper: 'cold',
    tilt: [0, 0],
    dryer: false,
    humidity: 55,
    medium: 'watercolor',
    tipDip: false,
    brushType: 'round',
    splineInput: true,
    pressure: 0.55,
    showBrush: true,
    grade: 'HB',      // pencil
    sharp: 0.3,       // pencil tip radius, mm (a fresh point)
    side: 0,          // 0 the point, 1 the side of the lead (for shading)
    eraser: 'vinyl',  // vinyl (a plastic block: lifts cleanly, crisp edge) or kneaded (putty: lifts gently)
    eraserSize: 4,    // mm across where it bears on the paper
  };

  const board = $('board'), sheet = $('sheet'), canvas = $('canvas'), cursor = $('cursor');
  const brushView = $('brushView'), brushCtx = brushView.getContext('2d');
  const BV = 170;   // overlay margin around the sheet, css px

  // ------------------------------------------------------------ sheet + engine
  // ?res=<cells> and ?orient=portrait|landscape pin the sheet for scripted use
  const query = new URLSearchParams(location.search);
  const boardRect = board.getBoundingClientRect();
  const portrait = query.has('orient') ? query.get('orient') === 'portrait' : boardRect.height > boardRect.width * 1.08;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 700;
  const longSide = clamp(Math.round(+query.get('res')) || (smallScreen ? 768 : 1024), 256, 2048);
  const nx = portrait ? Math.round(longSide * 0.75) : longSide;
  const ny = portrait ? longSide : Math.round(longSide * 0.75);
  const sheetMM = portrait ? [228.6, 304.8] : [304.8, 228.6];
  const cellsPerMM = nx / sheetMM[0];
  let cssPerMM = 1;
  let engine = null;
  let sheetCss = [1, 1];
  let overlayDirty = true;

  function layout() {
    const r = board.getBoundingClientRect();
    const pad = r.width < 520 ? 28 : 60;
    const availW = Math.max(40, r.width - pad * 2);
    const availH = Math.max(40, r.height - pad * 2);
    const aspect = nx / ny;
    let w = availW, h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    w = Math.floor(w); h = Math.floor(h);
    sheet.style.width = w + 'px';
    sheet.style.height = h + 'px';
    sheet.style.setProperty('--tw', Math.round(clamp(Math.min(w, h) * 0.034, 13, 24)) + 'px');
    cssPerMM = w / sheetMM[0];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    brushView.width = Math.round((w + BV * 2) * dpr);
    brushView.height = Math.round((h + BV * 2) * dpr);
    sheetCss = [w, h];
    overlayDirty = true;
    return [Math.round(w * dpr), Math.round(h * dpr)];
  }

  function showNotice(title, body) {
    const n = $('notice');
    n.innerHTML = '';
    const s = document.createElement('strong');
    s.textContent = title;
    const p = document.createElement('span');
    p.textContent = body;
    n.append(s, p);
    n.hidden = false;
  }

  const [dw, dh] = layout();
  canvas.width = dw;
  canvas.height = dh;
  try {
    engine = new window.WatercolorEngine(canvas, { nx, ny, sheetMM, paperType: state.paper });
  } catch (err) {
    console.error(err);
    const kind = err && err.kind;
    if (kind === 'webgl2') showNotice('WebGL2 is not available', 'This painting simulation needs WebGL2. Try a current version of Chrome, Edge, Safari or Firefox with hardware acceleration turned on.');
    else if (kind === 'float') showNotice('Float render targets are not supported', 'Your GPU or browser cannot render to floating-point textures, which the water simulation depends on. A desktop browser usually can.');
    else showNotice('The simulation could not start', String(err && err.message || err));
    return;
  }
  window.inkEngine = engine;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showNotice('The graphics context was lost', 'Your GPU reset or ran out of memory. Reload the page to keep painting; the current sheet cannot be recovered.');
  });

  let resizeTimer = 0;
  new ResizeObserver(() => {
    const [w, h] = layout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => engine.resizeDisplay(w, h), 120);
  }).observe(board);

  function applyTheme() {
    const root = document.documentElement;
    const t = root.getAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    engine.exposure = dark ? 0.94 : 1;
    engine.dirty = true;
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ------------------------------------------------------------ brush model
  const pigmentStrength = (load) => 0.4 + 14 * Math.pow(load, 1.5);

  function mixConc(scale, load) {
    const tot = state.mix.reduce((a, b) => a + b, 0) || 1;
    const C = pigmentStrength(load == null ? state.load : load) * (scale || 1);
    return state.mix.map((v) => (v / tot) * C);
  }
  // Gouache on the brush: the share of each colour in the paint (the rest is
  // gum and filler); thinning it with water lowers the pigment in it, so it
  // covers less.
  function paintConc() {
    const tot = state.mix.reduce((a, b) => a + b, 0) || 1;
    const body = 1 - 0.85 * clamp(state.water, 0, 1);
    return state.mix.map((v) => (v / tot) * body);
  }

  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const brush = new window.BristleBrush(cellsPerMM);
  brush.flatAngle = Math.PI / 2 - 0.2;
  brush.configure(state.brushType, state.sizeIdx);
  window.inkBrush = brush;

  // Centripetal Catmull-Rom point between p1 and p2 (u in 0..1). Pointer
  // samples arrive at the event rate; joining them with straight lines
  // leaves corners on fast curves and makes the brush's lean jump at every
  // sample, so the stroke follows a spline through them instead.
  function catmullRom(p0, p1, p2, p3, u) {
    const d01 = Math.max(1e-4, Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)));
    const d12 = Math.max(1e-4, Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)));
    const d23 = Math.max(1e-4, Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)));
    const t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
    const t = t1 + (t2 - t1) * u;
    const L = (a, b, ta, tb) => { const f = (t - ta) / (tb - ta); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; };
    const P0 = [p0.x, p0.y], P1 = [p1.x, p1.y], P2 = [p2.x, p2.y], P3 = [p3.x, p3.y];
    const A1 = L(P0, P1, t0, t1), A2 = L(P1, P2, t1, t2), A3 = L(P2, P3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  }

  // A stroke made with the bristle brush (brush and clean-water tools).
  // The path is splined through the input samples (one sample behind the
  // pointer) and subdivided so no tuft moves more than about its own width
  // per physics step. The brush settles onto the paper over the first few
  // tens of milliseconds and keeps travelling as it lifts off.
  class PaintStroke {
    constructor(tool, pen) {
      this.tool = tool;
      this.pen = pen;
      this.down = true;
      this.last = null;      // where the brush has actually been moved to
      this.raw = [];         // input samples; raw[this.at] is where the brush is
      this.at = 0;
      this.vel = [0, 0];
      this.tilt = null;
      if ((state.reload || !brush.loaded) && state.medium === 'gouache') {
        // the load is how much paint the brush picks up; a damp clean brush blends
        brush.dip(tool === 'water' ? null : paintConc(), tool === 'water' ? 0.25 : state.load, tool === 'water' ? 0.04 : 0.12);
        if (tool !== 'water') brush.marble(state.marble == null ? 0.35 : state.marble);
      } else if (state.reload || !brush.loaded) {
        brush.dip(tool === 'water' ? null : mixConc(), state.water, tool === 'water' ? 0.04 : 0.12);
        if (tool === 'brush' && state.medium === 'ink' && state.tipDip) brush.tipDip(mixConc(1, 0.95), 0.9);
      }
    }

    move(x, y, p, t, tilt) {
      this.tilt = tilt || null;
      const s = { x, y, p, t };
      if (!this.last) {
        const hx = brush.pointer ? brush.pointer[0] : x, hy = brush.pointer ? brush.pointer[1] : y;
        if (Math.hypot(hx - x, hy - y) > 30) brush.placed = false;
        this.t0 = t;
        this.last = { x, y, p, t: t - 4 };
        this._advance(x, y, p, t);
        this.raw = [s];
        this.at = 0;
        return;
      }
      const prev = this.raw[this.raw.length - 1];
      if (Math.hypot(x - prev.x, y - prev.y) < 0.05 && t - prev.t < 4) return;
      const dt = Math.max(1, t - prev.t);
      this.vel[0] += ((x - prev.x) / dt - this.vel[0]) * 0.35;
      this.vel[1] += ((y - prev.y) / dt - this.vel[1]) * 0.35;
      this.raw.push(s);
      if (!state.splineInput) { this._advance(x, y, p, t); this.at = this.raw.length - 1; return; }   // straight segments, for comparison
      while (this.raw.length - 1 - this.at >= 2) this._segment(false);
    }

    // Move the brush along the spline from raw[at] to raw[at + 1].
    _segment(final) {
      const r = this.raw, i = this.at;
      const p1 = r[i], p2 = r[i + 1];
      const p0 = i > 0 ? r[i - 1] : p1;
      const p3 = !final && i + 2 < r.length ? r[i + 2] : p2;
      const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const n = Math.max(1, Math.ceil(chord / Math.max(0.5, brush.rf * 0.9)));
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const [x, y] = catmullRom(p0, p1, p2, p3, u);
        this._advance(x, y, p1.p + (p2.p - p1.p) * u, p1.t + (p2.t - p1.t) * u);
      }
      this.at++;
      if (this.at > 3) { this.raw.splice(0, this.at - 2); this.at = 2; }
    }

    _flush() {
      while (this.at < this.raw.length - 1) this._segment(true);
    }

    _advance(x, y, p, t) {
      const L = this.last;
      const dt = Math.max(1, t - L.t);
      const dist = Math.hypot(x - L.x, y - L.y);
      const n = Math.min(240, Math.max(1, Math.ceil(dist / Math.max(0.5, brush.rf * 0.9)), Math.ceil(dt / 6)));
      const sub = Math.max(1, dt / n);
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        const tt = L.t + sub * k;
        const pr = L.p + (p - L.p) * f;
        const settle = this.lifting ? 1 : smooth(0, this.settleMs || 45, tt - this.t0);
        const pe = mix(-0.35, pr, settle);
        brush.step(sub / 1000, L.x + (x - L.x) * f, L.y + (y - L.y) * f, pe, this.tilt, engine, engine.brushSamples, tt);
      }
      this.last = { x, y, p, t: L.t + sub * n };
      overlayDirty = true;
    }

    // Holding still: catch up with the pointer, then keep releasing water.
    update(now) {
      if (!this.down || !this.last) return;
      const newest = this.raw[this.raw.length - 1];
      if (newest && this.at < this.raw.length - 1 && now - newest.t > 20) this._flush();
      const idle = now - this.last.t;
      if (idle > 12 && this.at >= this.raw.length - 1) this._advance(this.last.x, this.last.y, this.last.p, this.last.t + Math.min(idle, 50));
    }

    end() {
      if (!this.last || !this.down) { this.down = false; return; }
      this._flush();
      const L = this.last;
      const v = this.vel;
      this.lifting = true;
      const steps = 7, dur = this.liftMs || 70;
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        const travel = dur * f * (1 - 0.5 * f);
        this._advance(L.x + v[0] * travel, L.y + v[1] * travel, mix(L.p, -0.45, Math.pow(f, 0.8)), L.t + dur * f);
      }
      this.down = false;
    }
  }

  // Tissue lifting, spatter and salt: dabs rather than bristles.
  class StampStroke {
    constructor(tool) {
      this.tool = tool;
      this.seed = Math.random();
      this.last = null;
      this.toNext = 0;
      this.scatter = 0;
      this.down = true;
      if (tool === 'spatter' && (state.reload || !brush.loaded)) brush.dip(mixConc(), state.water, 0.12);
    }

    width() { return brush.widthMM; }

    move(x, y, pressure, t) {
      this.t = t;
      if (this.tool === 'seal') {
        if (!this.last) { this.last = { x, y, p: pressure }; this.seal(x, y); }
        return;
      }
      if (!this.last) {
        this.last = { x, y, p: pressure };
        if (this.tool === 'spatter') this.spatter(x, y, 16);
        else if (this.tool === 'salt') this.salt(x, y, 9);
        else this.blot(x, y, pressure);
        return;
      }
      const L = this.last;
      const dx = x - L.x, dy = y - L.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.05) return;
      if (this.tool === 'spatter' || this.tool === 'salt') {
        this.scatter += d;
        const every = this.tool === 'spatter' ? 3 : 7;
        while (this.scatter >= every) {
          this.scatter -= every;
          const f = 1 - this.scatter / d;
          const px = L.x + dx * f, py = L.y + dy * f;
          if (this.tool === 'spatter') this.spatter(px, py, 3);
          else this.salt(px, py, 1);
        }
      } else {
        const sp = Math.max(0.5, this.width() * cellsPerMM * 0.08);
        let s = this.toNext;
        while (s <= d) {
          const f = s / d;
          this.blot(L.x + dx * f, L.y + dy * f, L.p + (pressure - L.p) * f);
          s += sp;
        }
        this.toNext = s - d;
      }
      this.last = { x, y, p: pressure };
    }

    update() {}
    end() { this.down = false; }

    blot(x, y, p) {
      const r = Math.max(1, this.width() * (0.55 + 0.45 * p) * cellsPerMM * 0.75);
      // blot down to a thin film, not bone dry, so the wash can creep back and soften the edge
      engine.addStamp({ x, y, r, target: 0.03, strength: 0.6, contact: 1, seed: this.seed, thirst: 1, dryness: 0, shape: 3, t: this.t });
    }

    // Flicking the loaded brush: droplets carry whatever is on it.
    spatter(x, y, count) {
      const spread = this.width() * cellsPerMM * 1.3;
      const conc = brush.meanConc();
      const wetness = 0.4 + 0.6 * brush.reservoir;
      for (let i = 0; i < count; i++) {
        if (brush.reservoir <= 0.01) break;
        const dmm = (0.12 + -Math.log(1 - Math.random() * 0.995) * 0.3 * (0.6 + state.water * 0.8)) * wetness;
        const r = Math.max(0.6, (dmm * cellsPerMM) / 2);
        const target = 0.16 + 0.12 * Math.random();
        engine.addStamp({
          x: x + gauss() * spread, y: y + gauss() * spread,
          r, target, strength: 1, contact: 1, seed: Math.random(),
          conc: Array.from(conc, (c) => c * (0.7 + 0.6 * Math.random())),
          shape: 1, t: this.t,
        });
        brush.drain(Math.PI * r * r * target);
      }
    }

    // A carved seal pressed in cinnabar paste. Seal paste is oil-bound, so
    // it barely wets the paper and prints crisp even on raw xuan.
    seal(x, y) {
      const conc = new Array(8).fill(0);
      conc[5] = 120;
      engine.addStamp({ x, y, r: 6 * cellsPerMM, angle: (Math.random() - 0.5) * 0.05, target: 0.012, strength: 4,
        contact: 1, seed: Math.random(), conc, shape: 5, t: this.t });
    }

    salt(x, y, count) {
      const spread = this.width() * cellsPerMM * 1.8;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
        engine.addStamp({
          x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr,
          r: (0.22 + 0.35 * Math.random()) * cellsPerMM,
          seed: Math.random(), salt: 1, shape: 2, t: this.t,
        });
      }
    }
  }

  // A pencil, stump or eraser moving over the paper. The contact is a
  // capsule swept from each point to the next; the pencil's point wears as
  // it draws (softer grades faster), so a long line thickens a little.
  // Pressure decides how far into the tooth the lead reaches and how dark a
  // pass can get; the side of the lead makes a wide, light, grainy band.
  class PencilStroke {
    constructor(tool) {
      this.tool = tool === 'stump' || tool === 'eraser' ? tool : 'pencil';
      this.g = GRADES[state.grade] || GRADES.HB;
      this.sharp = state.sharp;
      this.side = state.side || 0;
      this.wear = 0;
      this.seed = Math.random();
      let slot = 0, best = -1;
      state.mix.forEach((v, i) => { if (v > best) { best = v; slot = i; } });
      this.slot = slot;
      this.last = null;
      this.held = null;
      this.inst = new Float32Array(24 * 64);
      this.n = 0;
      this.down = true;
    }
    width() { return this.tool === 'eraser' ? state.eraserSize : 2 * (this.sharp + this.wear) + this.side * 4; }
    // the contact's radius (cells) and what it does at pressure pr
    contact(o, pr) {
      const g = this.g;
      let rmm = mix(this.sharp + this.wear, 2.4 + this.sharp, this.side);
      if (this.tool === 'eraser') rmm = 0.5 * clamp(state.eraserSize, 0.6, 30);
      const r = Math.max(0.5, rmm * cellsPerMM);
      o[2] = r; o[3] = r;
      if (this.tool === 'pencil') {
        // a fine point concentrates the pressure: it bites deeper into the
        // tooth than the broad side of the lead does
        const point = (1 - this.side) * clamp(0.45 / (this.sharp + this.wear + 0.15), 0.6, 1.5);
        o[4] = g.dark * Math.pow(pr, 0.8) * (1 - 0.55 * this.side) * (0.85 + 0.2 * point);
        o[5] = clamp(0.18 + 0.8 * pr * (0.45 + 0.55 * g.soft) * (1 - 0.35 * this.side) + 0.14 * point * pr, 0, 1);
        o[6] = g.cap * (0.5 + 0.5 * pr);
      } else if (this.tool === 'stump') o[8] = 0.6 * pr;
      else {
        const E = ERASERS[state.eraser] || ERASERS.vinyl;
        o[9] = E.strength * Math.pow(clamp(pr, 0, 1), 0.6);
        o[12] = mix(E.reach[0], E.reach[1], clamp(pr, 0, 1));
        o[13] = E.edge;
        o[14] = E.smear * pr;
      }
    }
    move(x, y, p, t) {
      const q = { x, y, p: p == null ? state.pressure : p };
      if (!this.last) { this.last = q; return; }
      const L = this.last;
      if (Math.hypot(x - L.x, y - L.y) < 0.45) return;   // a third of a cell
      this.seg(L, q);
      this.last = q;
    }
    seg(a, b) {
      const g = this.g, pr = clamp(0.5 * (a.p + b.p), 0, 1);
      const lenMM = Math.hypot(b.x - a.x, b.y - a.y) / cellsPerMM;
      if (this.tool === 'pencil') this.wear = Math.min(0.6, this.wear + 0.0012 * (0.3 + g.soft) * pr * lenMM);
      const o = new Float32Array(24);
      o[0] = a.x; o[1] = a.y;
      this.contact(o, pr);
      o[7] = this.seed;
      o[10] = this.held ? 0 : 1;   // the stroke's first segment gets a round start
      o[21] = 6; o[22] = b.x; o[23] = b.y;
      if (this.held) this.push(this.held);
      this.held = o;
    }
    push(o) {
      if ((this.n + 1) * 24 > this.inst.length) { const m = new Float32Array(this.inst.length * 2); m.set(this.inst); this.inst = m; }
      this.inst.set(o, this.n * 24);
      this.n++;
    }
    flush() { if (this.n) { engine.pencil(this.inst, this.n, this.slot); this.n = 0; } }
    update() { this.flush(); }
    end() {
      if (this.held) { this.held[10] += 2; this.push(this.held); this.held = null; }
      else if (this.last) {   // a dot
        const o = new Float32Array(24);
        o[0] = this.last.x; o[1] = this.last.y; o[7] = this.seed; o[10] = 3; o[21] = 6; o[22] = this.last.x + 0.01; o[23] = this.last.y;
        this.contact(o, this.last.p);
        this.push(o);
      }
      this.flush();
      this.down = false;
    }
  }

  const makeStroke = (tool, pen) => (state.medium === 'pencil' ? new PencilStroke(tool)
    : tool === 'brush' || tool === 'water' ? new PaintStroke(tool, pen) : new StampStroke(tool));

  // ------------------------------------------------------------ seal
  // The seal reads 墨趣 ("the joy of ink"), a common leisure seal, cut in
  // white-text style: the characters are carved away and print as paper.
  // Glyphs come from a subset of Shippori Mincho; if no font can draw them
  // the seal keeps its generic carved bars.
  const SEAL_TEXT = ['墨', '趣'];
  const SEAL_FONT = '"Shippori Mincho B1", "Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "Noto Serif CJK JP", "SimSun", serif';
  function drawSealGlyphs(chars) {
    const c = document.createElement('canvas');
    c.width = c.height = 192;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 192, 192);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 88px ${SEAL_FONT}`;
    chars.forEach((ch, i) => {
      g.save();
      g.translate(96, 50 + i * 92);
      g.scale(1.22, 0.98);   // seal characters are cut to fill their cell
      g.fillText(ch, 0, 4);
      g.restore();
    });
    return c;
  }
  function buildSeal() {
    const real = drawSealGlyphs(SEAL_TEXT);
    const tofu = drawSealGlyphs(['\uE000', '\uE001']);   // unassigned: renders as a missing-glyph box
    const a = real.getContext('2d').getImageData(0, 0, 192, 192).data;
    const b = tofu.getContext('2d').getImageData(0, 0, 192, 192).data;
    let diff = 0, lit = 0;
    for (let i = 0; i < a.length; i += 4) { diff += Math.abs(a[i] - b[i]); lit += a[i]; }
    const coverage = lit / (255 * 192 * 192);
    if (diff / (255 * 192 * 192) > 0.03 && coverage > 0.08 && coverage < 0.7) engine.setSealMask(real);
  }
  buildSeal();
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`800 88px "Shippori Mincho B1"`, SEAL_TEXT.join('')).then(buildSeal, () => {});
  }

  // ------------------------------------------------------------ pointer input
  let active = null;
  let hover = null;

  function toSim(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * nx, y: (1 - (e.clientY - r.top) / r.height) * ny };
  }
  const pressureOf = (e) => (e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : state.pressure);
  function tiltOf(e) {
    if (e.pointerType !== 'pen' || (!e.tiltX && !e.tiltY)) return null;
    const tx = Math.tan((e.tiltX * Math.PI) / 180), ty = Math.tan((e.tiltY * Math.PI) / 180);
    return [clamp(-tx, -0.9, 0.9), clamp(ty, -0.9, 0.9)];
  }

  function feed(e) {
    const p = toSim(e);
    active.stroke.move(p.x, p.y, pressureOf(e), e.timeStamp, tiltOf(e));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (painter.running) painter.stop();
    canvas.setPointerCapture(e.pointerId);
    engine.pushUndo();
    updateUndo();
    if (active) active.stroke.end();
    active = { id: e.pointerId, stroke: makeStroke(state.tool, e.pointerType === 'pen') };
    feed(e);
    moveCursor(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (!active || e.pointerId !== active.id) {
      if (e.pointerType !== 'touch') { const p = toSim(e); hover = { x: p.x, y: p.y }; }
      return;
    }
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) list.forEach(feed);
    else feed(e);
  });
  const endStroke = (e) => {
    if (!active || e.pointerId !== active.id) return;
    active.stroke.end();
    active = null;
    if (e.pointerType !== 'touch') { const p = toSim(e); hover = { x: p.x, y: p.y }; }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') cursor.style.display = 'none';
    if (!active) { hover = null; overlayDirty = true; }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const bristlesShown = () => state.showBrush && (state.tool === 'brush' || state.tool === 'water');
  function cursorDiameterCSS() {
    const w = brush.widthMM;
    if (state.tool === 'spatter') return w * 2.6 * 1.6 * cssPerMM;
    if (state.tool === 'salt') return w * 3.6 * cssPerMM;
    if (state.tool === 'lift') return w * 1.24 * 0.87 * cssPerMM;
    return w * (0.35 + 0.65 * state.pressure) * cssPerMM;
  }
  function moveCursor(e) {
    if (e.pointerType === 'touch') { cursor.style.display = 'none'; return; }
    const r = sheet.getBoundingClientRect();
    const d = Math.max(4, cursorDiameterCSS());
    cursor.style.display = bristlesShown() ? 'none' : 'block';
    cursor.style.width = cursor.style.height = d + 'px';
    cursor.style.left = e.clientX - r.left + 'px';
    cursor.style.top = e.clientY - r.top + 'px';
    cursor.classList.toggle('dashed', state.tool === 'spatter' || state.tool === 'salt');
  }

  // The pencil (or eraser, or stump) as it is held: its point where the
  // stroke is, lifted between strokes, its body running back toward a right
  // hand whose forearm pivots at an elbow off the lower right of the sheet.
  const toolPose = { x: null, y: null, z: 30, azim: 0.6, tool: 'pencil', side: 0, sharp: 0.3, wear: 0, eraser: 'vinyl', eraserSize: 4, air: false };
  function restPose() { toolPose.x = nx * 1.06; toolPose.y = -ny * 0.08; toolPose.z = 30; }
  function updateToolPose(dt) {
    if (state.medium === 'gouache') return updateBrushPose(dt);
    if (state.medium !== 'pencil') return;
    if (toolPose.x == null) restPose();
    const st = active ? active.stroke : painterStroke;
    const pen = st instanceof PencilStroke ? st : null;
    let zt = 9;
    if (pen && pen.down && pen.last) { toolPose.x = pen.last.x; toolPose.y = pen.last.y; zt = 0; toolPose.wear = pen.wear; }
    else if (!toolPose.air && hover && !active) { toolPose.x = hover.x; toolPose.y = hover.y; }
    if (!toolPose.air) toolPose.z += (zt - toolPose.z) * Math.min(1, dt / 30);
    const tool = pen ? pen.tool : state.tool;
    toolPose.tool = tool === 'stump' || tool === 'eraser' ? tool : 'pencil';
    toolPose.side = state.side; toolPose.sharp = state.sharp; toolPose.eraser = state.eraser; toolPose.eraserSize = state.eraserSize;
    const ex = nx * 1.2 - toolPose.x, ey = toolPose.y + ny * 0.62;   // to the elbow (screen axes, y down)
    toolPose.azim = Math.atan2(ey, ex) - 0.18;
    overlayDirty = true;
  }
  // Gouache: the whole brush as it is held, its hair in the paint it
  // carries, set down where the stroke is and carried through the air
  // between strokes, like the pencil.
  const brushHair = (o) => o.map(([f, c]) => [f, 'rgb(' + c.map((v) => Math.round(clamp(v, 0, 255))).join(',') + ')']);
  function updateBrushPose(dt) {
    if (toolPose.x == null) restPose();
    const st = active ? active.stroke : painterStroke;
    const down = st instanceof PaintStroke && st.down && brush.pointer;
    let zt = 12;
    if (down) { toolPose.x = brush.pointer[0]; toolPose.y = brush.pointer[1]; zt = 0; }
    else if (!toolPose.air && hover && !active) { toolPose.x = hover.x; toolPose.y = hover.y; }
    if (!toolPose.air) toolPose.z += (zt - toolPose.z) * Math.min(1, dt / 30);
    toolPose.tool = 'paintbrush';
    toolPose.hairLen = brush.S.length; toolPose.hairW = brush.S.width; toolPose.flat = brush.T.section === 'flat';
    const c = brush.meanConc(), amt = c.reduce((a, b) => a + b, 0);
    if (amt > 0.02 && brush.loaded) {
      const k = 0.3 / Math.max(amt, 0.3), rgb = LIB.reflectRGB(Array.from(c, (v) => v * k));
      const hair = brush.T.hair, f = clamp(amt * 1.4, 0, 1) * clamp(brush.meanWet * 1.6, 0.35, 1);
      const m = (a, b) => a.map((v, i) => v + (b[i] - v) * f);
      toolPose.hairStops = brushHair([[0, m(hair.map((v) => v * 1.15 + 20), rgb.map((v) => v * 1.1 + 18))], [0.45, m(hair, rgb)], [1, m(hair.map((v) => v * 0.6), rgb.map((v) => v * 0.62))]]);
    } else toolPose.hairStops = null;
    const ex = nx * 1.2 - toolPose.x, ey = toolPose.y + ny * 0.62;
    toolPose.azim = Math.atan2(ey, ex) - 0.18;
    overlayDirty = true;
  }
  const pencilShown = () => state.showBrush && state.medium === 'pencil';
  // the tool over a sheet drawn at scale px per cell, offset (ox, oy)
  function drawTool(ctx, v, painting) {
    if (state.medium === 'pencil' || state.medium === 'gouache') {
      if (window.PencilView && toolPose.x != null) window.PencilView.draw(ctx, toolPose, Object.assign({ nx, ny, cellsPerMM }, v));
    } else if (painting !== false) brush.draw(ctx, v);
  }

  // Oblique view of the simulated brush head, drawn over the sheet.
  let overlayShown = false;
  function drawOverlay() {
    const want = (bristlesShown() && !!(active || hover || painterStroke)) || (pencilShown() && toolPose.x != null);
    if (!want && !overlayShown) return;
    if (!overlayDirty && want) return;
    const dpr = brushView.width / (sheetCss[0] + BV * 2);
    brushCtx.setTransform(1, 0, 0, 1, 0, 0);
    brushCtx.clearRect(0, 0, brushView.width, brushView.height);
    overlayShown = false;
    overlayDirty = false;
    if (!want) return;
    brushCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTool(brushCtx, { scale: sheetCss[0] / nx, ox: BV, oy: BV, ny });
    overlayShown = true;
  }

  // ------------------------------------------------------------ pigments UI
  const pansEl = $('pans');
  const panButtons = [];
  const single = (i, c) => { const a = new Array(8).fill(0); a[i] = c; return a; };
  const scaled = (arr, k) => arr.map((v) => v * k);

  function propsText(p) {
    const bits = [p.opacity.toLowerCase()];
    if (p.staining) bits.push('staining');
    if (p.granulating) bits.push('granulating');
    return bits.join(' · ');
  }

  function buildPans() {
    pansEl.textContent = '';
    panButtons.length = 0;
    LIB.PIGMENTS.forEach((p, i) => {
      if (p.hidden) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pan';
      b.setAttribute('aria-pressed', 'false');
      const grad = `linear-gradient(100deg, ${swatch(single(i, 3.2))} 0%, ${swatch(single(i, 1.3))} 40%, ${swatch(single(i, 0.5))} 72%, ${swatch(single(i, 0.16))} 100%)`;
      const sw = document.createElement('span');
      sw.className = 'pan-swatch';
      sw.style.setProperty('--sw', grad);
      const name = document.createElement('span');
      name.className = 'pan-name';
      name.textContent = p.short;
      const code = document.createElement('span');
      code.className = 'pan-code';
      code.textContent = p.code;
      const parts = document.createElement('span');
      parts.className = 'pan-parts';
      parts.hidden = true;
      b.append(sw, name, code, parts);
      b.title = `${p.name} (${p.code}) · ${propsText(p)} · key ${i + 1}, Shift to add to the mix`;
      b.addEventListener('click', (e) => selectPigment(i, e.shiftKey));
      pansEl.appendChild(b);
      panButtons.push({ b, parts });
    });
  }
  buildPans();

  function selectPigment(i, add) {
    if (add || state.mixMode) {
      if (state.mix.reduce((a, b) => a + b, 0) >= 12) return;
      state.mix[i] += 1;
    } else {
      state.mix = single(i, 1);
    }
    if (state.tool !== 'brush' && state.tool !== 'spatter') setTool('brush');
    // rinse and load from the pan
    brush.dip(mixConc(), state.water, add || state.mixMode ? 0.5 : 0.02);
    renderPigments();
  }

  function renderPigments() {
    const tot = state.mix.reduce((a, b) => a + b, 0);
    const used = state.mix.map((v, i) => [v, i]).filter(([v]) => v > 0);
    panButtons.forEach(({ b, parts }, i) => {
      b.setAttribute('aria-pressed', state.mix[i] > 0 ? 'true' : 'false');
      parts.hidden = !(used.length > 1 && state.mix[i] > 0);
      parts.textContent = state.mix[i];
    });
    const unit = state.mix.map((v) => v / (tot || 1));
    $('wellSwatch').style.setProperty('--sw',
      `linear-gradient(90deg, ${swatch(scaled(unit, 3))}, ${swatch(scaled(unit, 1.1))} 55%, ${swatch(scaled(unit, 0.3))})`);
    if (used.length === 1) {
      const p = LIB.PIGMENTS[used[0][1]];
      $('wellName').textContent = p.name;
      $('wellMeta').textContent = `${p.code} · ${propsText(p)}`;
    } else {
      $('wellName').textContent = used.map(([v, i]) => `${shortName(i)} ${v}`).join(' + ');
      const gran = used.some(([, i]) => LIB.PIGMENTS[i].granulating);
      const stain = used.some(([, i]) => LIB.PIGMENTS[i].staining);
      const bits = [used.map(([v]) => v).join(' : ') + ' mix'];
      if (gran) bits.push('granulating');
      if (stain) bits.push('staining');
      $('wellMeta').textContent = bits.join(' · ');
    }
  }

  $('mixToggle').addEventListener('click', () => {
    state.mixMode = !state.mixMode;
    $('mixToggle').setAttribute('aria-pressed', String(state.mixMode));
  });

  // ------------------------------------------------------------ tools + sliders
  const toolButtons = [...document.querySelectorAll('.tool')];
  function setTool(t) {
    if (t !== state.tool) {
      if (t === 'water') brush.dip(null, state.water, 0.04);          // rinse in the jar
      else if (t === 'brush' && state.tool === 'water') brush.dip(mixConc(), state.water, 0.12);
    }
    state.tool = t;
    overlayDirty = true;
    toolButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  }
  toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  const sizeEl = $('size'), waterEl = $('water'), loadEl = $('load'), pressEl = $('pressure');
  const brushButtons = [...document.querySelectorAll('#brushSeg button')];
  function waterWord(v) { return v < 0.15 ? 'Damp' : v < 0.35 ? 'Moist' : v < 0.65 ? 'Wet' : v < 0.85 ? 'Very wet' : 'Flooded'; }
  function loadWord(v) {
    if (state.medium === 'ink') return v < 0.12 ? 'Clear (清墨)' : v < 0.3 ? 'Pale (淡墨)' : v < 0.55 ? 'Medium (中墨)' : v < 0.8 ? 'Dark (濃墨)' : 'Burnt (焦墨)';
    return v < 0.12 ? 'Tint' : v < 0.3 ? 'Tea' : v < 0.55 ? 'Milk' : v < 0.8 ? 'Cream' : 'Butter';
  }
  function pressWord(v) { return v < 0.2 ? 'Tip only' : v < 0.4 ? 'Light' : v < 0.65 ? 'Medium' : v < 0.85 ? 'Firm' : 'Pressed flat'; }
  function setBrush(type, sizeIdx) {
    state.brushType = type;
    state.sizeIdx = sizeIdx;
    brush.configure(type, sizeIdx);
    renderBrush();
    overlayDirty = true;
  }
  function renderBrush() {
    sizeEl.value = state.sizeIdx;
    waterEl.value = Math.round(state.water * 100);
    loadEl.value = Math.round(state.load * 100);
    pressEl.value = Math.round(state.pressure * 100);
    brushButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.brush === state.brushType)));
    $('sizeOut').textContent = `${brush.label} · ${brush.widthMM.toFixed(1)} mm`;
    $('waterOut').textContent = `${waterWord(state.water)} · ${Math.round(state.water * 100)}%`;
    $('loadOut').textContent = `${loadWord(state.load)} · ${Math.round(state.load * 100)}%`;
    $('pressureOut').textContent = `${pressWord(state.pressure)} · ${Math.round(state.pressure * 100)}%`;
  }
  brushButtons.forEach((b) => b.addEventListener('click', () => setBrush(b.dataset.brush, state.sizeIdx)));
  sizeEl.addEventListener('input', () => setBrush(state.brushType, +sizeEl.value));
  waterEl.addEventListener('input', () => { state.water = waterEl.value / 100; renderBrush(); });
  loadEl.addEventListener('input', () => { state.load = loadEl.value / 100; renderBrush(); });
  pressEl.addEventListener('input', () => { state.pressure = pressEl.value / 100; renderBrush(); });
  $('reload').addEventListener('change', (e) => { state.reload = e.target.checked; });
  $('tipDip').addEventListener('change', (e) => { state.tipDip = e.target.checked; });
  $('showBrush').addEventListener('change', (e) => { state.showBrush = e.target.checked; overlayDirty = true; });

  let lastRes = -1, lastDot = '';
  const meanTmp = new Float32Array(8);
  function renderReservoir() {
    const r = brush.loaded ? brush.reservoir * 0.75 + brush.meanWet * 0.25 : 0;
    if (Math.abs(r - lastRes) >= 0.004) {
      lastRes = r;
      $('resBar').style.transform = `scaleX(${r.toFixed(3)})`;
      $('resOut').textContent = !brush.loaded ? 'Not loaded yet' : r > 0.9 ? 'Full' : r > 0.6 ? 'Good' : r > 0.3 ? 'Running low' : r > 0.08 ? 'Nearly dry' : 'Dry brush';
    }
    const c = brush.meanConc(meanTmp);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += c[i];
    const hair = brush.T.hair;
    let rgb = hair, words = 'clean';
    if (sum > 0.15) {
      const scaled = Array.from(c, (v) => v * 0.35);
      rgb = window.WC_PIGMENTS.reflectRGB(scaled);
      const parts = Array.from(c, (v, i) => [v / sum, i]).filter(([f]) => f > 0.08).sort((a, b) => b[0] - a[0]);
      words = parts.map(([f, i]) => `${Math.round(f * 100)}% ${shortName(i)}`).join(', ');
    }
    const key = rgb.join(',') + words;
    if (key !== lastDot) {
      lastDot = key;
      $('brushDot').style.setProperty('--dot', `rgb(${rgb.join(',')})`);
      $('brushPaint').textContent = words;
    }
  }


  // ------------------------------------------------------------ paper, tilt, drying
  const paperButtons = [...document.querySelectorAll('#paperSeg button')];
  function renderPaper() {
    PAPERS[state.medium].forEach(([id, label], i) => {
      const b = paperButtons[i];
      b.dataset.paper = id;
      b.textContent = label;
      b.setAttribute('aria-checked', String(id === state.paper));
    });
    const size = portrait ? '9 × 12 in' : '12 × 9 in';
    const weight = state.medium === 'ink' ? '28 gsm' : state.medium === 'pencil' ? '160 gsm' : state.medium === 'gouache' && state.paper !== 'cold' ? (state.paper === 'canvas' ? '12 oz' : '1.5 mm') : '300 gsm';
    const label = PAPER_LABEL[state.paper];
    $('sheetLabel').textContent = `${label} · ${weight} · ${size}`;
  }
  function setPaper(id, fresh) {
    if (id === state.paper) return;
    if (painter.running) painter.stop();
    if (!fresh) engine.pushUndo();
    state.paper = id;
    engine.generatePaper(state.paper);
    engine.clear();
    renderPaper();
    updateUndo();
  }
  paperButtons.forEach((b) => b.addEventListener('click', () => setPaper(b.dataset.paper)));

  // ------------------------------------------------------------ medium
  // Watercolor on sized rag paper, or sumi ink on xuan laid over a felt pad
  // and held by paperweights. Switching starts a fresh sheet (undoable).
  const mediumButtons = [...document.querySelectorAll('#mediumSeg button')];
  function renderMedium() {
    const ink = state.medium === 'ink', pencil = state.medium === 'pencil', gouache = state.medium === 'gouache';
    mediumButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.medium === state.medium)));
    $('mediumSub').textContent = ink ? 'sumi ink' : pencil ? 'pencil' : gouache ? 'gouache' : 'watercolor';
    $('studio').classList.toggle('ink', ink);
    $('studio').classList.toggle('pencil', pencil);
    $('studio').classList.toggle('gouache', gouache);
    $('tipDipRow').hidden = !ink;
    $('tipDip').checked = state.tipDip;
    for (const t of ['brush', 'water', 'lift', 'spatter']) document.querySelector(`[data-tool="${t}"]`).hidden = pencil || (gouache && t === 'lift');
    document.querySelector('[data-tool="salt"]').hidden = ink || pencil || gouache;
    document.querySelector('[data-tool="seal"]').hidden = !ink;
    for (const t of ['pencil', 'stump', 'eraser']) document.querySelector(`[data-tool="${t}"]`).hidden = !pencil;
    renderPencil();
  }
  // ------------------------------------------------------------ pencil panel
  const gradeButtons = [...document.querySelectorAll('#gradeSeg button')];
  const eraserButtons = [...document.querySelectorAll('#eraserSeg button')];
  function renderPencil() {
    gradeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.grade === state.grade)));
    $('sharp').value = Math.round(state.sharp * 100);
    $('sharpOut').textContent = state.sharp < 0.25 ? `Needle point · ${(2 * state.sharp).toFixed(1)} mm` : state.sharp < 0.5 ? `Sharp · ${(2 * state.sharp).toFixed(1)} mm` : `Blunt · ${(2 * state.sharp).toFixed(1)} mm`;
    $('side').value = Math.round(state.side * 100);
    $('sideOut').textContent = state.side < 0.05 ? 'The point' : state.side < 0.6 ? `Tilted · ${Math.round(state.side * 100)}%` : `On its side · ${Math.round(state.side * 100)}%`;
    eraserButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.eraser === state.eraser)));
    $('eraserSize').value = Math.round(state.eraserSize * 10);
    $('eraserSizeOut').textContent = `${state.eraser === 'kneaded' ? 'Kneaded' : 'Vinyl'} · ${state.eraserSize.toFixed(1)} mm`;
    $('pPressure').value = Math.round(state.pressure * 100);
    $('pPressureOut').textContent = `${state.pressure < 0.3 ? 'Light' : state.pressure < 0.65 ? 'Medium' : 'Firm'} · ${Math.round(state.pressure * 100)}%`;
  }
  gradeButtons.forEach((b) => b.addEventListener('click', () => { state.grade = b.dataset.grade; renderPencil(); }));
  eraserButtons.forEach((b) => b.addEventListener('click', () => { state.eraser = b.dataset.eraser; renderPencil(); }));
  $('eraserSize').addEventListener('input', (e) => { state.eraserSize = +e.target.value / 10; renderPencil(); });
  $('sharp').addEventListener('input', (e) => { state.sharp = +e.target.value / 100; renderPencil(); });
  $('side').addEventListener('input', (e) => { state.side = +e.target.value / 100; renderPencil(); });
  $('pPressure').addEventListener('input', (e) => { state.pressure = +e.target.value / 100; renderPencil(); if (typeof renderBrush === 'function') renderBrush(); });
  function setMedium(m, fresh) {
    if (m === state.medium) return;
    if (painter.running) painter.stop();
    if (!fresh) engine.pushUndo();
    state.medium = m;
    LIB.use(m);
    engine.setPalette(m);
    state.paper = m === 'ink' ? 'xuan' : m === 'pencil' ? 'drawing' : m === 'gouache' ? 'board' : 'cold';
    engine.generatePaper(state.paper);
    engine.clear();
    brush.capScale = 1;
    if (m === 'ink') { state.mix = single(0, 1); state.load = 0.38; state.water = 0.55; setBrush('fude', 5); }
    else if (m === 'pencil') { state.mix = single(0, 1); }
    else if (m === 'gouache') { state.mix = single(2, 1); state.load = 0.65; state.water = 0.1; brush.capScale = Math.pow(cellsPerMM / (1024 / 304.8), 2); setBrush('filbert', 4); }
    else { state.mix = single(4, 1); state.load = 0.5; state.water = 0.6; setBrush('round', 4); }
    if (m === 'pencil') setTool('pencil');
    else if (state.tool === 'salt' || state.tool === 'seal' || ['pencil', 'stump', 'eraser'].includes(state.tool)) setTool('brush');
    buildPans();
    renderPigments();
    renderBrush();
    renderPaper();
    renderMedium();
    updateUndo();
    lastDot = '';
  }
  mediumButtons.forEach((b) => b.addEventListener('click', () => setMedium(b.dataset.medium)));

  const tiltEl = $('tilt'), knob = $('tiltKnob');
  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  function setTilt(tx, ty) {
    let m = Math.hypot(tx, ty);
    if (m > 1) { tx /= m; ty /= m; m = 1; }
    if (m < 0.1) { tx = 0; ty = 0; m = 0; }
    state.tilt = [tx, ty];
    knob.style.transform = `translate(${(tx * 27).toFixed(1)}px, ${(ty * 27).toFixed(1)}px)`;
    const slope = 0.0018;
    engine.tilt = [-tx * slope, ty * slope];
    const deg = Math.round(m * 30);
    let text = 'Board flat';
    if (deg > 0) {
      const oct = Math.round(Math.atan2(ty, tx) / (Math.PI / 4));
      text = `Tilted ${deg}° ${ARROWS[(oct + 8) % 8]}`;
    }
    $('tiltText').textContent = text;
    tiltEl.setAttribute('aria-valuetext', text);
    engine.wake();
  }
  function tiltFromPointer(e) {
    const r = tiltEl.getBoundingClientRect();
    setTilt((e.clientX - (r.left + r.width / 2)) / 27, (e.clientY - (r.top + r.height / 2)) / 27);
  }
  let tiltDrag = false;
  tiltEl.addEventListener('pointerdown', (e) => { tiltDrag = true; tiltEl.setPointerCapture(e.pointerId); tiltFromPointer(e); });
  tiltEl.addEventListener('pointermove', (e) => { if (tiltDrag) tiltFromPointer(e); });
  tiltEl.addEventListener('pointerup', () => { tiltDrag = false; });
  tiltEl.addEventListener('pointercancel', () => { tiltDrag = false; });
  tiltEl.addEventListener('dblclick', () => setTilt(0, 0));
  tiltEl.addEventListener('keydown', (e) => {
    const [tx, ty] = state.tilt;
    const k = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[e.key];
    if (k) { e.preventDefault(); setTilt(tx + k[0], ty + k[1]); }
    else if (e.key === '0' || e.key === 'Escape') { e.preventDefault(); setTilt(0, 0); }
  });

  function updateEvap() {
    const humid = (100 - state.humidity) / 45;
    engine.evapMul = humid * (state.dryer ? 7 : 1);
  }
  function setDryer(on) {
    if (state.dryer === on) return;
    state.dryer = on;
    $('dryer').setAttribute('aria-pressed', String(on));
    updateEvap();
    if (on) engine.wake();
  }
  const dryerBtn = $('dryer');
  dryerBtn.addEventListener('pointerdown', (e) => { dryerBtn.setPointerCapture(e.pointerId); setDryer(true); });
  dryerBtn.addEventListener('pointerup', () => setDryer(false));
  dryerBtn.addEventListener('pointercancel', () => setDryer(false));
  dryerBtn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setDryer(true); } });
  dryerBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setDryer(false); });

  const humEl = $('humidity');
  function setHumidity(v) {
    state.humidity = clamp(Math.round(v), +humEl.min || 0, +humEl.max || 100);
    humEl.value = state.humidity;
    $('humOut').textContent = `${state.humidity}% RH`;
    updateEvap();
  }
  humEl.addEventListener('input', () => setHumidity(+humEl.value));

  // ------------------------------------------------------------ actions
  function updateUndo() { $('undo').disabled = !engine.canUndo; }
  function doUndo() {
    if (painter.running) painter.stop();
    active = null;
    const paper = engine.undo();
    if (paper && paper !== state.paper) {
      state.paper = paper;
      const m = paper.startsWith('xuan') ? 'ink' : 'watercolor';
      if (m !== state.medium) {
        state.medium = m;
        state.mix = single(m === 'ink' ? 0 : 4, 1);
        setBrush(m === 'ink' ? 'fude' : 'round', m === 'ink' ? 5 : 4);
        if (state.tool === 'salt' || state.tool === 'seal') setTool('brush');
        buildPans();
        renderPigments();
        renderBrush();
        renderMedium();
      }
      renderPaper();
    }
    updateUndo();
  }
  $('undo').addEventListener('click', doUndo);
  $('newSheet').addEventListener('click', () => {
    if (painter.running) painter.stop();
    engine.pushUndo();
    engine.clear();
    updateUndo();
  });
  $('demo').addEventListener('click', () => {
    if (painter.running) { painter.stop(); return; }
    engine.pushUndo();
    engine.clear();
    updateUndo();
    painter.start(state.medium === 'ink' ? bambooScript() : demoScript());
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const m = /^Digit([1-8])$/.exec(e.code);
    if (m) { selectPigment(+m[1] - 1, e.shiftKey); return; }
    const k = e.key.toLowerCase();
    const toolKey = state.medium === 'pencil' ? { b: 'pencil', w: 'stump', l: 'eraser' }[k] : { b: 'brush', w: 'water', l: 'lift', f: 'spatter', s: state.medium === 'ink' ? 'seal' : 'salt' }[k];
    if (toolKey) { setTool(toolKey); return; }
    if (k === '[' || k === ']') {
      setBrush(state.brushType, clamp(state.sizeIdx + (k === ']' ? 1 : -1), 0, 9));
      return;
    }
    if (k === 'r') {
      brush.flatAngle += (e.shiftKey ? -1 : 1) * (Math.PI / 12);
      overlayDirty = true;
      return;
    }
    if (k === 'd' && !e.repeat && t !== dryerBtn) setDryer(true);
  });
  window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'd') setDryer(false); });
  window.addEventListener('blur', () => setDryer(false));

  // ------------------------------------------------------------ status
  function pct(x) { return x <= 0 ? '0%' : x < 0.01 ? '<1%' : Math.round(x * 100) + '%'; }
  let lastStatus = '';
  function renderStatus() {
    const s = engine.status;
    let st = 'dry', text = 'Dry';
    if (engine.awake) {
      if (s.wet > 0.0002) { st = 'wet'; text = `Wet ${pct(s.wet)} · damp ${pct(s.damp)}`; }
      else { st = 'damp'; text = s.damp > 0.0002 ? `Drying · damp ${pct(s.damp)}` : 'Drying'; }
    }
    const key = st + text;
    if (key === lastStatus) return;
    lastStatus = key;
    $('status').dataset.state = st;
    $('statusText').textContent = text;
  }

  // ------------------------------------------------------------ demo painter
  // Plays a scripted landscape through the same brush model a person uses.
  let painterStroke = null;
  class Painter {
    constructor() { this.queue = []; this.cur = null; this.running = false; }
    start(items) {
      this.queue = items;
      this.cur = null;
      this.running = true;
      $('demo').lastChild.textContent = ' Stop';
    }
    stop() {
      this.running = false;
      this.queue = [];
      this.cur = null;
      if (painterStroke) { painterStroke.end(); painterStroke = null; }
      hover = null;
      overlayDirty = true;
      if (this.keepBoard) return;   // scripted painting manages tilt and dryer itself
      setDryer(false);
      setTilt(0, 0);
      $('demo').lastChild.textContent = ' Demo';
    }
    update(dt) {
      let budget = dt;
      while (this.running) {
        if (!this.cur) {
          const it = this.queue.shift();
          if (!it) { this.stop(); return; }
          this.cur = this.begin(it);
        }
        budget = this.cur(budget);
        if (budget < 0) return;
        this.cur = null;
      }
    }
    air(x1, y1, dmm) {
      const x0 = toolPose.x, y0 = toolPose.y, z0 = toolPose.z;
      const T = 60 + 70 * Math.log2(1 + dmm / 2), top = clamp(3 + 1.1 * Math.sqrt(dmm), 3, 16);
      let el = 0;
      toolPose.air = true;
      return (b) => {
        el += b;
        const u = Math.min(1, el / T), m = u * u * u * (10 - 15 * u + 6 * u * u);
        toolPose.x = x0 + (x1 - x0) * m; toolPose.y = y0 + (y1 - y0) * m;
        toolPose.z = (1 - u) * z0 * (1 - m) + top * Math.sin(Math.PI * u) * (1 - 0.3 * u);
        overlayDirty = true;
        if (u >= 1) { toolPose.air = false; toolPose.z = 0; return el - T; }
        return -1;
      };
    }
    begin(it) {
      if (it.type === 'set') {
        applySettings(it);
        return (b) => b;
      }
      if (it.type === 'wait') {
        let left = it.ms;
        return (b) => { left -= b; return left <= 0 ? -left : -1; };
      }
      if (it.type === 'press') {
        // straight down onto one spot, hold, and lift: pressure ramps in over
        // `down` ms, holds for `hold`, eases off over `up`; `tilt` leans the
        // handle (0 = upright)
        const x = it.at[0] * nx, y = (1 - it.at[1]) * ny;   // same convention as stroke points
        const down = it.down || 120, hold = it.hold || 150, up = it.up || 120, peak = it.press == null ? 0.8 : it.press;
        const tilt = it.tilt || [0, 0.001];
        const stroke = makeStroke(state.tool, false);
        painterStroke = stroke;
        const t0 = performance.now();
        let el = 0;
        const pAt = (e) => (e < down ? peak * smooth(0, down, e) : e < down + hold ? peak : peak * (1 - smooth(down + hold, down + hold + up, e)));
        stroke.move(x, y, 0, t0, tilt);
        return (b) => {
          const start = el;
          const goal = Math.min(down + hold + up, el + b);
          while (el < goal) {
            el = Math.min(goal, el + 6);
            // a hair's breadth of movement keeps the stroke's sample filter happy
            stroke.move(x + (el % 12 < 6 ? 0.01 : -0.01), y, pAt(el), t0 + el, tilt);
          }
          if (el >= down + hold + up) {
            stroke.end();
            painterStroke = null;
            hover = { x, y };
            return b - (goal - start);
          }
          return -1;
        };
      }
      if (it._air) it._air = false;
      else if (state.medium === 'pencil' && it.pts && it.pts.length) {
        // the hand carries the pencil through the air to where the stroke
        // starts: a quick reach (longer for farther), lifting and setting down
        if (toolPose.x == null) restPose();
        const x1 = it.pts[0][0] * nx, y1 = (1 - it.pts[0][1]) * ny;
        const dmm = Math.hypot(x1 - toolPose.x, y1 - toolPose.y) / cellsPerMM;
        if (dmm > 0.3) {
          it._air = true;
          this.queue.unshift(it);
          return this.air(x1, y1, dmm);
        }
      }
      const pts = it.pts.map(([u, v, p]) => ({ x: u * nx, y: (1 - v) * ny, p: p == null ? it.pressure || 0.8 : p }));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      const total = cum[cum.length - 1];
      const speed = (it.speed * cellsPerMM) / 1000;
      const stroke = makeStroke(state.tool, false);
      if (it.lift) stroke.liftMs = it.lift;
      if (it.settle) stroke.settleMs = it.settle;
      painterStroke = stroke;
      let t = performance.now();
      let dist = 0, seg = 1;
      stroke.move(pts[0].x, pts[0].y, pts[0].p, t);
      if (Array.isArray(it.ts) && it.ts.length === pts.length) {
        // a timed gesture: each point is reached at its own time (ms from the
        // start), so the hand speeds up and slows down as it was moved
        const ts = it.ts, t0 = t;
        let el = 0, k = 1;
        return (b) => {
          const goal = el + b;
          while (k < pts.length && ts[k] <= goal) { stroke.move(pts[k].x, pts[k].y, pts[k].p, t0 + ts[k]); k++; }
          el = goal;
          if (k >= pts.length) {
            stroke.end();
            painterStroke = null;
            hover = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
            return Math.max(0, goal - ts[ts.length - 1]);
          }
          return -1;
        };
      }
      const at = (d) => {
        while (seg < pts.length - 1 && cum[seg] < d) seg++;
        const a = pts[seg - 1], b = pts[seg];
        const f = cum[seg] > cum[seg - 1] ? (d - cum[seg - 1]) / (cum[seg] - cum[seg - 1]) : 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, p: a.p + (b.p - a.p) * f };
      };
      return (b) => {
        const goal = Math.min(total, dist + b * speed);
        while (dist < goal) {
          const stepD = Math.min(1.5, goal - dist);
          dist += stepD;
          t += stepD / speed;
          const q = at(dist);
          stroke.move(q.x, q.y, q.p, t);
        }
        if (dist >= total) {
          stroke.end();
          painterStroke = null;
          hover = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
          return Math.max(0, b - total / speed);
        }
        return -1;
      };
    }
  }
  const painter = new Painter();

  function applySettings(o) {
    if (o.brush || o.size != null) setBrush(o.brush || state.brushType, o.size != null ? o.size : state.sizeIdx);
    if (o.flatAngle != null) brush.flatAngle = o.flatAngle;
    if (o.tool) setTool(o.tool);
    if (o.mix) { state.mix = new Array(8).fill(0); for (const k in o.mix) state.mix[k] = o.mix[k]; renderPigments(); }
    if (o.water != null) state.water = o.water;
    if (o.load != null) state.load = o.load;
    if (o.size != null || o.water != null || o.load != null) renderBrush();
    if (o.tip != null) { state.tipDip = o.tip; $('tipDip').checked = o.tip; }
    if (o.marble != null) state.marble = o.marble;
    if (o.tilt) setTilt(o.tilt[0], o.tilt[1]);
    if (o.dryer != null) setDryer(o.dryer);
    if (o.grade) { if (!GRADES[o.grade]) throw new Error('grade must be one of ' + Object.keys(GRADES).join(', ')); state.grade = o.grade; }
    if (o.sharp != null) state.sharp = o.sharp;
    if (o.side != null) state.side = o.side;
    if (o.eraser) { if (!ERASERS[o.eraser]) throw new Error('eraser must be one of ' + Object.keys(ERASERS).join(', ')); state.eraser = o.eraser; }
    if (o.eraserSize != null) state.eraserSize = clamp(+o.eraserSize, 0.6, 30);
    if (o.grade || o.sharp != null || o.side != null || o.eraser || o.eraserSize != null) renderPencil();
  }

  // A misty mountain range at dusk: a graded wet-in-wet sky with lifted
  // clouds, three ridges that step forward in value (each softened into
  // clean water at its base), then a treeline, pines and a little spatter.
  function demoScript() {
    const S = [];
    const set = (o) => S.push(Object.assign({ type: 'set' }, o));
    const wait = (ms) => S.push({ type: 'wait', ms });
    const stroke = (pts, speed, pressure) => S.push({ type: 'stroke', pts, speed: speed || 600, pressure: pressure || 0.85 });
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const row = (x0, x1, v, wob, ph) => {
      const pts = [];
      for (let k = 0; k <= 12; k++) {
        const u = x0 + ((x1 - x0) * k) / 12;
        pts.push([u, v + Math.sin(u * 7 + (ph || 0)) * (wob || 0)]);
      }
      return pts;
    };
    const lerpLine = (line, u) => {
      for (let i = 1; i < line.length; i++) {
        if (line[i][0] >= u) {
          const a = line[i - 1], b = line[i];
          return a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]);
        }
      }
      return line[line.length - 1][1];
    };
    // Fill under a silhouette the way a hand does: passes that alternate
    // down and up but never land at an even spacing, lean a little, and
    // vary in pressure and pace, with a fresh dip every few passes.
    const fillBelow = (line, bottom, step, perStroke, speed) => {
      let u = -0.01, down = true, pts = [], count = 0, per = perStroke, pr = 0.6;
      const flush = () => { if (pts.length) stroke(pts, speed * (0.8 + 0.4 * rand()), pr); pts = []; count = 0; per = perStroke - 1 + Math.floor(rand() * 3); pr = 0.5 + 0.25 * rand(); };
      while (u <= 1.03) {
        const top = lerpLine(line, clamp(u, 0, 1)) + 0.008 + rand() * 0.008;
        const lean = (rand() - 0.5) * 0.012;
        const end = bottom - rand() * 0.02;
        const p = pr * (0.85 + 0.3 * rand());
        if (down) pts.push([u, top, p], [u + lean, end, p]);
        else pts.push([u + lean, end, p], [u, top, p]);
        down = !down;
        u += step * (0.55 + 0.5 * rand());
        if (++count >= per) flush();
      }
      flush();
    };
    const ridge = (n, base, amp, rough) => {
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const u = -0.02 + (1.04 * k) / n;
        const big = Math.sin(u * 5.1 + seed * 0.001) * 0.5 + Math.sin(u * 11.3 + 1.7) * 0.3;
        pts.push([u, base - amp * (0.5 + 0.5 * big) - (rand() - 0.5) * rough]);
      }
      return pts;
    };
    // a conifer as stacked, drooping tiers of short strokes on a thin trunk
    const pine = (x, top, bottom, width) => {
      stroke([[x, top - 0.01, 0.1], [x, bottom + 0.02, 0.5]], 700);
      for (let v = top; v < bottom; v += 0.009 + 0.009 * rand()) {
        const t = (v - top) / (bottom - top);
        const w = width * (0.15 + 0.85 * Math.pow(t, 0.8)) * (0.75 + 0.5 * rand());
        const droop = 0.01 + 0.012 * t;
        const p = 0.28 + 0.4 * t;
        stroke([[x - w, v + droop, 0.08], [x - w * 0.4, v + droop * 0.3, p], [x, v, p], [x + w * 0.4, v + droop * 0.3, p], [x + w, v + droop, 0.08]], 650);
      }
    };

    // 1. wet the sky with a mop, overlapping passes
    set({ tool: 'water', brush: 'mop', size: 6, water: 0.85, tilt: [0, 0] });
    for (let v = 0.035; v <= 0.56; v += 0.04 + 0.03 * rand()) stroke(row(-0.03, 1.03, v, 0.004, v * 20), 800 + 200 * rand(), 0.6 + 0.15 * rand());
    // 2. graded sky dropped into the wet paper, strongest at the top
    set({ tool: 'brush', brush: 'mop', size: 5, mix: { 4: 3, 3: 1 }, water: 0.75, load: 0.5 });
    stroke(row(-0.03, 1.03, 0.035, 0.006, 1), 850, 0.65);
    stroke(row(1.03, -0.03, 0.09, 0.008, 2), 850, 0.65);
    set({ mix: { 4: 2, 3: 1 }, load: 0.36 });
    stroke(row(-0.03, 1.03, 0.15, 0.01, 3), 850, 0.6);
    stroke(row(1.03, -0.03, 0.21, 0.01, 4), 850, 0.6);
    set({ mix: { 3: 2, 0: 1 }, load: 0.24 });
    stroke(row(-0.03, 1.03, 0.29, 0.01, 5), 850, 0.6);
    set({ mix: { 0: 2, 3: 1 }, load: 0.22 });
    stroke(row(1.03, -0.03, 0.36, 0.008, 6), 850, 0.6);
    stroke(row(-0.03, 1.03, 0.42, 0.008, 7), 850, 0.6);
    // 3. lift soft clouds out of the wet sky with a tissue
    set({ tool: 'lift', brush: 'round', size: 9 });
    stroke([[0.1, 0.16], [0.22, 0.14], [0.3, 0.17], [0.2, 0.19], [0.12, 0.18]], 420);
    stroke([[0.55, 0.11], [0.68, 0.09], [0.78, 0.12], [0.66, 0.14], [0.58, 0.13]], 420);
    stroke([[0.36, 0.25], [0.44, 0.24], [0.5, 0.26]], 380);
    // 4. tilt the board so the sky settles downward, then dry it
    set({ tilt: [0, 0.5] });
    wait(2200);
    set({ tilt: [0, 0], dryer: true });
    wait(3800);
    set({ dryer: false });
    // 5. far range: pale and cool, its base lost into clean water
    const far = ridge(26, 0.46, 0.1, 0.018);
    set({ tool: 'brush', brush: 'round', size: 5, mix: { 4: 2, 3: 2, 7: 1 }, water: 0.65, load: 0.26 });
    stroke(far, 420, 0.5);
    set({ brush: 'mop', size: 3 });
    fillBelow(far, 0.58, 0.034, 6, 1100);
    set({ tool: 'water', brush: 'mop', size: 5, water: 0.85 });
    stroke(row(-0.03, 1.03, 0.585, 0.006, 2), 850, 0.6);
    set({ dryer: true });
    wait(3200);
    set({ dryer: false });
    // 6. middle range: deeper, warmer
    seed = 91;
    const mid = ridge(22, 0.6, 0.11, 0.02);
    set({ tool: 'brush', brush: 'round', size: 5, mix: { 4: 3, 3: 1, 7: 2 }, water: 0.65, load: 0.48 });
    stroke(mid, 420, 0.5);
    set({ brush: 'mop', size: 3 });
    fillBelow(mid, 0.72, 0.034, 6, 1100);
    set({ brush: 'round', size: 7, mix: { 7: 2, 4: 1 }, load: 0.55, water: 0.68 });
    stroke(row(0.05, 0.4, 0.66, 0.01, 1), 650, 0.6);
    set({ tool: 'water', brush: 'mop', size: 5, water: 0.85 });
    stroke(row(1.03, -0.03, 0.725, 0.006, 4), 850, 0.6);
    set({ dryer: true });
    wait(3200);
    set({ dryer: false });
    // 7. treeline, dark and granulating, with salt pressed into it
    seed = 23;
    const trees = ridge(40, 0.8, 0.05, 0.035);
    set({ tool: 'brush', brush: 'round', size: 6, mix: { 6: 2, 4: 1, 7: 1 }, water: 0.66, load: 0.7 });
    stroke(trees, 460, 0.55);
    set({ brush: 'mop', size: 4 });
    fillBelow(trees, 1.03, 0.034, 6, 1100);
    set({ brush: 'round', size: 7, mix: { 7: 2, 1: 1 }, load: 0.6, water: 0.66 });
    stroke(row(0.55, 1.03, 0.92, 0.012, 2), 650, 0.6);
    set({ tool: 'salt', size: 4 });
    stroke([[0.62, 0.9], [0.7, 0.88], [0.78, 0.91]], 240);
    wait(1500);
    set({ dryer: true });
    wait(3000);
    set({ dryer: false });
    // 8. pines against the damp treeline, tier by tier with the tip of a round
    set({ tool: 'brush', brush: 'round', size: 0, mix: { 6: 1, 4: 2, 7: 2 }, water: 0.6, load: 0.9 });
    for (const [x, top, w] of [[0.07, 0.58, 0.034], [0.14, 0.66, 0.026], [0.22, 0.55, 0.04], [0.31, 0.7, 0.022], [0.84, 0.63, 0.03], [0.92, 0.54, 0.042]]) {
      pine(x, top, 0.93, w);
    }
    // 9. grass with a rigger, flicked upward
    set({ brush: 'rigger', size: 3, mix: { 7: 2, 6: 1 }, water: 0.6, load: 0.8 });
    for (let i = 0; i < 14; i++) {
      const u = 0.42 + i * 0.022 + (rand() - 0.5) * 0.01, lean = (rand() - 0.5) * 0.05;
      stroke([[u, 0.985, 0.7], [u + lean * 0.4, 0.94, 0.45], [u + lean, 0.88 - rand() * 0.04, 0.05]], 700);
    }
    // 10. spatter across the foreground
    set({ tool: 'spatter', brush: 'round', size: 5, mix: { 7: 2, 4: 1 }, load: 0.72, water: 0.7 });
    stroke([[0.4, 0.94], [0.55, 0.9]], 420);
    set({ tool: 'brush', brush: 'round', size: 4, mix: { 4: 1 }, water: 0.6, load: 0.5 });
    return S;
  }

  // The character 竹 (bamboo) as brush strokes in calligraphic order, in a
  // unit box (x right, y down, pressure third): two short left-falling
  // strokes, two horizontals, a straight vertical and a hooked one.
  const ZHU = [
    [[0.3, 0.0, 0.42], [0.22, 0.13, 0.44], [0.05, 0.33, 0.18]],
    [[0.16, 0.22, 0.42], [0.32, 0.205, 0.36], [0.47, 0.19, 0.46]],
    [[0.31, 0.2, 0.5], [0.315, 0.62, 0.44], [0.31, 1.0, 0.22]],
    [[0.78, 0.0, 0.42], [0.7, 0.13, 0.44], [0.53, 0.33, 0.18]],
    [[0.64, 0.22, 0.42], [0.82, 0.205, 0.36], [1.0, 0.185, 0.5]],
    [[0.8, 0.19, 0.5], [0.805, 0.62, 0.46], [0.8, 0.93, 0.5], [0.78, 0.97, 0.54], [0.66, 0.9, 0.04]],
  ];

  // Ink bamboo (墨竹) on raw xuan, in the traditional order: stalks painted
  // bottom-up one segment at a time with a gap left at each node, node marks
  // in darker ink, branches, pale leaves behind, dark leaves in front loaded
  // with a tip of burnt ink, then the signature and seal. Every run draws a
  // new arrangement from its seed.
  function bambooScript(seedIn) {
    const S = [];
    const set = (o) => S.push(Object.assign({ type: 'set' }, o));
    const wait = (ms) => S.push({ type: 'wait', ms });
    let seed = seedIn || 1 + Math.floor(Math.random() * 2147483000);
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const range = (a, b) => a + (b - a) * rand();
    const mirror = rand() < 0.5;
    const X = (u) => (mirror ? 1 - u : u);
    const stroke = (pts, speed) => S.push({ type: 'stroke', pts: pts.map(([u, v, p]) => [X(u), v, p]), speed });
    const strokeRaw = (pts, speed) => S.push({ type: 'stroke', pts, speed });   // writing is never mirrored
    const AX = 1 / sheetMM[0], AY = 1 / sheetMM[1];   // millimetres to sheet fractions
    const side = -1;                                 // leaves mostly fall toward -u (the open side)

    const stalk = (x0, x1, bottom, top, segs, press) => {
      const w = [];
      for (let i = 0; i < segs; i++) w.push(0.5 + Math.sin((Math.PI * (i + 0.7)) / segs) * 0.6 + rand() * 0.2);
      const sum = w.reduce((a, b) => a + b, 0), H = bottom - top, gap = range(2, 2.8) * AY;
      const nodes = [];
      let v = bottom;
      const xAt = (vv) => x0 + ((x1 - x0) * (bottom - vv)) / H;
      for (let i = 0; i < segs; i++) {
        const len = ((H - gap * segs) * w[i]) / sum;
        const vA = v, vB = v - len, bow = (rand() - 0.5) * 0.004;
        stroke([
          [xAt(vA), vA, press * range(1.05, 1.18)], [xAt(vA - len * 0.12), vA - len * 0.12, press * 0.94],
          [xAt((vA + vB) / 2) + bow, (vA + vB) / 2, press * range(0.84, 0.92)],
          [xAt(vB + len * 0.1), vB + len * 0.1, press * 0.94], [xAt(vB), vB, press * range(1.05, 1.18)],
        ], range(190, 260));
        nodes.push([xAt(vB), vB - gap / 2]);
        v = vB - gap;
      }
      return nodes;
    };
    const node = ([x, v], wMM) => {
      const h = wMM * range(0.5, 0.6) * AX;
      stroke([[x - h, v + 0.9 * AY, 0.12], [x - h * 0.35, v - 0.7 * AY, 0.42], [x + h * 0.35, v - 0.7 * AY, 0.42], [x + h, v + 0.9 * AY, 0.1]], 240);
    };
    // a branch with one or two twigs; returns the tips where leaves hang
    const branch = ([x, v], dir, lenMM) => {
      const pts = [[x, v, 0.34]];
      let px = x, pv = v;
      for (let k = 1; k <= 3; k++) {
        px += dir * (lenMM / 3) * AX * range(0.8, 1.2);
        pv -= (lenMM / 3) * AY * range(0.4, 0.85);
        pts.push([px, pv, 0.34 - k * 0.07]);
      }
      stroke(pts, range(320, 420));
      const tips = [[px, pv]];
      const twigs = rand() < 0.55 ? 2 : 1;
      for (let t = 0; t < twigs; t++) {
        const [mx, mv] = pts[1 + t];
        const tl = lenMM * range(0.25, 0.45), up = range(0.35, 0.7);
        const tx = mx + dir * tl * AX * (t ? -0.4 : 1), tv = mv - tl * up * AY;
        stroke([[mx, mv, 0.24], [(mx + tx) / 2, (mv + tv) / 2 - AY, 0.18], [tx, tv, 0.06]], 360);
        tips.push([tx, tv]);
      }
      return tips;
    };
    // one leaf: touch down, swell to the belly, lift away to a point
    const leaf = ([x, v], angle, lenMM, press) => {
      const ca = Math.cos(angle), sa = Math.sin(angle), curv = (rand() - 0.5) * 0.3;
      const belly = range(0.26, 0.36);
      const prof = [[0, 0.03], [0.08, 0.25], [belly, 1], [belly + 0.25, 0.78], [0.8, 0.34], [0.93, 0.1], [1, 0.0]];
      stroke(prof.map(([t, pp]) => {
        const along = t * lenMM, off = Math.sin(Math.PI * t) * curv * lenMM;
        return [x + (ca * along - sa * off) * AX, v + (sa * along + ca * off) * AY, pp * press];
      }), range(540, 780));
    };
    // leaf groups in the classic formations; angle is where the group hangs
    const FORMS = { fen: [-0.3, 0.3], ren: [-0.12, 0.5], ge: [-0.45, 0, 0.45], jie: [-0.62, -0.2, 0.22, 0.62], chongge: [-0.5, -0.05, 0.4, -0.25, 0.2] };
    const group = (at, angle, form, lenMM, press) => {
      FORMS[form].forEach((off, i) => {
        const base = form === 'chongge' && i > 2 ? [at[0] + range(-2, 2) * AX, at[1] + range(2, 5) * AY] : at;
        const middle = Math.abs(off) < 0.1 ? 1.12 : 1;
        leaf(base, angle + off + range(-0.1, 0.1), lenMM * middle * range(0.78, 1.18), press * range(0.86, 1.08));
      });
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    // an angle falling toward the open side, or up for young shoots
    const hang = (toward) => (toward < 0 ? range(1.95, 2.7) : range(0.45, 1.2));

    // ---- stalks: a far one in pale ink, the near one in medium, maybe a ghost
    const nearX = range(0.58, 0.68), lean = range(-0.06, 0.02);
    const farX = nearX + range(0.12, 0.2) * (rand() < 0.75 ? 1 : -1);
    set({ tool: 'brush', brush: 'fude', size: 7, mix: { 0: 1 }, water: 0.42, load: range(0.16, 0.22), tip: false });
    const far = stalk(farX, farX + range(-0.02, 0.04), 1.03, range(0.14, 0.3), 4 + Math.floor(rand() * 2), range(0.45, 0.55));
    if (rand() < 0.4) {
      set({ load: 0.09, size: 6 });
      const gx = nearX + range(-0.26, -0.16);
      stalk(gx, gx + range(-0.03, 0.02), 1.03, range(0.35, 0.5), 3, 0.42);
    }
    set({ size: 8, load: range(0.32, 0.4), water: 0.44 });
    const near = stalk(nearX, nearX + lean, 1.03, -0.04, 5 + Math.floor(rand() * 3), range(0.64, 0.74));
    wait(500);
    // ---- nodes and branches in darker ink with a small brush
    set({ size: 2, load: 0.42, water: 0.45 });
    far.slice(0, far.length - 1).forEach((n) => node(n, 9));
    set({ load: range(0.7, 0.85) });
    near.slice(0, near.length - 1).forEach((n) => node(n, 13));
    set({ load: 0.62, water: 0.45 });
    const tips = [];
    const upper = near.slice(Math.floor(near.length / 3), near.length - 1);
    upper.forEach((n, i) => {
      if (i > 0 && rand() < 0.3) return;
      const dir = rand() < 0.72 ? side : -side;
      branch(n, dir, range(30, 64)).forEach((t) => tips.push({ at: t, dir }));
    });
    set({ load: 0.3 });
    const farTips = [];
    far.slice(1, far.length - 1).forEach((n) => {
      if (rand() < 0.5) return;
      const dir = rand() < 0.6 ? -side : side;
      branch(n, dir, range(24, 40)).forEach((t) => farTips.push({ at: t, dir }));
    });
    // ---- pale leaves behind
    set({ size: 4, load: range(0.15, 0.22), water: 0.55, tip: false });
    farTips.forEach(({ at, dir }) => group(at, hang(dir), pick(['fen', 'ren', 'ge']), range(46, 62), 0.54));
    tips.slice(0, 2).forEach(({ at, dir }) => group([at[0] - dir * 0.012, at[1] - 0.02], hang(dir) + 0.4 * dir, pick(['fen', 'ren']), range(40, 52), 0.5));
    wait(400);
    // ---- dark leaves in front, belly in dark ink and the tip touched in burnt ink
    set({ size: 4, water: 0.55, tip: true });
    tips.forEach(({ at, dir }) => {
      set({ load: range(0.36, 0.56) });
      group(at, hang(dir), pick(['ge', 'ge', 'jie', 'chongge', 'fen', 'ren']), range(56, 78), range(0.56, 0.66));
    });
    // young shoots reaching up at the top of the near stalk
    set({ load: range(0.4, 0.5) });
    const top = near[near.length - 1];
    group([top[0] - 0.004, top[1] + 0.012], range(-2.0, -1.6), pick(['fen', 'ge']), range(40, 52), 0.54);
    wait(600);
    // ---- signature on the open side, the seal pressed beneath it
    const sigU = X(range(0.09, 0.12)), sigV = range(0.05, 0.07), sw = 30, sh = 34;
    // written small-brush and drier than the painting, so it holds on raw xuan
    set({ size: 0, load: 0.8, water: 0.26, tip: false });
    ZHU.forEach((st) => S.push({ type: 'stroke', pts: st.map(([x, y, p]) => [sigU + (x - 0.5) * sw * AX, sigV + y * sh * AY, Math.min(1, p * 1.15)]), speed: range(110, 150), lift: 30, settle: 10 }));
    wait(300);
    set({ tool: 'seal' });
    const sealV = sigV + sh * AY + 12 * AY;
    strokeRaw([[sigU, sealV, 0.6], [sigU + 0.0002, sealV + 0.0001, 0.6]], 60);
    set({ tool: 'brush', size: 5, load: 0.38, water: 0.55, tip: false });
    S.seed = seedIn || seed;
    return S;
  }

  // ------------------------------------------------------------ loop
  renderPigments();
  renderBrush();
  renderPaper();
  renderMedium();
  updateEvap();
  updateUndo();

  // Brush bookkeeping each frame: holding still keeps releasing water, a
  // hovering brush relaxes back into shape, and the paper under the tufts
  // is read back so the brush can pick up what it touches.
  function tickBrush(now, dt, sync) {
    updateToolPose(dt);
    const painting = active && active.stroke instanceof PaintStroke;
    if (active) active.stroke.update(now);
    else if (painterStroke instanceof PencilStroke) painterStroke.update(now);
    else if (hover && !painterStroke && bristlesShown() && state.medium !== 'pencil') {
      brush.step(Math.max(0.004, dt / 1000), hover.x, hover.y, -0.4, null, null, null);
      overlayDirty = true;
    }
    if (painting || painterStroke instanceof PaintStroke) engine.requestBrushSamples(brush.samplePts, brush.N, brush.version, sync);
  }

  let last = performance.now();
  let lastUi = 0;
  function step(now) {
    const dt = Math.min(64, Math.max(0, now - last));
    last = now;
    painter.update(dt);
    tickBrush(now, dt, false);
    engine.update(dt);
    if (engine.dirty) engine.render();
    drawOverlay();
    if (now - lastUi > 120) {
      lastUi = now;
      renderStatus();
      updateUndo();
    }
    renderReservoir();
  }
  let rafHeld = false;
  function frame(now) {
    if (!rafHeld) step(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Runs the real per-frame path at real 60 Hz pacing for ms, yielding to the
  // browser between frames (so asynchronous GPU readbacks resolve as they do
  // in use). For checking behaviour where requestAnimationFrame is throttled,
  // such as a hidden preview pane.
  function runLive(ms) {
    return new Promise((resolve) => {
      rafHeld = true;
      const ch = new MessageChannel();
      const t0 = performance.now();
      let next = t0, frames = 0, worst = 0, prev = t0, work = 0;
      ch.port1.onmessage = () => {
        const now = performance.now();
        if (now >= next) {
          const w0 = performance.now();
          step(now);
          work = Math.max(work, performance.now() - w0);
          frames++;
          worst = Math.max(worst, now - prev);
          prev = now;
          next = Math.max(next + 1000 / 60, now);
        }
        if (now - t0 < ms) ch.port2.postMessage(0);
        else {
          rafHeld = false;
          const sec = (now - t0) / 1000;
          resolve({ frames, fps: +(frames / sec).toFixed(1), worstGapMs: +worst.toFixed(1), worstFrameCpuMs: +work.toFixed(1) });
        }
      };
      ch.port2.postMessage(0);
    });
  }

  // Open on a painting in progress so the first view shows what the tool does.
  if (/^#(sumi|ink)$/i.test(location.hash)) setMedium('ink', true);
  if (!query.has('blank')) {
    engine.pushUndo();
    painter.start(state.medium === 'ink' ? bambooScript() : demoScript());
    updateUndo();
  }
  // Runs the app forward in fixed frames without waiting on the display;
  // used to inspect the simulation from a console or a test harness.
  function simFrame(f) {
    painter.update(f);
    tickBrush(performance.now(), f, true);
    engine.update(f);
  }
  function advance(ms, frameMs) {
    const f = frameMs || 1000 / 60;
    for (let t = 0; t < ms; t += f) simFrame(f);
    engine.render();
    overlayDirty = true;
    drawOverlay();
    renderStatus();
  }
  // hold(true) stops the display loop so a script alone moves time forward
  const hold = (on) => { rafHeld = !!on; };
  window.inkApp = {
    state, painter, engine, brush, setTilt, setDryer, setHumidity, setPaper, selectPigment, setTool, setBrush,
    advance, simFrame, hold, runLive, makeStroke, demoScript, bambooScript, setMedium, ZHU, cellsPerMM, sheetMM,
    drawTool, toolPose, ERASERS,
  };
})();
