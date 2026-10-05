// The drawing tool seen from above: a black lacquered pencil (or the eraser,
// or a paper stump) held in a right hand, its point on the sheet and its
// body rising toward the hand. Drawn in perspective from a camera over the
// middle of the sheet, so the raised end reads larger, with a soft shadow
// cast by a light from the upper left. Pose (sim cells, mm, radians):
//   { x, y, z (mm above the paper at the point), azim (screen angle of the
//     body's run away from the point), tool, side, eraser, eraserSize, wear }
(function () {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const CAMERA_MM = 520;            // the camera's height over the sheet
  const LIGHT = [0.42, 0.52];       // shadow shift per mm of height (down-right)

  // the parts along the axis, from the point: [from mm, to mm, diameter at
  // from, at to, paint]
  function parts(p) {
    if (p.tool === 'paintbrush') {
      // hair (in the paint it carries), a crimped nickel ferrule and a long
      // lacquered handle that swells and tapers toward its end
      const hl = clamp(p.hairLen || 14, 4, 60), hw = clamp(p.hairW || 5, 0.6, 40);
      const tip = p.flat ? hw * 0.92 : hw * 0.3, fd = clamp(hw * 1.04 + 0.8, 4.2, 16), fe = Math.max(5.4, fd * 0.78);
      return [[0, hl, tip, hw, 'hair'], [hl, hl + 17, fd, fe, 'nickel'], [hl + 17, hl + 72, fe, 7.4, 'handle'], [hl + 72, hl + 205, 7.4, 3.8, 'handle']];
    }
    if (p.tool === 'eraser' && p.eraser === 'kneaded') return null;
    if (p.tool === 'eraser') {
      const d = clamp(p.eraserSize || 4, 2.2, 7.5);
      return [[0, 9, d, d, 'rubber'], [9, 12.5, d + 0.8, d + 0.8, 'metal'], [12.5, 118, 8.6, 8.6, 'barrel'], [118, 124, 8.6, 8.0, 'barrel']];
    }
    if (p.tool === 'stump') return [[0, 24, 0.9, 7.2, 'stumpTip'], [24, 125, 7.2, 7.2, 'stump']];
    const r = clamp((p.sharp || 0.3) + (p.wear || 0), 0.1, 1.2);
    return [[0, 4.2, 2 * r, 2.1, 'lead'], [4.2, 19, 2.1, 7.0, 'wood'], [19, 150, 7.0, 7.0, 'lacquer'], [150, 158.5, 7.3, 7.3, 'ferrule'], [158.5, 165, 6.6, 6.6, 'rubberPink']];
  }

  // paint across the width: stops from the lit edge to the shaded one
  const PAINT = {
    lead: [[0, '#2a2b2f'], [0.3, '#8d8f96'], [0.42, '#55575d'], [1, '#1d1e21']],
    wood: [[0, '#f1dfbd'], [0.35, '#e2c595'], [0.8, '#c39a63'], [1, '#9c7646']],
    lacquer: [[0, '#2f3036'], [0.07, '#4b4d55'], [0.16, '#1b1c20'], [0.17, '#121316'], [0.45, '#0d0e10'], [0.5, '#17181b'], [0.51, '#0a0a0c'], [0.83, '#08080a'], [0.84, '#030304'], [1, '#000']],
    barrel: [[0, '#3a3b41'], [0.12, '#55575f'], [0.3, '#16171a'], [0.7, '#0a0a0c'], [1, '#000']],
    ferrule: [[0, '#f4f5f7'], [0.25, '#c9ccd2'], [0.55, '#8e9198'], [0.8, '#61646a'], [1, '#3e4045']],
    metal: [[0, '#f4f5f7'], [0.3, '#bfc2c8'], [0.7, '#6d7076'], [1, '#43454a']],
    rubber: [[0, '#ffffff'], [0.4, '#efede6'], [1, '#bdbab1']],
    rubberPink: [[0, '#f6c3c9'], [0.4, '#e598a3'], [1, '#b46672']],
    stumpTip: [[0, '#d4d2cc'], [0.5, '#a9a7a2'], [1, '#7a7974']],
    stump: [[0, '#f1eee6'], [0.45, '#dcd8ce'], [1, '#a9a59b']],
    nickel: [[0, '#f6f7f9'], [0.22, '#d5d8dd'], [0.5, '#9ea2a9'], [0.78, '#6c7077'], [1, '#44474c']],
    handle: [[0, '#c0564a'], [0.1, '#9e3429'], [0.3, '#7c1e17'], [0.6, '#5d130e'], [0.86, '#3d0a07'], [1, '#230403']],
    hair: [[0, '#d8c39a'], [0.5, '#b89a68'], [1, '#7d6440']],
  };

  function draw(ctx, p, v) {
    if (!p || p.x == null) return;
    const s = v.scale, k = s * v.cellsPerMM;                 // px per cell, px per mm
    const C = [v.ox + (v.nx * s) / 2, v.oy + (v.ny * s) / 2];
    const T = [v.ox + p.x * s, v.oy + (v.ny - p.y) * s];      // the point, on the sheet
    const z = Math.max(0, p.z || 0);
    const a = [Math.cos(p.azim), Math.sin(p.azim)];
    const el = p.tool === 'paintbrush' ? 0.86 : p.tool === 'eraser' ? 1.08 : p.tool === 'stump' ? 0.72 : 0.96 - 0.55 * (p.side || 0);
    const ce = Math.cos(el), se = Math.sin(el);
    // a point t mm up the axis: on screen (perspective), its height, its scale
    const at = (t) => {
      const h = z + t * se, m = CAMERA_MM / (CAMERA_MM - Math.min(h, CAMERA_MM * 0.8));
      const px = T[0] + a[0] * t * ce * k, py = T[1] + a[1] * t * ce * k;
      return { x: C[0] + (px - C[0]) * m, y: C[1] + (py - C[1]) * m, h, m, px, py };
    };
    const P = parts(p);
    const L = P ? P[P.length - 1][1] : 0;
    ctx.save();
    ctx.lineJoin = 'round';
    // the shadow on the paper: sharp near the point, fading and spreading up the body
    {
      const sh = (t) => { const q = at(t); return [q.px + q.h * LIGHT[0] * k, q.py + q.h * LIGHT[1] * k, q.h]; };
      const steps = P ? [0, 6, 20, 45, 80, 120, L] : [0];
      ctx.save();
      for (let i = 0; i + 1 < steps.length; i++) {
        const A = sh(steps[i]), B = sh(steps[i + 1]);
        const wA = (P ? diamAt(P, steps[i]) : 10) * 0.5 * k, wB = (P ? diamAt(P, steps[i + 1]) : 10) * 0.5 * k;
        const blur = 1 + 0.06 * k * (A[2] + B[2]) * 0.5;
        ctx.filter = `blur(${blur.toFixed(1)}px)`;
        ctx.globalAlpha = clamp(0.34 * Math.exp(-((A[2] + B[2]) * 0.5) / 70), 0.05, 0.34);
        ctx.fillStyle = '#2a2622';
        quad(ctx, [A[0], A[1]], [B[0], B[1]], wA * 1.05, wB * 1.15);
        ctx.fill();
      }
      ctx.restore();
    }
    if (!P) {   // a kneaded eraser: a pinched lump of putty
      const q = at(0), r = (p.eraserSize ? clamp(p.eraserSize, 6, 16) : 11) * 0.5 * k * q.m;
      const g = ctx.createRadialGradient(q.x - r * 0.35, q.y - r * 0.4, r * 0.1, q.x, q.y, r * 1.2);
      g.addColorStop(0, '#c9c7c2'); g.addColorStop(0.6, '#8f8d88'); g.addColorStop(1, '#5d5b57');
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const t = (i / 24) * Math.PI * 2, rr = r * (1 + 0.12 * Math.sin(3 * t + 1) + 0.07 * Math.sin(5 * t));
        const X = q.x + Math.cos(t) * rr * 1.25, Y = q.y + Math.sin(t) * rr * 0.9 - r * 0.5;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
      return;
    }
    // which side of the body faces the light (upper left on screen)
    const n0 = [-a[1], a[0]];
    const litSide = n0[0] * -0.6 + n0[1] * -0.8 > 0 ? 1 : -1;
    // from the point outward: each part's near end is the top half of its
    // cross-section (an ellipse, bulging toward the point), laid over the
    // part before it; the lacquer ends on the cone in six scalloped arcs
    for (let i = 0; i < P.length; i++) {
      const [t0, t1, d0, d1, paint] = P[i];
      const A = at(t0), B = at(t1);
      const w0 = 0.5 * d0 * k * A.m, w1 = 0.5 * d1 * k * B.m;
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      const n = [(-dy / len) * litSide, (dx / len) * litSide], u = [dx / len, dy / len];
      const g = ctx.createLinearGradient(A.x + n[0] * Math.max(w0, w1), A.y + n[1] * Math.max(w0, w1), A.x - n[0] * Math.max(w0, w1), A.y - n[1] * Math.max(w0, w1));
      for (const [o, c] of (paint === 'hair' && p.hairStops ? p.hairStops : PAINT[paint])) g.addColorStop(o, c);
      ctx.fillStyle = g;
      ctx.beginPath();
      const sc = paint === 'lacquer' ? 1.3 * ce * k * A.m : 0;
      for (let j = 0; j <= 30; j++) {
        const f = Math.PI / 2 - (j / 30) * Math.PI;
        const along = w0 * se * Math.cos(f) + (sc ? sc * Math.pow(Math.abs(Math.cos(3 * f + 0.4)), 0.6) : 0);
        const X = A.x + n[0] * w0 * Math.sin(f) - u[0] * along, Y = A.y + n[1] * w0 * Math.sin(f) - u[1] * along;
        j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      ctx.lineTo(B.x - n[0] * w1, B.y - n[1] * w1);
      ctx.lineTo(B.x + n[0] * w1, B.y + n[1] * w1);
      ctx.closePath();
      ctx.fill();
      if (paint === 'wood') {
        // the sharpener's cut: faint planes running down the cone
        ctx.strokeStyle = 'rgba(120,84,44,0.22)';
        ctx.lineWidth = Math.max(0.5, 0.05 * k);
        for (const f of [-0.55, -0.15, 0.3, 0.7]) {
          ctx.beginPath();
          ctx.moveTo(A.x + n[0] * w0 * f, A.y + n[1] * w0 * f);
          ctx.lineTo(B.x + n[0] * w1 * f * 0.96, B.y + n[1] * w1 * f * 0.96);
          ctx.stroke();
        }
      }
      if (paint === 'ferrule') ring(ctx, at, t0, t1, d0, k, n, u, se, [0.28, 0.4, 0.72], 'rgba(40,42,46,0.55)');
      if (paint === 'stump') {
        // the paper spiral it is rolled from
        ctx.strokeStyle = 'rgba(110,104,94,0.35)';
        ctx.lineWidth = Math.max(0.5, 0.08 * k);
        for (let t = t0 + 6; t < t1; t += 14) {
          const q0 = at(t), q1 = at(t + 6), w = 0.5 * d0 * k * q0.m;
          ctx.beginPath();
          ctx.moveTo(q0.x + n[0] * w, q0.y + n[1] * w);
          ctx.lineTo(q1.x - n[0] * w, q1.y - n[1] * w);
          ctx.stroke();
        }
      }
      if (i === P.length - 1) {
        // the far end faces up: the whole ellipse shows
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(B.x, B.y, w1, Math.max(0.5, w1 * se), Math.atan2(n[1], n[0]), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // a glint along the lit facet of the lacquer
    {
      const [t0, t1] = P.find((q) => q[4] === 'lacquer' || q[4] === 'barrel' || q[4] === 'handle');
      const A = at(t0 + 3), B = at(t1 - 2), w = 0.5 * 7 * k;
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      const n = [(-dy / len) * litSide, (dx / len) * litSide];
      const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.25, 'rgba(255,255,255,0.22)'); g.addColorStop(0.7, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(0.6, 0.35 * k);
      ctx.beginPath();
      ctx.moveTo(A.x + n[0] * w * 0.62 * A.m, A.y + n[1] * w * 0.62 * A.m);
      ctx.lineTo(B.x + n[0] * w * 0.62 * B.m, B.y + n[1] * w * 0.62 * B.m);
      ctx.stroke();
    }
    ctx.restore();
  }

  function diamAt(P, t) {
    for (const [t0, t1, d0, d1] of P) if (t >= t0 && t <= t1) return d0 + ((d1 - d0) * (t - t0)) / Math.max(1e-6, t1 - t0);
    return P[P.length - 1][3];
  }
  function quad(ctx, A, B, wA, wB) {
    const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy) || 1, n = [-dy / len, dx / len];
    ctx.beginPath();
    ctx.moveTo(A[0] + n[0] * wA, A[1] + n[1] * wA);
    ctx.lineTo(B[0] + n[0] * wB, B[1] + n[1] * wB);
    ctx.lineTo(B[0] - n[0] * wB, B[1] - n[1] * wB);
    ctx.lineTo(A[0] - n[0] * wA, A[1] - n[1] * wA);
    ctx.closePath();
  }
  // lines round the body (a crimped ferrule): the top half of each section
  function ring(ctx, at, t0, t1, d, k, n, u, se, fs, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, 0.12 * k);
    for (const fr of fs) {
      const q = at(t0 + (t1 - t0) * fr), w = 0.5 * d * k * q.m;
      ctx.beginPath();
      for (let j = 0; j <= 16; j++) {
        const f = Math.PI / 2 - (j / 16) * Math.PI;
        const X = q.x + n[0] * w * Math.sin(f) - u[0] * w * se * Math.cos(f), Y = q.y + n[1] * w * Math.sin(f) - u[1] * w * se * Math.cos(f);
        j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      ctx.stroke();
    }
  }

  window.PencilView = { draw };
})();
