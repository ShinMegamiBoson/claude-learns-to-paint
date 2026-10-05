// Bristle brush: a simulated brush head.
//
// The head is a bundle of fibre tufts around a flexible spine. The spine is a
// chain of nodes clamped in the ferrule; pressing the handle down makes it
// buckle onto the paper, where friction holds it so it trails behind the
// handle. Each tuft follows its place in the bundle's cross-section on a
// spring, so tufts lag, fan out when the stroke turns, and come apart into
// separate clumps as the brush dries (surface tension is what holds a wet
// brush to a point). Every tuft carries its own water and pigment: it gives
// water to drier paper, drinks from wetter paper, and trades pigment with
// wet paint it passes through, so a brush dragged through a wash picks up
// that colour and lays it down further along. A belly reservoir feeds the
// tufts by capillarity until it runs out.
(function () {
  'use strict';

  const { reflectRGB } = window.WC_PIGMENTS;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;

  function rng(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ROUND_NO = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24];
  const RIGGER_NO = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
  const FLAT_NAMES = ['⅛″', '¼″', '⅜″', '½″', '⅝″', '¾″', '1″', '1¼″', '1½″', '2″'];
  const FLAT_MM = [3.2, 6.4, 9.5, 12.7, 15.9, 19.1, 25.4, 31.8, 38.1, 50.8];

  // Brush families. Sizes in millimetres. hair = dry fibre colour (sRGB).
  //   stiff    how quickly tufts return to their place in the bundle
  //   bend     spine bending stiffness (low = soft, floppy hair)
  //   spread   how much the bundle flattens and widens when pressed
  //   point    how finely a wet brush comes to a point
  //   tipSplay how far the tip frays open when the brush is dry
  const TYPES = {
    round: {
      label: 'Round', hairName: 'sable', section: 'round', hair: [150, 98, 56],
      stiff: 0.5, bend: 0.32, spread: 0.8, point: 1, tipSplay: 0.45, friction: 0.55, capacity: 1,
      size(i) {
        const no = ROUND_NO[i], d = 0.9 + 0.62 * no;
        return { label: `No. ${no} round`, width: d, thick: d, length: 2.3 * d + 3, tufts: Math.round(40 + 2.4 * no) };
      },
    },
    flat: {
      label: 'Flat', hairName: 'synthetic', section: 'flat', hair: [204, 160, 92],
      stiff: 0.6, bend: 0.42, spread: 0.12, point: 0, tipSplay: 1, friction: 0.5, capacity: 0.9,
      size(i) {
        const w = FLAT_MM[i];
        return { label: `${FLAT_NAMES[i]} flat`, width: w, thick: w * 0.26, length: 0.75 * w + 8, tufts: Math.round(56 + w * 0.8) };
      },
    },
    // Filbert: a flat whose outer hairs are shorter, so its end is a rounded
    // tongue: pressed it lays a flat-sided band, touched lightly an oval
    // (petals, feathers, the shapes most opaque painting is built from).
    filbert: {
      label: 'Filbert', hairName: 'synthetic', section: 'flat', hair: [196, 150, 84], oval: 0.32,
      stiff: 0.6, bend: 0.4, spread: 0.2, point: 0, tipSplay: 0.8, friction: 0.5, capacity: 0.95,
      size(i) {
        const w = FLAT_MM[i] * 0.9;
        return { label: `${FLAT_NAMES[i]} filbert`, width: w, thick: w * 0.32, length: 0.85 * w + 8, tufts: Math.round(56 + w * 0.8) };
      },
    },
    mop: {
      label: 'Mop', hairName: 'squirrel', section: 'round', hair: [78, 62, 50],
      stiff: 0.28, bend: 0.2, spread: 1, point: 0.45, tipSplay: 0.65, friction: 0.6, capacity: 1.7,
      size(i) {
        const d = 8 + 2.6 * i;
        return { label: `Mop No. ${i}`, width: d, thick: d, length: 1.45 * d + 4, tufts: 96 };
      },
    },
    // Soft goat-hair fude for sumi-e: long, holds a great deal of ink, and
    // comes to a very fine point, so one press-and-lift makes a whole leaf.
    fude: {
      label: 'Fude', hairName: 'goat', section: 'round', hair: [224, 212, 188],
      stiff: 0.36, bend: 0.2, spread: 0.7, point: 1.15, tipSplay: 0.6, friction: 0.55, capacity: 1.9,
      size(i) {
        const d = 3 + 1.25 * i;
        const cls = i < 3 ? 'Small' : i < 6 ? 'Medium' : i < 9 ? 'Large' : 'Extra-large';
        return { label: `${cls} fude`, width: d, thick: d, length: 3.3 * d + 7, tufts: Math.round(44 + 3 * i) };
      },
    },
    rigger: {
      label: 'Rigger', hairName: 'sable', section: 'round', hair: [150, 98, 56],
      stiff: 0.32, bend: 0.2, spread: 0.45, point: 0.75, tipSplay: 0.5, friction: 0.5, capacity: 1.4,
      size(i) {
        const no = RIGGER_NO[i], d = 0.7 + 0.28 * no;
        return { label: `No. ${no} rigger`, width: d, thick: d, length: 9 * d + 12, tufts: 24 };
      },
    },
  };

  const K = 8;          // spine segments
  const M = 4;          // particles along each tuft
  const CONTACT_Z = 0.35;
  const MAX_TARGET = 0.24;
  // how quickly a tuft brings the paper under it to the tuft's own wetness,
  // per second of contact (the apply pass turns contact time into exp(-kt))
  const CONTACT_RATE = 110;

  class BristleBrush {
    constructor(cellsPerMM) {
      this.cpm = cellsPerMM;
      this.leanDir = [0.55, -0.83];   // direction the tip trails toward
      this.leanMag = 0.2;
      this.axis = [0, 0, -1];
      this.handle = [0, 0, 0];
      this.flatAngle = -0.25;
      this.press = 0;
      this.placed = false;
      this.loaded = false;
      this.version = 0;
      this.feedSpread = true;
      this.edgeDry = 0.45;
      this.smoothSpine = true;     // hair bends continuously between the chain's joints
      this.roundContact = true;    // a tuft meets the paper as a round bundle, not a line
      this.holdPoint = true;       // a loaded brush lands pointed and splits as it drags dry
      this.fineTips = true;        // a tuft thins toward its tip
      this.splay = 0;
      this.hairSeed = 0;
      this.configure('round', 4);
    }

    static get TYPES() { return TYPES; }

    configure(type, sizeIdx) {
      const T = TYPES[type], S = T.size(sizeIdx);
      this.type = type; this.sizeIdx = sizeIdx; this.T = T; this.S = S;
      const c = this.cpm;
      this.L = S.length * c;
      this.seg = this.L / K;
      this.Wc = S.width * 0.5 * c;
      this.Hc = S.thick * 0.5 * c;
      const N = (this.N = S.tufts);
      const r = rng(9173 + sizeIdx * 131 + type.charCodeAt(0) * 17);
      const flat = T.section === 'flat';
      const clusters = (this.clusters = flat ? 9 : 7);
      this.ta = new Float32Array(N);
      this.tb = new Float32Array(N);
      this.tend = new Float32Array(N);
      this.tjit = new Float32Array(N);
      this.tstiff = new Float32Array(N);
      this.tseed = new Float32Array(N);
      this.tcl = new Uint8Array(N);
      this.trho = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        if (flat) {
          const a = ((i + r()) / N) * 2 - 1;
          this.ta[i] = a;
          this.tb[i] = r() * 2 - 1;
          this.tend[i] = 1 - (T.oval || 0) * a * a - 0.035 * r();
          this.trho[i] = Math.abs(a);
          this.tcl[i] = Math.min(clusters - 1, Math.floor(((a + 1) / 2) * clusters));
        } else {
          const rho = Math.sqrt((i + 0.5) / N) * (0.9 + 0.1 * r());
          const th = i * 2.39996 + r() * 0.3;
          this.ta[i] = rho * Math.cos(th);
          this.tb[i] = rho * Math.sin(th);
          // the innermost hairs are the longest and end at the spine's tip, so a
          // lightly touching brush meets the paper with its point first
          this.tend[i] = 1 - T.point * 0.42 * rho * rho - 0.04 * r() * rho;
          this.trho[i] = rho;
          const ang = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          this.tcl[i] = Math.min(clusters - 1, Math.floor((ang / (Math.PI * 2)) * clusters));
        }
        this.tjit[i] = r() * 2 - 1;
        this.tstiff[i] = T.stiff * (0.8 + 0.4 * r());
        this.tseed[i] = r();
      }
      this.clA = new Float32Array(clusters);
      const cnt = new Float32Array(clusters);
      for (let i = 0; i < N; i++) { this.clA[this.tcl[i]] += this.ta[i]; cnt[this.tcl[i]]++; }
      for (let k = 0; k < clusters; k++) this.clA[k] /= Math.max(1, cnt[k]);
      this.clWet = new Float32Array(clusters);

      this.rf = flat
        ? Math.max(0.6, 1.3 * Math.sqrt((4 * this.Wc * this.Hc) / (Math.PI * N)))
        : Math.max(0.6, (1.3 * this.Wc) / Math.sqrt(N));

      // water: 30% in the tufts, the rest in the belly (units of cell-depth)
      const volMM3 = (flat ? S.width * S.thick : S.width * S.width * 0.785) * S.length;
      // capScale: paint is laid per cell, so at a finer simulation the same
      // brush must carry proportionally more of it (set for gouache)
      this.cap = volMM3 * 8 * T.capacity * (this.capScale || 1);
      this.tcap = (this.cap * 0.3) / N;
      this.Rcap = this.cap * 0.7;
      this.R = 0;
      this.CR = new Float32Array(8);
      this.wet = new Float32Array(N);
      this.conc = new Float32Array(N * 8);

      this.sp = new Float32Array((K + 1) * 3);
      this.spo = new Float32Array((K + 1) * 3);
      this.spc = new Uint8Array(K + 1);
      this.fT = new Float32Array(K * 3);
      this.fN = new Float32Array(K * 3);
      this.fB = new Float32Array(K * 3);
      this.nN = new Float32Array((K + 1) * 3);
      this.X = new Float32Array(N * M * 3);
      this.Xo = new Float32Array(N * M * 3);
      this.Xc = new Uint8Array(N * M);
      this.X0 = new Float32Array(N * 3);
      this.samplePts = new Float32Array(N * 2);
      this.hasSample = new Uint8Array(N);
      this.colors = new Array(N).fill('rgb(150,98,56)');
      this.colorAge = 99;
      this.placed = false;
      this.hasPose = false;
      this.loaded = false;
      this.stackNorm = 0.15;
      this.version++;
    }

    get label() { return this.S.label; }
    get widthMM() { return this.S.width; }
    get reservoir() { return this.Rcap > 0 ? this.R / this.Rcap : 0; }
    get meanWet() { let s = 0; for (let i = 0; i < this.N; i++) s += this.wet[i]; return s / this.N; }

    // Average pigment on the brush (for the UI and for spatter).
    meanConc(out) {
      out = out || new Float32Array(8);
      out.fill(0);
      let wsum = 0;
      for (let i = 0; i < this.N; i++) {
        const w = this.wet[i] + 0.05;
        for (let p = 0; p < 8; p++) out[p] += this.conc[i * 8 + p] * w;
        wsum += w;
      }
      const rw = this.R / Math.max(1e-6, this.Rcap) * this.N * 0.6;
      for (let p = 0; p < 8; p++) out[p] = (out[p] + this.CR[p] * rw) / (wsum + rw);
      return out;
    }

    // Dip the brush: fill it with water and paint. keep is how much of what
    // was already in the hair survives (a brush is never perfectly clean).
    dip(conc, water, keep) {
      const k = keep == null ? 0.12 : keep;
      // each loading settles the hairs differently (deterministic: no Math.random)
      this.dips = (this.dips || 0) + 1;
      this.hairSeed = Math.floor(Math.abs(Math.sin(this.dips * 12.9898 + 4.1) * 43758.5453) % 997);
      const level = 0.18 + 0.82 * water;
      for (let i = 0; i < this.N; i++) {
        this.wet[i] = level;
        for (let p = 0; p < 8; p++) this.conc[i * 8 + p] = this.conc[i * 8 + p] * k + (conc ? conc[p] : 0) * (1 - k);
      }
      for (let p = 0; p < 8; p++) this.CR[p] = this.CR[p] * k + (conc ? conc[p] : 0) * (1 - k);
      this.R = this.Rcap * Math.pow(water, 1.25);
      this.loaded = true;
      this.splay = 0;
      this.colorAge = 99;
    }

    drain(amount) { this.R = Math.max(0, this.R - amount); }

    // Paint mixed loosely on the palette: each part of the brush carries a
    // slightly different share of the colours, varying smoothly across the
    // hairs, so a stroke shows streaks of the colours it was mixed from.
    // amount 0 = thoroughly mixed.
    marble(amount) {
      if (!(amount > 0)) return;
      const d = this.dips || 1;
      const wave = (x, p) => {
        const a = Math.sin(x * (2.1 + 0.37 * p) + d * 1.7 + p * 2.3), b = Math.sin(x * (5.3 + 0.21 * p) + d * 0.9 + p * 4.1);
        return 0.65 * a + 0.35 * b;
      };
      for (let i = 0; i < this.N; i++) {
        const x = this.ta[i] * 3 + this.tb[i] * 0.7;
        let tot0 = 0, tot1 = 0;
        for (let p = 0; p < 8; p++) tot0 += this.conc[i * 8 + p];
        for (let p = 0; p < 8; p++) {
          const c = this.conc[i * 8 + p];
          if (c <= 0) continue;
          this.conc[i * 8 + p] = c * Math.max(0.05, 1 + amount * wave(x, p));
          tot1 += this.conc[i * 8 + p];
        }
        if (tot1 > 0) for (let p = 0; p < 8; p++) this.conc[i * 8 + p] *= tot0 / tot1;
      }
      this.colorAge = 99;
    }

    // Touch just the tip into dark ink after loading the belly with a paler
    // tone (the sumi-e "three inks" load): the long central hairs that form
    // the point carry the dark, the outer belly stays pale, so a single
    // stroke grades from dark to light across its width.
    tipDip(conc, amount) {
      const k = amount == null ? 1 : amount;
      for (let i = 0; i < this.N; i++) {
        const t = k * (1 - smooth(0.25, 0.75, this.trho[i]));
        for (let p = 0; p < 8; p++) this.conc[i * 8 + p] += (conc[p] - this.conc[i * 8 + p]) * t;
      }
      this.colorAge = 99;
    }

    _straighten(x, y, z) {
      const [ax, ay, az] = this.axis;
      for (let k = 0; k <= K; k++) {
        const i = k * 3;
        this.sp[i] = x + ax * this.seg * k;
        this.sp[i + 1] = y + ay * this.seg * k;
        this.sp[i + 2] = z + az * this.seg * k;
        this.spo[i] = this.sp[i]; this.spo[i + 1] = this.sp[i + 1]; this.spo[i + 2] = this.sp[i + 2];
        this.spc[k] = 0;
      }
      this.hasPose = false;
    }

    // Handle height for a pressure. Negative pressure lifts the brush clear.
    zFor(p) { return this.L * (1.03 - 0.82 * p); }

    // One physics step. x, y in sim cells; p pressure (-0.4..1);
    // tilt = [tx, ty] from a pen, or null; out = capsule sink or null.
    step(dt, x, y, p, tilt, out, samples, tMs) {
      const T = this.T;
      const prev = this.pointer || [x, y];
      const vx = (x - prev[0]) / dt, vy = (y - prev[1]) / dt;
      const speed = this.placed ? Math.hypot(vx, vy) : 0;
      this.pointer = [x, y];
      this.speed = speed;

      // the brush leans with the stroke, so the tip trails behind the handle
      const flatB = T.section === 'flat';
      const fnx = Math.cos(this.flatAngle), fny = Math.sin(this.flatAngle);   // a flat's wide axis
      if (tilt) {
        const m = Math.hypot(tilt[0], tilt[1]);
        if (m > 0.02) { this.leanDir = [tilt[0] / m, tilt[1] / m]; this.leanMag = clamp(m, 0.05, 0.9); this.upright = 0; }
        else {   // held upright (a press straight down)
          this.leanMag += (0.01 - this.leanMag) * Math.min(1, dt * 12);
          this.upright = Math.min(1, (this.upright || 0) + dt * 12);
        }
      } else {
        this.upright = 0;
        if (speed > 8) {
          const tx = -vx / speed, ty = -vy / speed;
          const f = Math.min(1, dt * 9 * smooth(8, 150, speed));
          let lx = this.leanDir[0] + (tx - this.leanDir[0]) * f, ly = this.leanDir[1] + (ty - this.leanDir[1]) * f;
          const lm = Math.hypot(lx, ly) || 1;
          this.leanDir = [lx / lm, ly / lm];
        }
        const target = 0.2 + 0.32 * smooth(0, 350, speed);
        this.leanMag += (target - this.leanMag) * Math.min(1, dt * 8);
      }
      let lx0 = this.leanDir[0] * this.leanMag, ly0 = this.leanDir[1] * this.leanMag;
      if (flatB) {
        // a flat can only lean across its thickness
        const d = lx0 * -fny + ly0 * fnx;
        lx0 = -fny * d; ly0 = fnx * d;
      }
      let ax = lx0, ay = ly0, az = -1;
      const al = Math.hypot(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      this.axis = [ax, ay, az];

      // (x, y) is where the brush meets the paper; the ferrule sits up the
      // handle's axis from there
      const z = this.zFor(p);
      const reach = z / Math.max(0.25, -az);
      const hx0 = x - ax * reach, hy0 = y - ay * reach;
      this.handle = [hx0, hy0, z];
      this.press = clamp(1 - z / this.L, 0, 1);
      if (!this.placed) { this._straighten(hx0, hy0, Math.max(z, this.L * 1.1)); this.placed = true; }
      x = hx0; y = hy0;

      // ---- spine: position-based dynamics, clamped at the ferrule
      const sp = this.sp, so = this.spo, sc = this.spc, seg = this.seg;
      let wetAvg = 0;
      for (let i = 0; i < this.N; i++) wetAvg += this.wet[i];
      wetAvg /= this.N;
      this.wetAvg = wetAvg;
      const mu = T.friction * (0.6 + 0.4 * wetAvg);
      for (let k = 1; k <= K; k++) {
        const i = k * 3;
        const px = sp[i], py = sp[i + 1], pz = sp[i + 2];
        sp[i] += (px - so[i]) * 0.3; sp[i + 1] += (py - so[i + 1]) * 0.3; sp[i + 2] += (pz - so[i + 2]) * 0.3;
        so[i] = px; so[i + 1] = py; so[i + 2] = pz;
        if (sc[k]) { sp[i] += (px - sp[i]) * mu; sp[i + 1] += (py - sp[i + 1]) * mu; }
      }
      for (let it = 0; it < 5; it++) {
        sp[0] = x; sp[1] = y; sp[2] = z;
        sp[3] = x + ax * seg; sp[4] = y + ay * seg; sp[5] = z + az * seg;
        for (let k = 1; k < K; k++) {
          const i0 = (k - 1) * 3, i1 = k * 3, i2 = (k + 1) * 3;
          let tx = 2 * sp[i1] - sp[i0], ty = 2 * sp[i1 + 1] - sp[i0 + 1], tz = 2 * sp[i1 + 2] - sp[i0 + 2];
          const rx = x + ax * seg * (k + 1), ry = y + ay * seg * (k + 1), rz = z + az * seg * (k + 1);
          tx += (rx - tx) * 0.06; ty += (ry - ty) * 0.06; tz += (rz - tz) * 0.06;
          const w = T.bend * (1 - (0.55 * k) / K);
          sp[i2] += (tx - sp[i2]) * w; sp[i2 + 1] += (ty - sp[i2 + 1]) * w; sp[i2 + 2] += (tz - sp[i2 + 2]) * w;
        }
        if (flatB) {
          // keep the spine out of the flat's wide plane: it resists bending sideways
          for (let k = 2; k <= K; k++) {
            const i = k * 3;
            const d = (sp[i] - x) * fnx + (sp[i + 1] - y) * fny;
            sp[i] -= fnx * d * 0.85; sp[i + 1] -= fny * d * 0.85;
          }
        }
        for (let k = 2; k <= K; k++) {
          const i0 = (k - 1) * 3, i1 = k * 3;
          const dx = sp[i1] - sp[i0], dy = sp[i1 + 1] - sp[i0 + 1], dz = sp[i1 + 2] - sp[i0 + 2];
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          const s = seg / d;
          sp[i1] = sp[i0] + dx * s; sp[i1 + 1] = sp[i0 + 1] + dy * s; sp[i1 + 2] = sp[i0 + 2] + dz * s;
          if (sp[i1 + 2] < 0) sp[i1 + 2] = 0;
        }
      }
      // held upright, a pushed-down brush does not fold over to one side: the
      // spine stays over the point of contact and compresses (the hairs bow
      // outward all round, which the tufts' fan below draws as a rosette)
      if (!flatB) {
        const up = this.upright || 0;
        if (up > 0) for (let k = 1; k <= K; k++) {
          const i = k * 3;
          sp[i] += (x - sp[i]) * up * 0.85;
          sp[i + 1] += (y - sp[i + 1]) * up * 0.85;
        }
      }
      for (let k = 0; k <= K; k++) sc[k] = sp[k * 3 + 2] < 0.3 ? 1 : 0;

      // ---- frames along the spine
      const fT = this.fT, fN = this.fN, fB = this.fB;
      const flat = T.section === 'flat';
      const lx = this.leanDir[0], ly = this.leanDir[1];
      let pnx = -ly, pny = lx, pnz = 0;
      for (let k = 0; k < K; k++) {
        const i0 = k * 3, i1 = (k + 1) * 3;
        let tx = sp[i1] - sp[i0], ty = sp[i1 + 1] - sp[i0 + 1], tz = sp[i1 + 2] - sp[i0 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        let nx, ny, nz;
        if (flat) {
          nx = Math.cos(this.flatAngle); ny = Math.sin(this.flatAngle); nz = 0;
        } else {
          const h = Math.hypot(tx, ty);
          let ux = ty / (h || 1), uy = -tx / (h || 1);
          const bx = -ly, by = lx;
          if (ux * bx + uy * by < 0) { ux = -ux; uy = -uy; }
          const f = smooth(0.25, 0.75, h);
          nx = bx + (ux - bx) * f; ny = by + (uy - by) * f; nz = 0;
        }
        const dn = nx * tx + ny * ty + nz * tz;
        nx -= tx * dn; ny -= ty * dn; nz -= tz * dn;
        let nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-4) { nx = pnx; ny = pny; nz = pnz; nl = 1; }
        nx /= nl; ny /= nl; nz /= nl;
        pnx = nx; pny = ny; pnz = nz;
        fT[i0] = tx; fT[i0 + 1] = ty; fT[i0 + 2] = tz;
        fN[i0] = nx; fN[i0 + 1] = ny; fN[i0 + 2] = nz;
        fB[i0] = ty * nz - tz * ny; fB[i0 + 1] = tz * nx - tx * nz; fB[i0 + 2] = tx * ny - ty * nx;
      }
      // normals at the joints (the mean of the segments either side), so the
      // smooth spine below can turn its frame continuously
      const nN = this.nN;
      for (let k = 0; k <= K; k++) {
        const a = Math.max(0, k - 1) * 3, b = Math.min(K - 1, k) * 3;
        let x = fN[a] + fN[b], y = fN[a + 1] + fN[b + 1], z = fN[a + 2] + fN[b + 2];
        const l = Math.hypot(x, y, z) || 1;
        nN[k * 3] = x / l; nN[k * 3 + 1] = y / l; nN[k * 3 + 2] = z / l;
      }

      // ---- cluster wetness decides how much the tufts clump
      const clWet = this.clWet;
      clWet.fill(0);
      const clN = new Float32Array(this.clusters);
      for (let i = 0; i < this.N; i++) { clWet[this.tcl[i]] += this.wet[i]; clN[this.tcl[i]]++; }
      for (let c = 0; c < this.clusters; c++) clWet[c] /= Math.max(1, clN[c]);
      const dry = 1 - wetAvg;
      // A loaded brush is pointed (the painter forms the point on the dish),
      // and it lands with that point; dragged over the paper with too little
      // water to hold the hairs together, the tip splits within a few tens
      // of millimetres. A split brush stays split until it is loaded again.
      let splay = Math.pow(dry, 1.5);
      if (this.holdPoint) {
        if (this.pressed) this.splay += (splay - this.splay) * Math.min(1, dt / 0.05);
        splay = Math.min(splay, this.splay);
      }
      const tipR = mix(Math.max(0.02, 0.04 + (1 - T.point) * 0.35), T.tipSplay, splay);
      // held upright and pushed down, the belly cannot lie over to one side:
      // it spreads every way into a rosette
      const upright = flat ? 0 : this.upright || 0;
      const cohesion = mix(1.18, 0.96, wetAvg);
      const maxLag = 0.12 * this.L + 2;

      // ---- tufts
      const X = this.X, Xo = this.Xo, Xc = this.Xc;
      for (let i = 0; i < this.N; i++) {
        const c = this.tcl[i];
        // surface tension holds a wet brush together; as it dries the hair
        // parts into clumps with bare gaps between them
        const clump = 0.92 * Math.pow(1 - clWet[c], 1.1);
        const aE = this.ta[i] + (this.clA[c] - this.ta[i]) * clump + this.tjit[i] * 0.1 * (1 - this.wet[i]);
        const bE = this.tb[i];
        const kS = this.tstiff[i];
        const muB = T.friction * (0.5 + 0.5 * this.wet[i]);
        for (let j = -1; j < M; j++) {
          const sig = j < 0 ? 0 : (this.tend[i] * (j + 1)) / M;
          const F = this._spineAt(sig * K);
          const Px = F[0], Py = F[1], Pz = F[2];
          let W, H;
          if (flat) {
            W = this.Wc * (0.96 + 0.08 * sig) * mix(1.08, 1, wetAvg);
            H = this.Hc * (1 - 0.65 * sig);
          } else {
            const prof = sig < 0.28 ? 0.8 + (0.2 * sig) / 0.28 : 1 - Math.pow((sig - 0.28) / 0.72, 1.6) * (1 - tipR);
            W = H = this.Wc * prof * cohesion;
          }
          const squash = 1 - smooth(0, 1.5 + H * 0.5, Pz);
          // pressed hairs fan out, each by its own amount, and further when dry
          const fan = 1 + T.spread * this.press * squash * (0.7 + 0.6 * this.tseed[i]) * (0.75 + 0.5 * dry) * (1 + 0.6 * upright);
          W *= fan;
          H *= mix(1 - 0.75 * squash, fan, upright);
          let Tx = Px + F[3] * aE * W + F[6] * bE * H;
          let Ty = Py + F[4] * aE * W + F[7] * bE * H;
          let Tz = Pz + F[5] * aE * W + F[8] * bE * H;
          if (Tz < 0) Tz = 0;
          if (j < 0) { this.X0[i * 3] = Tx; this.X0[i * 3 + 1] = Ty; this.X0[i * 3 + 2] = Tz; continue; }
          const q = (i * M + j) * 3;
          const ox = X[q], oy = X[q + 1], oz = X[q + 2];
          let nx = ox + (ox - Xo[q]) * 0.15, ny = oy + (oy - Xo[q + 1]) * 0.15, nz = oz + (oz - Xo[q + 2]) * 0.15;
          Xo[q] = ox; Xo[q + 1] = oy; Xo[q + 2] = oz;
          const onPaper = Tz < CONTACT_Z;
          if (onPaper) {
            const kk = kS * (1 - muB);
            nx += (Tx - nx) * kk; ny += (Ty - ny) * kk; nz = 0;
            const dx = nx - Tx, dy = ny - Ty, dl = Math.hypot(dx, dy);
            if (dl > maxLag) { nx = Tx + (dx / dl) * maxLag; ny = Ty + (dy / dl) * maxLag; }
          } else {
            nx += (Tx - nx) * kS; ny += (Ty - ny) * kS; nz += (Tz - nz) * kS;
            if (nz < 0) nz = 0;
          }
          if (!this.hasPose) { nx = Tx; ny = Ty; nz = Tz; Xo[q] = nx; Xo[q + 1] = ny; Xo[q + 2] = nz; }
          X[q] = nx; X[q + 1] = ny; X[q + 2] = nz;
          Xc[i * M + j] = nz < CONTACT_Z ? 1 : 0;
        }
      }
      this.hasPose = true;

      let on = 0;
      for (let q = 0; q < Xc.length && !on; q++) on = Xc[q];
      this.pressed = !!on;
      if (out) this._contact(dt, out, samples, tMs);
      this._feed(dt);
      this.colorAge++;
    }

    // Deposit along every tuft segment lying on the paper, and trade water
    // and pigment with the paper under it. Tufts are stacked in the bundle,
    // so many of them sit over the same patch of paper; exchange is scaled
    // to the area the whole footprint actually covers.
    // A point on the spine and its frame, u in joints (0 at the ferrule, K at
    // the tip). The joints are the simulated chain; between them the hair is
    // a smooth curve (a quadratic B-spline of the chain, exact at both ends),
    // not straight segments: a real brush bends continuously, so it lies down
    // onto the paper gradually instead of a whole segment at a time.
    _spineAt(u) {
      const sp = this.sp, F = this._F || (this._F = new Float32Array(9));
      const fN = this.fN, fB = this.fB, nN = this.nN;
      const kS = Math.min(K - 1, Math.max(0, Math.floor(u))), f = u - kS;
      if (!this.smoothSpine) {
        const i0 = kS * 3, i1 = i0 + 3;
        for (let c = 0; c < 3; c++) { F[c] = sp[i0 + c] + (sp[i1 + c] - sp[i0 + c]) * f; F[3 + c] = fN[i0 + c]; F[6 + c] = fB[i0 + c]; }
        return F;
      }
      let tx, ty, tz;
      if (u <= 0.5 || u >= K - 0.5) {
        const i0 = kS * 3, i1 = i0 + 3;
        for (let c = 0; c < 3; c++) F[c] = sp[i0 + c] + (sp[i1 + c] - sp[i0 + c]) * f;
        tx = sp[i1] - sp[i0]; ty = sp[i1 + 1] - sp[i0 + 1]; tz = sp[i1 + 2] - sp[i0 + 2];
      } else {
        const k = Math.floor(u + 0.5), t = u - (k - 0.5), a = (k - 1) * 3, b = k * 3, c3 = (k + 1) * 3;
        const w0 = 0.5 * (1 - t) * (1 - t), w2 = 0.5 * t * t, w1 = 1 - w0 - w2;
        for (let c = 0; c < 3; c++) F[c] = w0 * sp[a + c] + w1 * sp[b + c] + w2 * sp[c3 + c];
        tx = (1 - t) * (sp[b] - sp[a]) + t * (sp[c3] - sp[b]);
        ty = (1 - t) * (sp[b + 1] - sp[a + 1]) + t * (sp[c3 + 1] - sp[b + 1]);
        tz = (1 - t) * (sp[b + 2] - sp[a + 2]) + t * (sp[c3 + 2] - sp[b + 2]);
      }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const n0 = kS * 3, n1 = n0 + 3;
      let nx = nN[n0] + (nN[n1] - nN[n0]) * f, ny = nN[n0 + 1] + (nN[n1 + 1] - nN[n0 + 1]) * f, nz = nN[n0 + 2] + (nN[n1 + 2] - nN[n0 + 2]) * f;
      const dn = nx * tx + ny * ty + nz * tz;
      nx -= tx * dn; ny -= ty * dn; nz -= tz * dn;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-4) { for (let c = 0; c < 3; c++) { F[3 + c] = fN[n0 + c]; F[6 + c] = fB[n0 + c]; } return F; }
      nx /= nl; ny /= nl; nz /= nl;
      F[3] = nx; F[4] = ny; F[5] = nz;
      F[6] = ty * nz - tz * ny; F[7] = tz * nx - tx * nz; F[8] = tx * ny - ty * nx;
      return F;
    }

    _contact(dt, out, samples, tMs) {
      const X = this.X, Xo = this.Xo, Xc = this.Xc, rf = this.rf;
      // bundle radius at each particle along a tuft: full at the root, a
      // fraction at the tip
      const tuftR = this._tuftR || (this._tuftR = new Float32Array(M));
      for (let j = 0; j < M; j++) tuftR[j] = rf * (1 - (1 - (this.fineTips ? 0.6 : 1)) * Math.pow((j + 1) / M, 3));
      const fast = smooth(250 * this.cpm, 900 * this.cpm, this.speed || 0);
      const sps = out.stepsPerSecond;
      const S = samples && samples.valid && samples.version === this.version ? samples : null;
      const N = this.N;
      const give = this._give || (this._give = new Float32Array(128));
      const take = this._take || (this._take = new Float32Array(128));
      const mixA = this._mixA || (this._mixA = new Float32Array(128));
      const cps = this._cps || (this._cps = new Float32Array(128 * 8));
      give.fill(0); take.fill(0); mixA.fill(0);
      // footprint extent across and along the direction of travel
      const hv = this.speed > 1 ? [-this.leanDir[0], -this.leanDir[1]] : [1, 0];
      const px = -hv[1], py = hv[0];
      let aMin = 1e9, aMax = -1e9, lMin = 1e9, lMax = -1e9, raw = 0, still = 0, any = false;
      // contact strength is time on the paper, spread over the tufts stacked
      // above each spot so a dense bundle doesn't count the same paper twice
      const strength = dt * CONTACT_RATE * this.stackNorm;

      for (let i = 0; i < N; i++) {
        const wet = this.wet[i];
        const target = 0.03 + (MAX_TARGET - 0.03) * Math.pow(wet, 1.3) + 0.04 * this.press * wet;
        // the outermost hairs splay and hold less ink: a brush that is not
        // flooded touches the paper only partly at its edges (ragged, streaky
        // flanks) while its core still lays solid ink
        const flank = this.edgeDry * smooth(0.6, 1.0, this.trho[i]) * clamp(1.4 - 1.6 * wet, 0, 1);
        const contact = clamp(0.2 + 1.2 * wet + 0.35 * this.press - 0.35 * fast * (1 - wet) - flank, 0.05, 1);
        const thirst = clamp(1 - wet * 2.3, 0, 1) * 0.85;
        const conc = this.conc.subarray(i * 8, i * 8 + 8);

        // paper under this tuft, as last read back from the GPU
        let wp = 0;
        const cp = cps.subarray(i * 8, i * 8 + 8);
        cp.fill(0);
        if (S && this.hasSample[i]) {
          wp = S.w[i * 4];
          if (wp > 1e-4) {
            for (let p = 0; p < 4; p++) { cp[p] = S.g0[i * 4 + p] / wp; cp[p + 4] = S.g1[i * 4 + p] / wp; }
          }
        }

        let sx = 0, sy = 0, sn = 0, lead = -1e9, lx = 0, ly = 0;
        for (let j = 0; j < M; j++) {
          const q = (i * M + j) * 3;
          let ax = X[q], ay = X[q + 1], az = X[q + 2];
          let bx, by, bz, ra = rf, rb = rf, graze = 1;
          if (this.roundContact) {
            // the tuft is a bundle around its centreline, thinning to its tip
            // (the hairs taper): it touches wherever the centreline is within
            // the bundle's radius of the paper, over the chord of its round
            // section with the paper's plane, so a tuft coming down meets the
            // paper as a fine line that widens
            const R0 = tuftR[j], R1 = j + 1 < M ? tuftR[j + 1] : R0, Rb = Math.max(R0, R1);
            if (j + 1 < M) { const r = q + 3; bx = X[r]; by = X[r + 1]; bz = X[r + 2]; }
            else { bx = Xo[q]; by = Xo[q + 1]; bz = az; }   // the tip sweeps from where it was
            if (az >= Rb && bz >= Rb) continue;
            if (az > Rb || bz > Rb) {
              const hi = az > Rb, zi = hi ? bz : az, zo = hi ? az : bz;
              const t = clamp((Rb - zi) / Math.max(1e-4, zo - zi), 0, 1);
              if (hi) { ax = bx + (ax - bx) * t; ay = by + (ay - by) * t; az = Rb; }
              else { bx = ax + (bx - ax) * t; by = ay + (by - ay) * t; bz = Rb; }
            }
            ra = Math.sqrt(Math.max(0, R0 * R0 - az * az));
            rb = Math.sqrt(Math.max(0, R1 * R1 - bz * bz));
            if (ra + rb < 0.05) continue;
            // a grazing bundle touches with its lowest hairs only: on a
            // brush too dry to flood the paper, light contact breaks up
            graze = this.grazeContact === false ? 1 : 0.6 + 0.4 * clamp(1 - (az + bz) / (R0 + R1), 0, 1);
          } else {
            const inJ = Xc[i * M + j];
            const nextIn = j + 1 < M ? Xc[i * M + j + 1] : 0;
            if (!inJ && !(j + 1 < M && nextIn)) continue;
            if (j + 1 < M) { const r = q + 3; bx = X[r]; by = X[r + 1]; bz = X[r + 2]; }
            else { bx = Xo[q]; by = Xo[q + 1]; bz = 0; }   // the tip sweeps from where it was
            if (!inJ || (j + 1 < M && !nextIn)) {
              // only part of this segment is down: clip it where it leaves the paper
              const zi = inJ ? az : bz, zo = inJ ? bz : az;
              const t = clamp((CONTACT_Z - zi) / Math.max(1e-4, zo - zi), 0, 1);
              if (inJ) { bx = ax + (bx - ax) * t; by = ay + (by - ay) * t; }
              else { ax = bx + (ax - bx) * t; ay = by + (ay - by) * t; }
            }
          }
          const rm = 0.5 * (ra + rb);
          const len = Math.hypot(bx - ax, by - ay);
          const disp = Math.hypot(X[q] - Xo[q], X[q + 1] - Xo[q + 1]);
          const vx = (X[q] - Xo[q]) / dt / sps, vy = (X[q + 1] - Xo[q + 1]) / dt / sps;
          const vm = Math.hypot(vx, vy), vc = vm > 1.2 ? 1.2 / vm : 1;
          out.capsule(ax, ay, bx, by, ra, target, strength, contact >= 1 ? 1 : contact * graze, this.tseed[i], conc, vx * vc, vy * vc, thirst, tMs, this.hairSeed + (this.tcl[i] + 0.5) / this.clusters, rb);
          still += (len + 2 * rm) * 2 * rm;
          const area = 2 * rm * (disp + len * 1.6 * dt) + 1e-4;
          raw += area;
          give[i] += Math.max(0, target - wp) * area;
          take[i] += thirst * Math.max(0, wp - target) * area * 0.8;
          if (wp > 0.01) mixA[i] += Math.min(1, (len * rf * 2) / 40) * dt;
          for (const [cx, cy] of [[ax, ay], [bx, by]]) {
            const a = cx * px + cy * py, l = cx * hv[0] + cy * hv[1];
            if (a < aMin) aMin = a; if (a > aMax) aMax = a;
            if (l < lMin) lMin = l; if (l > lMax) lMax = l;
            if (l > lead) { lead = l; lx = cx; ly = cy; }
          }
          sx += (ax + bx) * 0.5; sy += (ay + by) * 0.5; sn++;
        }
        if (sn) {
          // Read the paper just ahead of the tuft: what it is about to touch,
          // not what it wetted itself a frame ago (which would make the
          // brush's water budget depend on the display's frame rate).
          const moving = smooth(20, 120, this.speed || 0);
          const ahead = (rf * 1.5 + (this.speed || 0) * 0.02) * moving;
          this.samplePts[i * 2] = mix(sx / sn, lx + hv[0] * ahead, moving);
          this.samplePts[i * 2 + 1] = mix(sy / sn, ly + hv[1] * ahead, moving);
          this.hasSample[i] = 1;
          any = true;
        }
      }
      if (!any) return;

      const width = aMax - aMin + 2 * rf, along = lMax - lMin + 2 * rf;
      this.stackNorm += (clamp((width * along) / Math.max(1e-3, still), 0.02, 1) - this.stackNorm) * 0.3;
      const moved = (this.speed || 0) * dt;
      const trueArea = width * moved + width * along * 1.6 * dt;
      const k = Math.min(1, trueArea / Math.max(1e-4, raw));

      for (let i = 0; i < N; i++) {
        if (!give[i] && !take[i] && !mixA[i]) continue;
        const conc = this.conc.subarray(i * 8, i * 8 + 8);
        const cp = cps.subarray(i * 8, i * 8 + 8);
        const vol = this.wet[i] * this.tcap;
        let nv = Math.max(0, vol - give[i] * k);
        const tk = take[i] * k;
        if (tk > 0) {
          const nt = nv + tk;
          for (let p = 0; p < 8; p++) conc[p] = (conc[p] * nv + cp[p] * tk) / Math.max(1e-6, nt);
          nv = nt;
        }
        if (mixA[i] > 0) {
          // pigment trades both ways where hair lies in wet paint; a loaded
          // brush holds its own colour better than a thin one
          const load = Math.min(1, (conc[0] + conc[1] + conc[2] + conc[3] + conc[4] + conc[5] + conc[6] + conc[7]) / 6);
          const m = Math.min(0.35, mixA[i] * 1.1 * (1 - 0.5 * load));
          for (let p = 0; p < 8; p++) conc[p] += (cp[p] - conc[p]) * m;
        }
        if (nv > this.tcap) { this.R = Math.min(this.Rcap, this.R + (nv - this.tcap)); nv = this.tcap; }
        this.wet[i] = nv / this.tcap;
      }
    }

    // Capillary exchange between the belly and each tuft.
    _feed(dt) {
      const lev = this.Rcap > 0 ? this.R / this.Rcap : 0;
      const kf = Math.min(1, dt * 30);
      for (let i = 0; i < this.N; i++) {
        const d = lev - this.wet[i];
        if (d > 0 && this.R > 0) {
          // the belly feeds the core first: outer hairs (and some at random)
          // refill slower, so a brush running dry breaks up at its edges
          // while its centre still lays solid ink
          const reach = this.feedSpread ? (1.2 - 0.85 * this.trho[i] * this.trho[i]) * (0.75 + 0.5 * this.tseed[i]) : 1;
          const flow = Math.min(this.R, d * kf * reach * this.tcap);
          const vol = this.wet[i] * this.tcap;
          const nv = vol + flow;
          for (let p = 0; p < 8; p++) this.conc[i * 8 + p] = (this.conc[i * 8 + p] * vol + this.CR[p] * flow) / Math.max(1e-6, nv);
          this.wet[i] = nv / this.tcap;
          this.R -= flow;
        } else if (d < 0) {
          const flow = -d * kf * 0.25 * this.tcap;
          const nr = this.R + flow;
          for (let p = 0; p < 8; p++) this.CR[p] = (this.CR[p] * this.R + this.conc[i * 8 + p] * flow) / Math.max(1e-6, nr);
          this.R = Math.min(this.Rcap, nr);
          this.wet[i] -= flow / this.tcap;
        }
      }
    }

    // ------------------------------------------------------------ drawing
    // Oblique view of the head: hair, ferrule and the start of the handle.
    draw(ctx, v) {
      const s = v.scale, ox = v.ox, oy = v.oy, ny = v.ny;
      const PX = (x, z) => ox + (x + z * 0.38) * s;
      const PY = (y, z) => oy + (ny - y - z * 0.6) * s;
      if (this.colorAge > 6) this._updateColors();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // each tuft drawn as a few loose hairs so the head reads as fibre
      const X = this.X, fN = this.fN;
      const hairW = Math.max(0.5, Math.min(1.3, this.rf * s * 0.45));
      const spreadPx = this.rf * 0.55;
      for (let h = -1; h <= 1; h++) {
        ctx.lineWidth = hairW * (h === 0 ? 1.25 : 0.85);
        for (let i = 0; i < this.N; i++) {
          const off = h * spreadPx * (0.6 + 0.8 * this.tseed[i]);
          const ox2 = fN[0] * off, oy2 = fN[1] * off;
          ctx.strokeStyle = this.colors[i];
          ctx.globalAlpha = h === 0 ? 0.95 : 0.6;
          ctx.beginPath();
          ctx.moveTo(PX(this.X0[i * 3] + ox2, this.X0[i * 3 + 2]), PY(this.X0[i * 3 + 1] + oy2, this.X0[i * 3 + 2]));
          for (let j = 0; j < M; j++) {
            const q = (i * M + j) * 3;
            const f = (j + 1) / M;
            ctx.lineTo(PX(X[q] + ox2 * (1 - 0.5 * f), X[q + 2]), PY(X[q + 1] + oy2 * (1 - 0.5 * f), X[q + 2]));
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // ferrule and handle, running back up the brush axis
      const [hx, hy, hz] = this.handle;
      const [ax, ay, az] = this.axis;
      const fl = Math.max(this.Wc * 1.6, this.L * 0.45);
      const tx = hx - ax * fl, ty = hy - ay * fl, tz = hz - az * fl;
      const x0 = PX(hx, hz), y0 = PY(hy, hz), x1 = PX(tx, tz), y1 = PY(ty, tz);
      const fw = Math.max(3, 2.1 * Math.max(this.Wc, this.Hc) * s);
      const g = ctx.createLinearGradient(x0 - fw, y0, x0 + fw, y0);
      g.addColorStop(0, 'rgba(120,124,128,0.95)');
      g.addColorStop(0.45, 'rgba(236,238,240,0.95)');
      g.addColorStop(1, 'rgba(96,100,106,0.95)');
      ctx.strokeStyle = g;
      ctx.lineWidth = fw;
      ctx.lineCap = this.T.section === 'flat' ? 'butt' : 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const hl = this.L * 2.4;
      const ex = PX(tx - ax * hl, tz - az * hl), ey = PY(ty - ay * hl, tz - az * hl);
      const hg = ctx.createLinearGradient(x1, y1, ex, ey);
      hg.addColorStop(0, 'rgba(46,34,28,0.9)');
      hg.addColorStop(1, 'rgba(46,34,28,0)');
      ctx.strokeStyle = hg;
      ctx.lineCap = 'round';
      ctx.lineWidth = fw * 0.85;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
    }

    _updateColors() {
      const [hr, hg, hb] = this.T.hair;
      const c = new Float32Array(8);
      for (let i = 0; i < this.N; i++) {
        const w = this.wet[i];
        let sum = 0;
        for (let p = 0; p < 8; p++) { c[p] = this.conc[i * 8 + p] * 0.3; sum += this.conc[i * 8 + p]; }
        const dark = 1 - 0.38 * w;
        let r = hr * dark, g = hg * dark, b = hb * dark;
        const amt = clamp(sum * 0.18, 0, 0.92) * (0.4 + 0.6 * w);
        if (amt > 0.01) {
          const pc = reflectRGB(c);
          r = mix(r, pc[0], amt); g = mix(g, pc[1], amt); b = mix(b, pc[2], amt);
        }
        this.colors[i] = `rgb(${r | 0},${g | 0},${b | 0})`;
      }
      this.colorAge = 0;
    }
  }

  window.BristleBrush = BristleBrush;
})();
