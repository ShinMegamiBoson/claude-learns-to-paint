// Pigment library. K and S are Kubelka–Munk absorption and scattering
// coefficients per RGB channel (linear light), per unit of concentration.
// Several watercolors come from Curtis et al., "Computer-Generated
// Watercolor" (1997); the rest were fitted by eye against swatches.
//
// rho   – particle density: how quickly the pigment settles out of water
// omega – staining power: how firmly it holds to paper once settled
// gamma – granulation: how strongly it collects in the paper's valleys
//
// Two palettes share the eight slots the simulation carries per cell:
// Western watercolor, and the inks and colours of sumi-e.
(function () {
  'use strict';

  const WATERCOLOR = [
    { name: 'Hansa Yellow', short: 'Hansa Yellow', code: 'PY97', K: [0.06, 0.21, 1.78], S: [0.50, 0.88, 0.009], rho: 0.020, omega: 1.4, gamma: 0.05, opacity: 'Semi-transparent', staining: true, granulating: false },
    { name: 'Yellow Ochre', short: 'Yellow Ochre', code: 'PY43', K: [0.22, 0.50, 1.35], S: [0.40, 0.30, 0.12], rho: 0.070, omega: 0.7, gamma: 0.45, opacity: 'Semi-opaque', staining: false, granulating: true },
    { name: 'Cadmium Red', short: 'Cadmium Red', code: 'PR108', K: [0.14, 1.08, 1.68], S: [0.77, 0.015, 0.018], rho: 0.080, omega: 0.6, gamma: 0.30, opacity: 'Opaque', staining: false, granulating: false },
    { name: 'Quinacridone Rose', short: 'Quin. Rose', code: 'PV19', K: [0.22, 1.47, 0.57], S: [0.05, 0.003, 0.03], rho: 0.014, omega: 3.2, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'French Ultramarine', short: 'Ultramarine', code: 'PB29', K: [0.95, 0.80, 0.20], S: [0.010, 0.010, 0.06], rho: 0.060, omega: 0.6, gamma: 0.75, opacity: 'Transparent', staining: false, granulating: true },
    { name: 'Phthalo Blue', short: 'Phthalo Blue', code: 'PB15:3', K: [2.20, 0.75, 0.18], S: [0.01, 0.02, 0.04], rho: 0.010, omega: 4.0, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: "Hooker's Green", short: "Hooker's Green", code: 'PG7 · PY110', K: [1.62, 0.61, 1.64], S: [0.01, 0.012, 0.003], rho: 0.018, omega: 2.4, gamma: 0.08, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Burnt Sienna', short: 'Burnt Sienna', code: 'PR101', K: [0.24, 0.92, 1.85], S: [0.10, 0.04, 0.02], rho: 0.050, omega: 0.9, gamma: 0.40, opacity: 'Semi-transparent', staining: false, granulating: true },
  ];

  // Sumi (soot bound in animal glue) is carbon so fine it stays suspended
  // and travels with the water, then locks to the fibres for good once dry.
  // Pine soot dilutes to a cool blue-grey, oil soot to a warm brown-grey.
  const INK = [
    { name: 'Pine-soot sumi', short: 'Pine soot', code: '松煙墨', K: [3.0, 2.9, 2.55], S: [0.015, 0.015, 0.02], rho: 0.012, omega: 6, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Oil-soot sumi', short: 'Oil soot', code: '油煙墨', K: [2.75, 2.85, 3.05], S: [0.02, 0.02, 0.02], rho: 0.012, omega: 6, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Ai (indigo)', short: 'Indigo', code: '藍', K: [1.75, 1.05, 0.55], S: [0.02, 0.02, 0.03], rho: 0.016, omega: 3.5, gamma: 0.05, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Taisha (red ochre)', short: 'Red ochre', code: '代赭', K: [0.38, 1.1, 1.6], S: [0.25, 0.12, 0.07], rho: 0.06, omega: 0.9, gamma: 0.4, opacity: 'Semi-opaque', staining: false, granulating: true },
    { name: 'Tōō (gamboge)', short: 'Gamboge', code: '藤黄', K: [0.05, 0.32, 2.3], S: [0.04, 0.07, 0.02], rho: 0.015, omega: 2.5, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Shu (cinnabar)', short: 'Cinnabar', code: '朱', K: [0.08, 1.95, 2.2], S: [0.95, 0.08, 0.05], rho: 0.09, omega: 0.8, gamma: 0.35, opacity: 'Opaque', staining: false, granulating: true },
    { name: 'Enji (rouge)', short: 'Rouge', code: '臙脂', K: [0.3, 1.85, 0.95], S: [0.02, 0.01, 0.02], rho: 0.014, omega: 3, gamma: 0.0, opacity: 'Transparent', staining: true, granulating: false },
    { name: 'Rokushō (malachite)', short: 'Malachite', code: '緑青', K: [1.5, 0.4, 0.85], S: [0.2, 0.3, 0.24], rho: 0.1, omega: 0.7, gamma: 1.0, opacity: 'Semi-opaque', staining: false, granulating: true },
  ];

  // Dry media laid straight onto the paper's tooth (no water): graphite, a
  // little silvery and never quite black, matte charcoal, and a few
  // coloured pencils. Amounts run 0..1 (1 = the tooth filled by the softest
  // grade, pressed hard).
  const PENCIL = [
    { name: 'Graphite', short: 'Graphite', code: 'C', K: [2.35, 2.3, 2.15], S: [0.34, 0.34, 0.36], rho: 0, omega: 9, gamma: 0, opacity: 'Opaque', staining: true, granulating: false },
    { name: 'Charcoal', short: 'Charcoal', code: 'vine', K: [3.4, 3.4, 3.3], S: [0.12, 0.12, 0.13], rho: 0, omega: 9, gamma: 0, opacity: 'Opaque', staining: true, granulating: false },
    { name: 'Sepia pencil', short: 'Sepia', code: 'PBr7', K: [0.95, 1.35, 1.75], S: [0.2, 0.14, 0.1], rho: 0, omega: 9, gamma: 0, opacity: 'Semi-opaque', staining: true, granulating: false },
    { name: 'Sanguine', short: 'Sanguine', code: 'PR101', K: [0.3, 1.25, 1.6], S: [0.4, 0.14, 0.09], rho: 0, omega: 9, gamma: 0, opacity: 'Semi-opaque', staining: true, granulating: false },
    { name: 'Indigo pencil', short: 'Indigo', code: 'PB15', K: [1.9, 1.2, 0.6], S: [0.08, 0.1, 0.16], rho: 0, omega: 9, gamma: 0, opacity: 'Semi-opaque', staining: true, granulating: false },
    { name: 'Olive pencil', short: 'Olive', code: 'PG7', K: [1.3, 0.75, 1.6], S: [0.1, 0.16, 0.08], rho: 0, omega: 9, gamma: 0, opacity: 'Semi-opaque', staining: true, granulating: false },
    { name: 'Ochre pencil', short: 'Ochre', code: 'PY43', K: [0.25, 0.55, 1.4], S: [0.4, 0.3, 0.12], rho: 0, omega: 9, gamma: 0, opacity: 'Semi-opaque', staining: true, granulating: false },
    // not a pigment: how much the graphite here has been worked into the
    // tooth (by a stump, or burnished); it only changes how grainy it looks
    { name: 'Burnish', short: 'Burnish', code: '', hidden: true, K: [0, 0, 0], S: [0, 0, 0], rho: 0, omega: 9, gamma: 0, opacity: '', staining: true, granulating: false },
  ];

  // Opaque body colour (gouache): pigment packed in gum with a filler, laid
  // thick enough to hide what is under it. Each colour is described by how it
  // looks laid on thickly (masstone) and mixed one part to nine of white
  // (tint, sRGB); K and S per unit of paint are solved from those two against
  // titanium white, so mixtures and thin scumbles follow from Kubelka–Munk.
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const ks = (R) => ((1 - R) * (1 - R)) / (2 * R);
  const WHITE = { R: [246, 245, 241].map(lin), S: 9 };
  WHITE.K = WHITE.R.map((R) => ks(R) * WHITE.S);
  // opaque pigments scatter strongly in every channel, even where the
  // tint alone cannot tell (a red's red channel)
  const S_MIN = { Opaque: 3, 'Semi-opaque': 1.2, Transparent: 0.3 };
  function bodyColour(o) {
    const K = [], S = [];
    for (let c = 0; c < 3; c++) {
      const km_ = ks(lin(o.mass[c])), kt = ks(lin(o.tint[c])), f = 0.1;
      // f·K + (1-f)·Kw = kt·(f·S + (1-f)·Sw), with K = km·S
      let s = km_ > kt + 1e-4 ? ((1 - f) * (kt * WHITE.S - WHITE.K[c])) / (f * (km_ - kt)) : 6;
      // where the pigment reflects (its own colour) the tint cannot tell how
      // much it scatters; an opaque pigment scatters a lot there
      if (lin(o.mass[c]) > 0.3) s = Math.max(S_MIN[o.opacity] || 0.3, s);
      s = Math.min(12, Math.max(0.05, s));
      S.push(+s.toFixed(4)); K.push(+(km_ * s).toFixed(4));
    }
    return Object.assign({ K, S, rho: 0, omega: 9, gamma: 0, staining: false, granulating: false }, o);
  }
  const GOUACHE = [
    Object.assign({ name: 'Titanium White', short: 'White', code: 'PW6', K: WHITE.K.map((v) => +v.toFixed(4)), S: [9, 9, 9], rho: 0, omega: 9, gamma: 0, opacity: 'Opaque', staining: false, granulating: false, mass: [246, 245, 241], tint: [246, 245, 241] }),
    // no black: ultramarine with burnt sienna (and crimson) mixes richer darks,
    // and crimson reaches the deep reds an earth palette cannot
    bodyColour({ name: 'Alizarin Crimson', short: 'Crimson', code: 'PR83', mass: [98, 22, 40], tint: [228, 168, 186], opacity: 'Transparent' }),
    bodyColour({ name: 'Ultramarine Blue', short: 'Ultramarine', code: 'PB29', mass: [30, 26, 84], tint: [132, 144, 208], opacity: 'Semi-opaque' }),
    bodyColour({ name: 'Phthalo Green', short: 'Phthalo Green', code: 'PG7', mass: [10, 50, 42], tint: [76, 162, 142], opacity: 'Semi-opaque' }),
    bodyColour({ name: 'Cadmium Yellow', short: 'Cad. Yellow', code: 'PY35', mass: [250, 190, 12], tint: [250, 236, 172], opacity: 'Opaque' }),
    bodyColour({ name: 'Cadmium Red Light', short: 'Cad. Red', code: 'PR108', mass: [224, 66, 36], tint: [246, 182, 162], opacity: 'Opaque' }),
    bodyColour({ name: 'Yellow Ochre', short: 'Yellow Ochre', code: 'PY43', mass: [196, 142, 58], tint: [238, 222, 192], opacity: 'Opaque' }),
    bodyColour({ name: 'Burnt Sienna', short: 'Burnt Sienna', code: 'PBr7', mass: [128, 58, 32], tint: [222, 192, 178], opacity: 'Opaque' }),
  ];

  // the first gouache palette (robin 1) had ivory black where crimson is now
  const GOUACHE_V1 = GOUACHE.slice();
  GOUACHE_V1[1] = bodyColour({ name: 'Ivory Black', short: 'Black', code: 'PBk9', mass: [30, 29, 30], tint: [116, 118, 122], opacity: 'Opaque' });
  const PALETTES = { watercolor: WATERCOLOR, ink: INK, pencil: PENCIL, gouache: GOUACHE, 'gouache-v1': GOUACHE_V1 };
  // linear reflectance of bare paper: rag watercolor paper, warmer xuan,
  // bright drawing paper, and illustration board for gouache
  const PAPERS = { watercolor: [0.93, 0.90, 0.84], ink: [0.93, 0.895, 0.80], pencil: [0.935, 0.925, 0.89], gouache: [0.90, 0.885, 0.85] };
  // Gouache amounts are paint film thickness in the brush's units; this is
  // how many optical units of paint one unit of film is.
  const GOUACHE_OPTICAL = 5;

  const lib = {
    PALETTES,
    PIGMENTS: WATERCOLOR,
    PAPER_LINEAR: PAPERS.watercolor,
    GOUACHE_OPTICAL,
    medium: 'watercolor',
    // palette: a variant of the medium's colours (an older run's), by name
    use(medium, palette) {
      lib.medium = medium;
      lib.PIGMENTS = PALETTES[palette && PALETTES[palette] ? palette : medium];
      lib.PAPER_LINEAR = PAPERS[medium];
    },
    swatch, reflectRGB,
  };

  function km(K, S) {
    S = Math.max(S, 1e-4);
    K = Math.max(K, 1e-5);
    const a = 1 + K / S;
    const b = Math.sqrt(a * a - 1);
    const bs = Math.min(30, b * S);
    const sh = Math.sinh(bs), ch = Math.cosh(bs);
    const c = a * sh + b * ch;
    return [sh / c, b / c];
  }

  function toSrgb(c) {
    c = Math.min(1, Math.max(0, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  // Reflectance of a pigment layer over paper, as 0-255 sRGB, using the
  // palette in use. conc: array of 8 concentrations.
  function reflectRGB(conc) {
    const pig = lib.PIGMENTS, paper = lib.PAPER_LINEAR;
    const out = [0, 0, 0];
    const opt = lib.medium === 'gouache' ? GOUACHE_OPTICAL : 1;
    for (let ch = 0; ch < 3; ch++) {
      let K = 0, S = 0;
      for (let i = 0; i < pig.length; i++) {
        K += conc[i] * pig[i].K[ch] * opt;
        S += conc[i] * pig[i].S[ch] * opt;
      }
      const [R, T] = km(K, S);
      const Rp = paper[ch];
      out[ch] = Math.round(toSrgb(R + (T * T * Rp) / (1 - R * Rp)) * 255);
    }
    return out;
  }

  function swatch(conc) {
    return 'rgb(' + reflectRGB(conc).join(',') + ')';
  }

  window.WC_PIGMENTS = lib;
})();
