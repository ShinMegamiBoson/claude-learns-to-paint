// WebGL2 host for the watercolor simulation: textures, passes, brush
// input, undo snapshots, and the sleep/wake logic that stops simulating
// once the sheet is dry.
(function () {
  'use strict';

  const SH = window.WC_SHADERS;
  const LIB = window.WC_PIGMENTS;

  const STAMP_FLOATS = 24;
  const GATHER_MAX = 128;
  const UNDO_LEVELS = 6;

  // Watercolor papers (sized rag) and xuan rice papers for ink. Raw xuan
  // is unsized: water soaks in at once and creeps out along the fibres, so
  // ink bleeds into feathered halos. Sizing (alum and glue) progressively
  // stops that until sized xuan behaves much like hot-pressed paper.
  const PAPER_TYPES = { hot: 0, cold: 1, rough: 2, xuan: 3, xuanHalf: 3, xuanSized: 3, bristol: 4, drawing: 5, toothy: 6, board: 7, canvas: 8 };
  const PAPER_AMP = { hot: 0.01, cold: 0.028, rough: 0.05, xuan: 0.006, xuanHalf: 0.006, xuanSized: 0.006, bristol: 0.004, drawing: 0.01, toothy: 0.018, board: 0.004, canvas: 0.02 };
  const PAPER_RELIEF = { hot: 0.08, cold: 0.12, rough: 0.16, xuan: 0.05, xuanHalf: 0.05, xuanSized: 0.05, bristol: 0.03, drawing: 0.06, toothy: 0.1, board: 0.03, canvas: 0.16 };
  // absorb/pin/cap/capDiff scale the base physics; wickDry is how readily
  // water creeps into dry fibres unaided; strand is how much ink the fibres
  // filter out of water as it soaks in (low = ink keeps travelling with it).
  const SIZED = { absorb: 1, pin: 1, wickDry: 0, cap: 1, capDiff: 1, capT: 1, strand: 1, filter: 0, fines: 0, pulp: 1 };
  const PAPER_PHYS = {
    hot: SIZED, cold: SIZED, rough: SIZED, bristol: SIZED, drawing: SIZED, toothy: SIZED, board: SIZED, canvas: SIZED,
    xuan: { absorb: 3, pin: 0.3, wickDry: 0.38, cap: 1.6, capDiff: 2.2, capT: 0.7, strand: 0.3, filter: 0.09, fines: 0.2, pulp: 2.4 },
    xuanHalf: { absorb: 2, pin: 0.5, wickDry: 0.14, cap: 1.3, capDiff: 1.6, capT: 0.8, strand: 0.6, filter: 0.035, fines: 0.15, pulp: 2.4 },
    xuanSized: { absorb: 1.2, pin: 0.9, wickDry: 0, cap: 1.1, capDiff: 1.1, capT: 1, strand: 1, filter: 0, fines: 0, pulp: 2.4 },
  };
  // [tooth, edge noise] strength relative to cold press
  const PAPER_GRAIN = { hot: [0.35, 0.55], cold: [1, 1], rough: [1.25, 1.2], xuan: [0.3, 0.9], xuanHalf: [0.3, 0.8], xuanSized: [0.3, 0.6], bristol: [0.55, 0.5], drawing: [1, 0.8], toothy: [1.3, 1], board: [0.6, 0.5], canvas: [1.2, 0.8] };

  const DEFAULTS = {
    flowK: 0.14,
    damp: 0.86,
    mobW: 0.028,
    pinT: 0.11,
    wetEps: 1e-4,
    cap: 0.1,
    absorb: 0.00035,
    evap: 2.4e-5,
    edgeEvap: 0.9,
    evapCap: 1.1e-5,
    capDiff: 0.11,
    capT: 0.035,
    saltRate: 0.05,
    setRate: 0.012,
    loosen: 0.0006,
    dryS: 0.006,
    depRate: 0.06,
    depThin: 0.05,
    liftRate: 0.00085,
    strand: 0.85,
    shear: 120,
    pigDiff: 0.08,
    marangoni: 0.014,
    visc: 0.035,
    wick: 0.16,
    brushK: 1.6,
    mix: 0.3,
    drag: 0.12,
    granDisp: 0.16,
    hair: 0.65,            // a drying tuft keeps ink along its hairs (streaks) rather than only on paper peaks (dots)
    paintOpen: 45,         // gouache: seconds a fresh film of average thickness stays workable at 55% RH
    paintLevel: 0.12,      // gouache: how readily very wet paint levels into its neighbours
    paintMix: 0.35,        // gouache: how quickly a loaded brush stirs its colour into wet paint
    impasto: 2.0,          // gouache: how strongly the paint's thickness catches the light
    paintHair: 0.35,       // gouache: how unevenly a tuft lays its film along its hairs
    paintEdge: 0.72,       // gouache: where a tuft's footprint starts to soften (1 = hard edge)
    furrow: 0.42,          // gouache display: depth of the bristle furrows in the paint
    grain: 0.04,           // gouache display: the matte grain of dried paint
    warp: 0.7,             // gouache display: how far stroke edges wander off the simulation grid (cells)
    stepsPerSecond: 240,
    sliceDeposits: true,   // false lays each frame's paint down in one batch (for comparison)
  };

  class EngineError extends Error {
    constructor(kind, msg) { super(msg || kind); this.kind = kind; }
  }

  function numbered(src) {
    return src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' ' + l).join('\n');
  }

  class Program {
    constructor(gl, vs, fs, label) {
      this.gl = gl;
      const p = gl.createProgram();
      gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs, label + '.vs'));
      gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs, label + '.fs'));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new EngineError('shader', label + ' link: ' + gl.getProgramInfoLog(p));
      }
      this.p = p;
      this.u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        this.u[info.name.replace(/\[0\]$/, '')] = {
          loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size,
        };
      }
    }
    _compile(type, src, label) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        console.error(label + '\n' + log + '\n' + numbered(src));
        throw new EngineError('shader', label + ': ' + log);
      }
      return sh;
    }
    use(uniforms) {
      const gl = this.gl;
      gl.useProgram(this.p);
      let unit = 0;
      for (const k in uniforms) {
        const u = this.u[k];
        if (!u) continue;
        const v = uniforms[k];
        switch (u.type) {
          case gl.SAMPLER_2D:
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, v);
            gl.uniform1i(u.loc, unit++);
            break;
          case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
          case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
          case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
        }
      }
    }
  }

  class WatercolorEngine {
    constructor(canvas, opts) {
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) throw new EngineError('webgl2');
      if (!gl.getExtension('EXT_color_buffer_float')) throw new EngineError('float');
      gl.getExtension('EXT_float_blend');
      this.gl = gl;
      this.canvas = canvas;
      this.nx = opts.nx;
      this.ny = opts.ny;
      this.sheetMM = opts.sheetMM;
      this.paperType = opts.paperType || 'cold';
      this.medium = opts.medium || 'watercolor';
      this.P = Object.assign({}, DEFAULTS);
      this.tilt = [0, 0];
      this.evapMul = 1;
      this.exposure = 1;

      this._texId = 0;
      this._fbos = new Map();
      this.stamps = new Float32Array(STAMP_FLOATS * 512);
      this.stampT = new Float64Array(512);
      this.stampCount = 0;
      this.undoStack = [];
      this.undoFree = [];

      this.awake = false;
      this.dirty = true;
      this.status = { wet: 0, damp: 0, maxW: 0, maxS: 0 };
      this._dryReadings = 0;
      this._framesSinceProbe = 0;
      this._probe = null;
      this._simAccum = 0;

      this._initGeometry();
      this._initPrograms();
      this._initTextures();
      this._initPigmentUniforms();
      this.generatePaper();
      this.clear();
    }

    // ------------------------------------------------------------ setup
    _initGeometry() {
      const gl = this.gl;
      this.triVAO = gl.createVertexArray();
      gl.bindVertexArray(this.triVAO);
      const tb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, tb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      this.stampVAO = gl.createVertexArray();
      gl.bindVertexArray(this.stampVAO);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.stamps.byteLength, gl.DYNAMIC_DRAW);
      for (let i = 0; i < 6; i++) {
        gl.enableVertexAttribArray(1 + i);
        gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STAMP_FLOATS * 4, i * 16);
        gl.vertexAttribDivisor(1 + i, 1);
      }
      this.gatherVAO = gl.createVertexArray();
      gl.bindVertexArray(this.gatherVAO);
      this.gatherBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gatherBuf);
      gl.bufferData(gl.ARRAY_BUFFER, GATHER_MAX * 8, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    _initPrograms() {
      const gl = this.gl;
      const mk = (fs, label, vs) => new Program(gl, vs || SH.VS_TRI, fs, label);
      this.pPaperRaw = mk(SH.FS_PAPER_RAW, 'paperRaw');
      this.pPaperNorm = mk(SH.FS_PAPER_NORM, 'paperNorm');
      this.pFibre = mk(SH.FS_FIBRE, 'fibre');
      this.pPaperHi1 = mk(SH.FS_PAPER_HI1, 'paperHi1');
      this.pPaperHi2 = mk(SH.FS_PAPER_HI2, 'paperHi2');
      this.pFlux = mk(SH.FS_FLUX, 'flux');
      this.pWater = mk(SH.FS_WATER, 'water');
      this.hasFines = gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 5;
      this.pPigment = mk(this.hasFines ? SH.FS_PIGMENT.replace('precision highp sampler2D;\n', 'precision highp sampler2D;\n#define FINES 1\n') : SH.FS_PIGMENT, 'pigment');
      this.pStamp = mk(SH.FS_STAMP, 'stamp', SH.VS_STAMP);
      this.pPencil = mk(SH.FS_PENCIL, 'pencil', SH.VS_STAMP);
      this.pPencilApply = mk(SH.FS_PENCIL_APPLY, 'pencilApply');
      this.pPaintApply = mk(SH.FS_PAINT_APPLY, 'paintApply');
      this.pPaintStep = mk(this.hasFines ? SH.FS_PAINT_STEP.replace('precision highp sampler2D;\n', 'precision highp sampler2D;\n#define BRUSHWORK 1\n') : SH.FS_PAINT_STEP, 'paintStep');
      this.pPaintComposite = mk(SH.FS_PAINT_COMPOSITE, 'paintComposite');
      this.pPaintDisplay = mk(SH.FS_PAINT_DISPLAY, 'paintDisplay');
      this.pApply = mk(SH.FS_APPLY, 'apply');
      this.pCopy = mk(SH.FS_COPY, 'copy');
      this.pFinalize = mk(SH.FS_FINALIZE, 'finalize');
      this.pReduce = mk(SH.FS_REDUCE, 'reduce');
      this.pComposite = mk(SH.FS_COMPOSITE, 'composite');
      this.pDisplay = mk(SH.FS_DISPLAY, 'display');
      this.pGather = mk(SH.FS_GATHER, 'gather', SH.VS_GATHER);
    }

    _tex(w, h, fmt, linear) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt === 'f32' ? gl.RGBA32F : gl.RGBA16F, w, h);
      const f = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t._id = ++this._texId;
      t.w = w; t.h = h;
      return t;
    }

    _pair(fmt) {
      const pr = { r: this._tex(this.nx, this.ny, fmt), w: this._tex(this.nx, this.ny, fmt) };
      pr.swap = () => { const t = pr.r; pr.r = pr.w; pr.w = t; };
      return pr;
    }

    _initTextures() {
      const { nx, ny } = this;
      this.W = this._pair('f32');
      this.F = this._pair('f32');
      this.G0 = this._pair('f32');
      this.G1 = this._pair('f32');
      this.D0 = this._pair('f32');
      this.D1 = this._pair('f32');
      this.FN = this._pair('f32');
      this.paper = this._tex(nx, ny, 'f32');
      this.paperRaw = this._tex(nx, ny, 'f32');
      this.fibre = this._tex(nx, ny, 'f16');
      this._norms = {};
      this.acc = [0, 1, 2, 3].map(() => this._tex(nx, ny, 'f16'));
      this.comp = [0, 1, 2].map(() => this._tex(nx, ny, 'f16', true));
      const rw = Math.ceil(nx / 8), rh = Math.ceil(ny / 8);
      this.red1 = this._tex(rw, rh, 'f32');
      this.red2 = this._tex(Math.ceil(rw / 8), Math.ceil(rh / 8), 'f32');
      this.paperHiA = null;
      this.paperHi = null;

      const gl = this.gl;
      this.probeBuf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.red2.w * this.red2.h * 16, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.probeData = new Float32Array(this.red2.w * this.red2.h * 4);

      this.gatherTex = [0, 1, 2].map(() => this._tex(GATHER_MAX, 1, 'f32'));
      this.gatherPBO = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.gatherPBO);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, GATHER_MAX * 16 * 3, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._gatherData = new Float32Array(GATHER_MAX * 12);
      this.brushSamples = {
        valid: false, version: -1,
        w: new Float32Array(GATHER_MAX * 4), g0: new Float32Array(GATHER_MAX * 4), g1: new Float32Array(GATHER_MAX * 4),
      };
      this._gatherFence = null;
    }

    // Switch the eight pigment slots to a palette ('watercolor' or 'ink').
    // Existing paint is reinterpreted, so callers start a new sheet first.
    setPalette(medium) {
      this.medium = medium;
      this._initPigmentUniforms();
      this.dirty = true;
    }

    _initPigmentUniforms() {
      const pal = LIB.medium === this.medium ? LIB.PIGMENTS : LIB.PALETTES[this.medium || 'watercolor'];
      this.paperColor = LIB.PAPER_LINEAR;
      const K = [], S = [], rho = [], om = [], gam = [], gran = [];
      for (const p of pal) {
        K.push(...p.K); S.push(...p.S);
        rho.push(p.rho); om.push(p.omega); gam.push(p.gamma); gran.push(p.gamma);
      }
      this.pigU = {
        uK: new Float32Array(K), uS: new Float32Array(S),
        uRho0: rho.slice(0, 4), uRho1: rho.slice(4, 8),
        uOmega0: om.slice(0, 4), uOmega1: om.slice(4, 8),
        uGam0: gam.slice(0, 4), uGam1: gam.slice(4, 8),
        uGran0: gran.slice(0, 4), uGran1: gran.slice(4, 8),
      };
    }

    _fbo(texs) {
      const key = texs.map((t) => t._id).join(',');
      let f = this._fbos.get(key);
      if (f) return f;
      const gl = this.gl;
      f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new EngineError('fbo', 'Framebuffer incomplete: 0x' + st.toString(16));
      this._fbos.set(key, f);
      return f;
    }

    _run(prog, uniforms, outs, w, h) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, outs ? this._fbo(outs) : null);
      gl.viewport(0, 0, w, h);
      prog.use(uniforms);
      gl.bindVertexArray(this.triVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _clear(texs) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo(texs));
      gl.viewport(0, 0, texs[0].w, texs[0].h);
      const z = new Float32Array(4);
      texs.forEach((_, i) => gl.clearBufferfv(gl.COLOR, i, z));
    }

    _dropFbosFor(tex) {
      for (const [k, f] of this._fbos) {
        if (k.split(',').includes(String(tex._id))) { this.gl.deleteFramebuffer(f); this._fbos.delete(k); }
      }
    }

    // ------------------------------------------------------------ paper
    generatePaper(type) {
      if (type) this.paperType = type;
      const t = PAPER_TYPES[this.paperType];
      const { nx, ny } = this;
      this._run(this.pPaperRaw, { uMM: this.sheetMM, uRes: [nx, ny], uType: t }, [this.paperRaw], nx, ny);
      let norm = this._norms[this.paperType];
      if (!norm) {
        const d = this.readTexture('paperRaw');
        const sum = [0, 0, 0, 0], sq = [0, 0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          for (let c = 0; c < 4; c++) { sum[c] += d[i + c]; sq[c] += d[i + c] * d[i + c]; }
        }
        const n = d.length / 4;
        const m = sum.map((v) => v / n);
        const sd = sq.map((v, c) => Math.sqrt(Math.max(1e-10, v / n - m[c] * m[c])));
        norm = this._norms[this.paperType] = { n0: [m[0], sd[0], m[3], sd[3]], n1: [m[1], sd[1], m[2], sd[2]] };
      }
      this.norm = norm;
      this._run(this.pPaperNorm, { uSrc: this.paperRaw, uNorm0: norm.n0, uNorm1: norm.n1, uGrain: PAPER_GRAIN[this.paperType] }, [this.paper], nx, ny);
      const family = this.paperType.startsWith('xuan') ? 'xuan' : 'rag';
      if (this._fibreFamily !== family) {
        const xuan = family === 'xuan';
        this._run(this.pFibre, { uSize: [nx, ny], uStretch: xuan ? [0.055, 0.9] : [0.085, 0.65], uContrast: xuan ? 0.35 : 0 }, [this.fibre], nx, ny);
        this._fibreFamily = family;
      }
      if (this.canvas.width > 0) this._genPaperHi();
      this.dirty = true;
    }

    _genPaperHi() {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.paperHi || this.paperHi.w !== w || this.paperHi.h !== h) {
        const gl = this.gl;
        if (this.paperHi) {
          this._dropFbosFor(this.paperHi); this._dropFbosFor(this.paperHiA);
          gl.deleteTexture(this.paperHi); gl.deleteTexture(this.paperHiA);
        }
        this.paperHiA = this._tex(w, h, 'f32');
        this.paperHi = this._tex(w, h, 'f16', true);
      }
      const t = PAPER_TYPES[this.paperType];
      this._run(this.pPaperHi1, { uMM: this.sheetMM, uRes: [w, h], uType: t }, [this.paperHiA], w, h);
      this._run(this.pPaperHi2, { uSrc: this.paperHiA, uRes: [w, h], uMM: this.sheetMM, uNorm0: this.norm.n0, uGrain: PAPER_GRAIN[this.paperType] }, [this.paperHi], w, h);
    }

    resizeDisplay(w, h) {
      if (this.canvas.width === w && this.canvas.height === h && this.paperHi) return;
      this.canvas.width = w;
      this.canvas.height = h;
      this._genPaperHi();
      this.dirty = true;
    }

    clear() {
      const pairs = [this.W, this.F, this.G0, this.G1, this.D0, this.D1, this.FN];
      for (const p of pairs) this._clear([p.r, p.w]);
      this.stampCount = 0;
      this.awake = false;
      this.dirty = true;
      this.status = { wet: 0, damp: 0, maxW: 0, maxS: 0 };
    }

    // ------------------------------------------------------------ brush input
    // s: { x, y, r, angle, target, strength, contact, seed, conc[8], vx, vy, thirst, dryness, salt, shape }
    addStamp(s) {
      if ((this.stampCount + 1) * STAMP_FLOATS > this.stamps.length) this._growStamps();
      const a = this.stamps, o = this.stampCount * STAMP_FLOATS;
      this.stampT[this.stampCount] = this._lastT = s.t == null ? (this._lastT || 0) : s.t;
      a[o] = s.x; a[o + 1] = s.y; a[o + 2] = s.r; a[o + 3] = s.angle || 0;
      a[o + 4] = s.target || 0; a[o + 5] = s.strength || 0; a[o + 6] = s.contact == null ? 1 : s.contact; a[o + 7] = s.seed || 0;
      const c = s.conc;
      for (let i = 0; i < 8; i++) a[o + 8 + i] = c ? c[i] : 0;
      a[o + 16] = s.vx || 0; a[o + 17] = s.vy || 0; a[o + 18] = s.thirst || 0; a[o + 19] = s.dryness || 0;
      a[o + 20] = s.salt || 0; a[o + 21] = s.shape || 0; a[o + 22] = s.x1 || 0; a[o + 23] = s.y1 || 0;
      this.stampCount++;
    }

    // Characters for the seal, drawn to a canvas (white = cut away).
    setSealMask(canvas) {
      const gl = this.gl;
      if (!this.sealTex) {
        this.sealTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.sealTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.sealTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      this.sealGlyph = 1;
    }

    // Fast path for bristle contacts (no object per call).
    // a tuft on the paper: a capsule from (x0, y0) radius r to (x1, y1) radius r1 (default r)
    capsule(x0, y0, x1, y1, r, target, strength, contact, seed, conc, vx, vy, thirst, t, clump, r1) {
      if ((this.stampCount + 1) * STAMP_FLOATS > this.stamps.length) this._growStamps();
      const a = this.stamps, o = this.stampCount * STAMP_FLOATS;
      this.stampT[this.stampCount] = this._lastT = t == null ? (this._lastT || 0) : t;
      a[o] = x0; a[o + 1] = y0; a[o + 2] = r; a[o + 3] = r1 == null ? r : r1;
      a[o + 4] = target; a[o + 5] = strength; a[o + 6] = contact; a[o + 7] = seed;
      for (let i = 0; i < 8; i++) a[o + 8 + i] = conc[i];
      a[o + 16] = vx; a[o + 17] = vy; a[o + 18] = thirst; a[o + 19] = clump || 0;
      a[o + 20] = 0; a[o + 21] = 4; a[o + 22] = x1; a[o + 23] = y1;
      this.stampCount++;
    }

    get stepsPerSecond() { return this.P.stepsPerSecond; }
    get paint() { return this.medium === 'gouache'; }

    _growStamps() {
      const n = new Float32Array(this.stamps.length * 2);
      n.set(this.stamps);
      this.stamps = n;
      const t = new Float64Array(this.stampT.length * 2);
      t.set(this.stampT);
      this.stampT = t;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.stamps.byteLength, gl.DYNAMIC_DRAW);
    }

    // Ask for the paper state under n points (sim cells, xy pairs). Results
    // arrive a frame or two later in this.brushSamples, tagged with version.
    requestBrushSamples(pts, n, version, sync) {
      const gl = this.gl;
      if (sync && n) {
        // blocking path, for stepping the simulation from a script
        this._gatherDraw(pts, Math.min(n, GATHER_MAX));
        const B = this.brushSamples, m = GATHER_MAX * 4;
        const tmp = new Float32Array(m);
        [B.w, B.g0, B.g1].forEach((arr, i) => {
          gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
          gl.readPixels(0, 0, GATHER_MAX, 1, gl.RGBA, gl.FLOAT, tmp);
          arr.set(tmp);
        });
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        B.version = version;
        B.valid = true;
        return;
      }
      if (this._gatherFence) {
        if (gl.getSyncParameter(this._gatherFence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.gatherPBO);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._gatherData);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(this._gatherFence);
        this._gatherFence = null;
        const B = this.brushSamples, d = this._gatherData, m = GATHER_MAX * 4;
        B.w.set(d.subarray(0, m));
        B.g0.set(d.subarray(m, 2 * m));
        B.g1.set(d.subarray(2 * m, 3 * m));
        B.version = this._gatherVersion;
        B.valid = true;
      }
      n = Math.min(n, GATHER_MAX);
      if (!n) return;
      this._gatherDraw(pts, n);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.gatherPBO);
      for (let i = 0; i < 3; i++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.readPixels(0, 0, GATHER_MAX, 1, gl.RGBA, gl.FLOAT, i * GATHER_MAX * 16);
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._gatherFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this._gatherVersion = version;
    }

    _gatherDraw(pts, n) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gatherBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pts, 0, n * 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo(this.gatherTex));
      gl.viewport(0, 0, GATHER_MAX, 1);
      this.pGather.use({ uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uSize: [this.nx, this.ny], uWidth: GATHER_MAX, uPaint: this.paint ? 1 : 0 });
      gl.bindVertexArray(this.gatherVAO);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindVertexArray(null);
    }

    // Splat stamps [start, start + count) into the accumulation targets and
    // fold them into the state.
    _applyStamps(start, count) {
      const gl = this.gl;
      this._clear(this.acc);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo(this.acc));
      gl.viewport(0, 0, this.nx, this.ny);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.pStamp.use({ uSize: [this.nx, this.ny], uPaper: this.paper, uSeal: this.sealTex || this.paper, uSealGlyph: this.sealGlyph || 0, uHair: this.P.hair, uPaintHair: this.paint ? this.P.paintHair : 0, uPaintEdge: this.P.paintEdge });
      gl.bindVertexArray(this.stampVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      for (let i = 0; i < 6; i++) {
        gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STAMP_FLOATS * 4, (start * STAMP_FLOATS + i * 4) * 4);
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);

      const P = this.P;
      if (this.paint) {
        this._run(this.pPaintApply, {
          uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uA0: this.acc[0], uA1: this.acc[1], uA2: this.acc[2], uA3: this.acc[3],
          uBrushK: P.brushK, uMix: P.paintMix,
        }, [this.W.w, this.G0.w, this.G1.w], this.nx, this.ny);
        this.W.swap(); this.G0.swap(); this.G1.swap();
        return;
      }
      this._run(this.pApply, {
        uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uFlux: this.F.r,
        uA0: this.acc[0], uA1: this.acc[1], uA2: this.acc[2], uA3: this.acc[3],
        uBrushK: P.brushK, uMix: P.mix, uDrag: P.drag,
      }, [this.W.w, this.G0.w, this.G1.w, this.F.w], this.nx, this.ny);
      this.W.swap(); this.G0.swap(); this.G1.swap(); this.F.swap();
    }

    // Split this frame's stamps into n consecutive time slices, one per
    // simulation step, so paint is laid down continuously while the water
    // moves instead of in one lump per rendered frame.
    _slices(n) {
      const T = this.stampT, c = this.stampCount;
      let t0 = Infinity, t1 = -Infinity;
      for (let i = 0; i < c; i++) { if (T[i] < t0) t0 = T[i]; if (T[i] > t1) t1 = T[i]; }
      const span = t1 - t0, out = [];
      let start = 0;
      for (let g = 0; g < n; g++) {
        let end = c;
        if (g < n - 1 && span > 0) {
          const edge = t0 + (span * (g + 1)) / n;
          end = start;
          while (end < c && T[end] <= edge) end++;
        }
        out.push([start, end]);
        start = end;
      }
      return out;
    }

    wake() {
      this.awake = true;
      this.dirty = true;
      this._dryReadings = 0;
    }

    // ------------------------------------------------------------ simulation
    _simStep() {
      if (this.paint) return this._paintStep();
      const P = this.P, size = [this.nx, this.ny], n = this.nx, m = this.ny;
      const amp = PAPER_AMP[this.paperType];
      const Q = PAPER_PHYS[this.paperType];
      const cap = P.cap * Q.cap;
      this._run(this.pFlux, {
        uW: this.W.r, uFlux: this.F.r, uPaper: this.paper, uG0: this.G0.r, uG1: this.G1.r, uFibre: this.fibre,
        uSize: size, uTilt: this.tilt,
        uPaperAmp: amp, uFlowK: P.flowK, uDamp: P.damp, uPinT: P.pinT * Q.pin, uMobW: P.mobW,
        uWetEps: P.wetEps, uCap: cap, uMarangoni: P.marangoni, uVisc: P.visc, uWick: P.wick, uWickDry: Q.wickDry,
      }, [this.F.w], n, m);
      this.F.swap();

      const ev = this.evapMul;
      this._run(this.pWater, {
        uW: this.W.r, uFlux: this.F.r, uPaper: this.paper, uSize: size,
        uWetEps: P.wetEps, uCap: cap, uAbsorb: P.absorb * Q.absorb, uEvap: P.evap * ev, uEdgeEvap: P.edgeEvap,
        uEvapCap: P.evapCap * ev, uCapDiff: P.capDiff * Q.capDiff, uCapT: P.capT * Q.capT, uSaltRate: P.saltRate,
        uSetRate: P.setRate, uLoosen: P.loosen, uDryS: P.dryS,
      }, [this.W.w], n, m);

      const pu = this.pigU;
      this._run(this.pPigment, {
        uW: this.W.r, uWn: this.W.w, uFlux: this.F.r, uG0: this.G0.r, uG1: this.G1.r,
        uD0: this.D0.r, uD1: this.D1.r, uPaper: this.paper, uFibre: this.fibre, uSize: size,
        uRho0: pu.uRho0, uRho1: pu.uRho1, uOmega0: pu.uOmega0, uOmega1: pu.uOmega1,
        uGam0: pu.uGam0, uGam1: pu.uGam1,
        uWetEps: P.wetEps, uDepRate: P.depRate, uDepThin: P.depThin, uLiftRate: P.liftRate,
        uShear: P.shear, uPigDiff: P.pigDiff, uSaltRate: P.saltRate, uStrand: P.strand * Q.strand, uFilter: Q.filter,
        uFN: this.FN.r, uFines: Q.fines, uCapDiff: P.capDiff * Q.capDiff, uCapT: P.capT * Q.capT,
        uEvapCap: P.evapCap * ev, uDryS: P.dryS,
      }, this.hasFines ? [this.G0.w, this.G1.w, this.D0.w, this.D1.w, this.FN.w] : [this.G0.w, this.G1.w, this.D0.w, this.D1.w], n, m);
      this.W.swap(); this.G0.swap(); this.G1.swap(); this.D0.swap(); this.D1.swap();
      if (this.hasFines) this.FN.swap();
    }

    // Gouache: drying (and a little levelling of very wet paint); dry paint
    // is folded into the ground.
    _paintStep() {
      const P = this.P, pu = this.pigU;
      this._run(this.pPaintStep, {
        uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uD0: this.D0.r, uD1: this.D1.r, uSize: [this.nx, this.ny],
        uDt: 1 / P.stepsPerSecond, uOpen: P.paintOpen / Math.max(0.05, this.evapMul), uLevel: P.paintLevel,
        uPaperColor: this.paperColor, uK: pu.uK, uS: pu.uS, uOpt: LIB.GOUACHE_OPTICAL,
      }, this.hasFines ? [this.W.w, this.G0.w, this.G1.w, this.D0.w, this.D1.w] : [this.W.w, this.G0.w, this.G1.w, this.D0.w], this.nx, this.ny);
      this.W.swap(); this.G0.swap(); this.G1.swap(); this.D0.swap();
      if (this.hasFines) this.D1.swap();
    }

    // Advance by dtMs of wall time. Returns the number of sim steps taken.
    update(dtMs) {
      this._simAccum += (dtMs / 1000) * this.P.stepsPerSecond;
      let steps = Math.floor(this._simAccum);
      this._simAccum -= steps;
      steps = Math.min(steps, 6);
      if (this.stampCount) this.wake();
      if (!this.awake) return 0;
      let slices = null;
      if (this.stampCount) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.stamps, 0, this.stampCount * STAMP_FLOATS);
        if (steps === 0 || !this.P.sliceDeposits) {
          this._applyStamps(0, this.stampCount);
        } else {
          slices = this._slices(steps);
        }
      }
      for (let i = 0; i < steps; i++) {
        if (slices) {
          const [a, b] = slices[i];
          if (b > a) this._applyStamps(a, b - a);
        }
        this._simStep();
      }
      this.stampCount = 0;
      this.dirty = true;
      this._probeActivity();
      return steps;
    }

    // Async read of a tiny reduction of W so we know when everything has
    // dried and the simulation can go to sleep.
    _probeActivity() {
      const gl = this.gl;
      if (this._probe) {
        const st = this._forceProbe ? gl.SIGNALED : gl.getSyncParameter(this._probe, gl.SYNC_STATUS);
        this._forceProbe = false;
        if (st !== gl.SIGNALED) return;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeData);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(this._probe);
        this._probe = null;
        const d = this.probeData;
        let maxW = 0, maxS = 0, wet = 0, damp = 0;
        for (let i = 0; i < d.length; i += 4) {
          maxW = Math.max(maxW, d[i]); maxS = Math.max(maxS, d[i + 1]);
          wet += d[i + 2]; damp += d[i + 3];
        }
        const cells = this.nx * this.ny;
        this.status = { wet: wet / cells, damp: damp / cells, maxW, maxS };
        if (maxW < this.P.wetEps && maxS < this.P.dryS) {
          if (++this._dryReadings >= 2 && !this.stampCount) this._sleep();
        } else {
          this._dryReadings = 0;
        }
        return;
      }
      if (++this._framesSinceProbe < 15) return;
      this._framesSinceProbe = 0;
      const P = this.P;
      this._run(this.pReduce, { uSrc: this.W.r, uSrcSize: [this.nx, this.ny], uMode: 0, uWetEps: P.wetEps, uDampT: P.cap * PAPER_PHYS[this.paperType].cap * 0.15 },
        [this.red1], this.red1.w, this.red1.h);
      this._run(this.pReduce, { uSrc: this.red1, uSrcSize: [this.red1.w, this.red1.h], uMode: 1 },
        [this.red2], this.red2.w, this.red2.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo([this.red2]));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf);
      gl.readPixels(0, 0, this.red2.w, this.red2.h, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._probe = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      // Scripts that step many frames in one task never see a fence signal,
      // so they read the probe back immediately (blocking, but deterministic).
      if (this.syncProbe) {
        gl.clientWaitSync(this._probe, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
        this._forceProbe = true;
        this._probeActivity();
      }
    }

    _sleep() {
      const P = this.P;
      this._run(this.pFinalize, { uW: this.W.r, uWetEps: P.wetEps, uDryS: P.dryS }, [this.W.w], this.nx, this.ny);
      this.W.swap();
      this._clear([this.F.r, this.F.w]);
      this.awake = false;
      this.dirty = true;
      this.status = { wet: 0, damp: 0, maxW: 0, maxS: 0 };
    }

    // ------------------------------------------------------------ undo
    pushUndo() {
      let snap = this.undoFree.pop();
      if (!snap) {
        if (this.undoStack.length >= UNDO_LEVELS) snap = this.undoStack.shift();
        else snap = [0, 1, 2, 3, 4, 5].map(() => this._tex(this.nx, this.ny, 'f16'));
      }
      const src = [this.W.r, this.G0.r, this.G1.r, this.D0.r, this.D1.r, this.FN.r];
      src.forEach((t, i) => this._run(this.pCopy, { uSrc: t }, [snap[i]], this.nx, this.ny));
      snap.paperType = this.paperType;
      snap.medium = this.medium;
      this.undoStack.push(snap);
    }

    // Returns the paper type of the restored state, or null if nothing to undo.
    undo() {
      const snap = this.undoStack.pop();
      if (!snap) return null;
      if (snap.medium !== this.medium) { LIB.use(snap.medium); this.setPalette(snap.medium); }
      if (snap.paperType !== this.paperType) this.generatePaper(snap.paperType);
      const dst = [this.W.r, this.G0.r, this.G1.r, this.D0.r, this.D1.r, this.FN.r];
      snap.forEach((t, i) => this._run(this.pCopy, { uSrc: t }, [dst[i]], this.nx, this.ny));
      this._clear([this.F.r, this.F.w]);
      this.undoFree.push(snap);
      this.stampCount = 0;
      this.wake();
      return snap.paperType;
    }

    get canUndo() { return this.undoStack.length > 0; }

    // ------------------------------------------------------------ render
    // view: [x0, y0, x1, y1] sheet fractions (y down) to show only that part (gouache)
    render(view) {
      const P = this.P;
      if (this.paint) {
        const pu = this.pigU;
        this._run(this.pPaintComposite, {
          uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uD0: this.D0.r, uD1: this.D1.r,
          uPaperColor: this.paperColor, uK: pu.uK, uS: pu.uS, uOpt: LIB.GOUACHE_OPTICAL,
        }, [this.comp[0], this.comp[1], this.comp[2]], this.nx, this.ny);
        const L = [-0.42, 0.52, 0.74], ll = Math.hypot(L[0], L[1], L[2]);
        this._run(this.pPaintDisplay, {
          uC0: this.comp[0], uC1: this.comp[1], uC2: this.comp[2], uPaperHi: this.paperHi,
          uRes: [this.canvas.width, this.canvas.height], uSim: [this.nx, this.ny], uMM: this.sheetMM,
          uPaperColor: this.paperColor, uLight: L.map((v) => v / ll),
          uExposure: this.exposure, uRelief: PAPER_RELIEF[this.paperType], uImpasto: P.impasto, uPulp: 1,
          uFurrow: P.furrow, uGrain: P.grain, uWarp: P.warp,
          uView: view ? [view[0], 1 - view[3], view[2], 1 - view[1]] : [0, 0, 1, 1],
        }, null, this.canvas.width, this.canvas.height);
        this.dirty = false;
        return;
      }
      this._run(this.pComposite, {
        uW: this.W.r, uG0: this.G0.r, uG1: this.G1.r, uD0: this.D0.r, uD1: this.D1.r, uFN: this.FN.r,
        uPaper: this.paper, uPaperAmp: PAPER_AMP[this.paperType],
      }, this.comp, this.nx, this.ny);
      const pu = this.pigU;
      const L = [-0.42, 0.52, 0.74];
      const ll = Math.hypot(L[0], L[1], L[2]);
      this._run(this.pDisplay, {
        uC0: this.comp[0], uC1: this.comp[1], uC2: this.comp[2], uPaperHi: this.paperHi,
        uRes: [this.canvas.width, this.canvas.height], uSim: [this.nx, this.ny],
        uK: pu.uK, uS: pu.uS, uGran0: pu.uGran0, uGran1: pu.uGran1,
        uPaperColor: this.paperColor, uLight: L.map((v) => v / ll),
        uExposure: this.exposure, uRelief: PAPER_RELIEF[this.paperType],
        uGranDisp: P.granDisp, uCap: P.cap * PAPER_PHYS[this.paperType].cap, uWaterNormal: 7.0,
        uPulp: PAPER_PHYS[this.paperType].pulp, uPencil: this.medium === 'pencil' ? 1 : 0,
      }, null, this.canvas.width, this.canvas.height);
      this.dirty = false;
    }

    // ------------------------------------------------------------ pencil
    // Dry media go straight onto the paper: n contact segments (instances in
    // the stamp layout: iA x0 y0 r0 r1 · iB fill reach capacity seed ·
    // iC blend erase caps · iF _ 6 x1 y1) of pigment slot `slot`.
    pencil(inst, n, slot) {
      if (!n) return;
      const gl = this.gl;
      if (!this.pencilVAO) {
        this.pencilVAO = gl.createVertexArray();
        gl.bindVertexArray(this.pencilVAO);
        const qb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, qb);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.pencilBuf = gl.createBuffer();
        this.pencilCap = 0;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pencilBuf);
        for (let i = 0; i < 6; i++) {
          gl.enableVertexAttribArray(1 + i);
          gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STAMP_FLOATS * 4, i * 16);
          gl.vertexAttribDivisor(1 + i, 1);
        }
        gl.bindVertexArray(null);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pencilBuf);
      if (n * STAMP_FLOATS > this.pencilCap) { this.pencilCap = Math.max(n * STAMP_FLOATS, 2 * this.pencilCap, 4096); gl.bufferData(gl.ARRAY_BUFFER, this.pencilCap * 4, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * STAMP_FLOATS);
      this._clear([this.acc[0]]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo([this.acc[0]]));
      gl.viewport(0, 0, this.nx, this.ny);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.pPencil.use({ uSize: [this.nx, this.ny], uPaper: this.paper });
      gl.bindVertexArray(this.pencilVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      this._run(this.pPencilApply, { uD0: this.D0.r, uD1: this.D1.r, uAcc: this.acc[0], uSlot: slot | 0 }, [this.D0.w, this.D1.w], this.nx, this.ny);
      this.D0.swap(); this.D1.swap();
      this.dirty = true;
    }

    // Debug helper: read a whole state texture back to the CPU.
    readTexture(name) {
      const gl = this.gl;
      const t = name === 'paper' ? this.paper : name === 'paperRaw' ? this.paperRaw : name === 'fibre' ? this.fibre : this[name].r;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo([t]));
      const out = new Float32Array(t.w * t.h * 4);
      gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, out);
      return out;
    }
  }

  window.WatercolorEngine = WatercolorEngine;
  window.WatercolorEngine.EngineError = EngineError;
  window.WatercolorEngine.DEFAULTS = DEFAULTS;
})();
