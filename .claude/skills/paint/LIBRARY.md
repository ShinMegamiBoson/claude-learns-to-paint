# Stroke library

Library strokes are asked for by **the mark you want on the paper**: where it
should start and end, how wide (mm) and how dark (L*, 0 black … ~95 bare
paper). The library compiles that into brush actions using measurements of how
this brush marks this paper, so the mark lands where you asked instead of
where the path went.

```json
{"type": "lib", "stroke": "line",  "label": "heron leg", "path": [[0.311, 0.57], [0.309, 0.62], [0.316, 0.76]], "width": 2.5, "value": 50}
{"type": "lib", "stroke": "blade", "label": "reed leaf", "from": [0.70, 0.52], "to": [0.575, 0.69], "width": 6, "value": 55, "curve": 0.2}
{"type": "lib", "stroke": "dab",   "label": "knee", "at": [0.308, 0.615], "length": 14, "width": 4, "angle": 90, "value": 40}
{"type": "lib", "stroke": "band",  "label": "water dash", "x0": 0.22, "x1": 0.43, "y": 0.742, "width": 3, "value": 86}
{"type": "lib", "stroke": "stack", "label": "leg reflection", "at": [0.314, 0.77], "count": 5, "lengths": [16, 6], "width": 3, "value": 78}
{"type": "lib", "stroke": "drybrush", "label": "feathers", "path": [[0.30, 0.31], [0.24, 0.38], [0.20, 0.46]], "width": 4, "value": 55}
{"type": "lib", "stroke": "mist",  "label": "left mist", "poly": [[0.01, 0.62], [0.1, 0.6], [0.17, 0.61], [0.17, 0.68], [0.01, 0.69]], "value": 90}
{"type": "lib", "stroke": "wash",  "label": "body mass", "region": "v1.0", "value": 50}
{"type": "lib", "stroke": "saved:heron-leg", "from": [0.31, 0.57], "to": [0.316, 0.76]}
```

### Texture

`line`, `dab` and `blade` take `"texture": "solid" | "natural" | "dry"`
(default `natural`). It sets how loaded the brush is: a flooded brush lays
solid ink; a semi-dry one (natural, water ≈0.22, a fuller brush for darks)
breaks into hair streaks at its flanks and tail; a dry one (water ≈0.15,
faster) scatters flying white (kasure) through the stroke. What decides
whether texture survives in a painting, measured:

- **dry paper underneath.** Strokes laid into a still-wet wash merge into a
  soft mass whatever their texture: `dry` before feather, bark and grass work.
- **the brush's water and speed** (texture above; faster breaks up more).
- **not motion**: pressure variation or a wobbling hand change the outline,
  not the texture.
- resolution: at the default 1024-cell sheet a cell is 0.3 mm, about a hair;
  `new --res 2048` gives finer, more ragged dry strokes (slower).

Any ordinary brush field on a lib action (`pigments`, `water`, `speed`,
`brush`, `size`, `pressure`, `load`, `tip`) overrides what the library would
choose — that is how a stroke is modified at painting time. The expansion is
stored in the checkpoint, so replays never depend on the library changing.

## Kinds

| stroke | asks for | compiles to |
|---|---|---|
| `line` | `path` (2+ points), `width` mm, `value` | one stroke: size and pressure from the width table (pressures kept near 0.5), load from the value table, a light landing, a taper over the last 12 mm, the path trimmed/extended by the measured lag so the mark's ends land on the path's ends. `taper: [start, end]` (pressure at each end, as a fraction) and `taper_mm: [landing, lift]` (how long each end takes, default 6/12) shape the ends |
| `drybrush` | like `line` | a line on a dry brush (water 0.24) at 460 mm/s: breaks into streaks — feathers, grass, bark |
| `blade` | `from` (base) → `to` (tip), `width` (widest), `value`, `curve` | a press-and-lift dab whose path is stretched and slid so the measured mark (which covers only ~10–55% of a raw dab's path) spans from→to |
| `dab` | `at` (centre), `length`, `width`, `angle`, `value` | a short line with fuller ends: cattail heads, knees, eyes, buds |
| `band` | `x0`, `x1`, `y`, `width`, `value` | a soft horizontal line with tapered ends: water dashes, horizons (palest ≈ L92, darkest ≈ L75) |
| `stack` | `at` (top centre), `count`, `lengths` [top, bottom] mm, `spacing` mm, `value` | a column of bands narrowing downward: reflections |
| `mist` | `rect` / `poly` / `rings` / `region`, `value` (≈ L88–92) | pre-wet a little wider with clean water, then light fast sparse passes of pale ink: soft-edged mist |
| `wash` | a region, `value` | a scanline wash with the load taken from the run's swatch calibration |
| `saved:<name>` | `from`, `to` (and optional `value`) | a saved recipe mapped onto from→to by translation, rotation and scale |

## Calibration and accuracy

```bash
node .claude/skills/paint/scripts/ink.mjs strokes calibrate <run>     # once per medium/paper (≈15 s)
```

1. **Raw sheets** (`strokes/cal-*.png`): lines at 8 sizes × 4 pressures
   (width, where the mark starts/ends relative to the path, value at load 0.5),
   lines/dry-brush/bands/mist at 4–9 loads (value tables), blades at 4 sizes ×
   3 presses (width, the fraction of the path the mark covers).
2. **Closed loop**: a verification sheet of marks asked for in mark space is
   painted, every mark is measured, and the leftover error per kind (end offsets,
   width ratio, value offset) is folded into `corrections`; twice.
3. **Reference sheet** `strokes/reference-<medium>-<paper>-marked.png`: the
   final verification sheet, gridded — what each kind looks like.

Half-sized xuan, fude, after calibration (median over the reference sheet):
mark ends within **0.5 mm** of where asked, width within **7%**, value within
**4 L\***. Known limits (the library warns):

- a **1 mm line cannot be dark** (≈L80 at best): the finest tip barely deposits.
  Use ≥ 2 mm for darks.
- **dabs under ~12 mm** come out narrower and paler than asked.
- **bands stop at ≈L75**; for darker horizontals use a `line`.
- **mist is L88–92** whatever the load; for a darker soft area, mist then a
  pale `wash` or `band`s inside it.
- below pressure ~0.4 the tip does not reach the paper at all.
- **blades are calibrated on ≈50 mm marks**; long leaves (60 mm +) land
  short and heavy. Short dark marks (cattail heads, a knee, hairline crests)
  are the least reliable kinds: `strokes test` them first.
- a `line` used as a leaf stays blunt and evenly dark; real leaves taper to a
  point and fade — prefer `blade` within its calibrated length. Mind which
  end is which: a blade is fullest at `from` and comes to a point at `to`.
- **pointed landings need room.** A loaded fude lands on its point and widens
  as it is pressed, so a mark starts pointed when the pressure builds over
  ≥ 8 mm of travel (`taper_mm: [12, …]`); a landing ramp of 4–6 mm (the
  default) starts round. The lift end always comes to a point.

Measured facts worth knowing when writing raw strokes (from the tables):
a fude's mark trails the brush — it starts 1–12 mm *before* the path start
and ends 7–15 mm *short* of the path end, more for bigger sizes and harder
pressure; a raw `dab`'s mark covers only ≈10%–55% of its path.

## Pencil

On a pencil sheet (`new --medium pencil --paper bristol|drawing|toothy`) the
library draws instead of paints. Graphite goes straight onto the paper's
tooth (no water): a light touch catches only the tops of the tooth, pressing
reaches into it; harder grades (2H) stay pale however much they are layered,
soft ones (8B) go dark and grainy and wear their point faster.

### Pencil runs draw by motion

A pencil run is `"authoring": "motion"` (run.json): every mark is a
`gesture` — where the hand starts, how it is already moving, and how it is
pushed. Paths, polygons, rects and regions are refused (`line`, `hatch`,
`rough`, `tone`, raw `stroke`, …): the curve is never written, it is what the
push produces, with the hand's momentum and tremor. `set`, `wait` and the
other non-marks are allowed.

```json
{"type": "lib", "stroke": "gesture", "label": "crown", "start": [0.54, 0.088], "aim": [0.413, 0.12],
 "v0": {"dir": -136, "speed": 100}, "pushes": [{"turn": -457, "ms": 168}, {"turn": -251, "ms": 174}, {"turn": -762, "ms": 126}],
 "value": 58, "looseness": 0.4}
{"type": "lib", "stroke": "gesture", "label": "wing feathers", "start": [0.40, 0.25], "v0": {"dir": 152, "speed": 81},
 "pushes": [{"along": 2983, "ms": 90}, {"along": -1627, "ms": 110}], "grade": "2B", "pressure": 0.55,
 "repeat": {"n": 27, "step": [0.17, 0.9], "stagger": 6, "fan": 16, "scale": [1, 0.75], "vary": 0.12, "jitter": 0.5}}
```

- `start` [x, y] sheet fractions (or `frame` fractions); `v0` mm/s as
  `{dir, speed}` (0° = +x, 90° = down the sheet) or [vx, vy]; `heading` to
  push along from rest.
- `pushes`, one after another: `{dir, mag, ms}` fixed on the sheet (mm/s²),
  or `{along, turn, ms}` relative to the way the hand is moving — `along`
  speeds up (+) or brakes (−), `turn` bends it (+ clockwise on the sheet, to
  the right of travel). At speed v a turn of a mm/s² curves with radius
  v²/a, so to bend Δ radians over L mm at v: `turn = v²·Δ/L`, `ms = 1000·L/v`.
  Or `acc` [[t, ax, ay], ...] keyframes; `coast` ms after the last push.
  Curves are a few pushes, not one per bend: split where the curvature
  changes (a crown: steep, flat, steep).
- `repeat {n, step [dx, dy] mm, …}` — the same motion n times (hatching, a
  feather row, the strands of a blade): `vary` (0.08) and `jitter` (0.4 mm)
  make each copy a little different, `stagger` mm moves each start along its
  heading (no hard starting edge), `scale [first, last]` shrinks or grows the
  copies across the row (speed and push scaled, timing kept: a smaller copy of
  the motion), `fan` degrees turns them across the row (a row that follows a
  rounded form, or strands that close to a point), `together: true` gives
  them one tremor (strokes side by side inside one shape).
- Marks: `value` (the line's L*) or `grade` + `pressure`; `tone` (with
  `repeat`): the value the area reads as at that spacing; `width` mm (the
  point), `side` 0..1 (the side of the lead: soft broad tone, rows ≈2.2 mm
  apart), `tool: pencil|stump|eraser`, `taper_mm` [in, out] (short dashes
  need small tapers), `looseness` (0.2 steady … 1 a quick sketch).
- `aim` [x, y]: where the mark is meant to end. Not drawn; `ink preview`
  reports the miss. Each gesture's tremor is seeded from its start, so
  changing a push changes only that push's effect: correct by the miss.

**Pressure that follows the tone** — `"follow": "tone"` on a gesture: the
hand keeps its motion, but presses as the reference asks along the way, by
what the drawing still lacks there (layers multiply, so the layer needed is
Y(paper)·Y(target)/Y(now)). One grade is chosen for the darkest need, the
pressure varies point by point (smoothed over `follow_smooth_mm`, default 2,
since a hand cannot change faster); it lifts off where the drawing is
already dark enough. With the eraser it does the opposite: presses where the
drawing is darker than the reference, as hard as the excess (`follow_tol`
L* of tolerance, default 2). `follow_mm` (0.6) is how fine a detail it
samples. This is the strongest tool for tone: a family of strokes laid along
the form (feathers, blades, ripples) with `follow` matches the reference's
values while the strokes keep their direction — on the heron it took the
tail from 9.9 to 3.6 and the wing from 5.4 to 2.8 (mean |ΔL| per cell). Lay
the direction by the form, never straight across it: a vertical sweep
matched the reeds' tone but scrubbed out their blades. An eraser pass with
`follow` before the pencil pass clears what is in the wrong place.

**Steering to a line** (`scripts/steer.py`): when a gesture must follow a
known line (a blade, a contour), integrate it, compare, and adjust the
push whose end strays sideways first; repeat. Each blade of the reeds
converged to 0.3 mm. `scripts/snap.py` moves a rough line (read off a zoom)
onto the reference's dark ridge and measures its width.

`repeat.stagger_forward: true` staggers starts only forward along the
heading, so no stroke starts before the line it starts on (reflections
hanging from a waterline).

**Erasers** are gestures with `"tool": "eraser"`: `eraser` `vinyl` (default)
or `kneaded`, `width` mm (how wide it bears on the paper, 0.6–30), `pressure`.
They lift graphite as real ones do: an eraser bears on the tops of the
paper's tooth first, and only reaches into the valleys when pressed, so a
light pass leaves a ghost of the mark in them; dense, pressed-in graphite
and anything worked in with the stump hold on and take several passes; a
vinyl eraser has a crisp edge and drags a little graphite along, a kneaded
one is soft-edged, conforms into the tooth and lifts only a share each touch
(it lightens rather than removes). Measured on drawing paper (L*, paper 96.5):

| over a patch of | HB 80 | 4B 66 | 8B 46 |
|---|---|---|---|
| vinyl, firm, one pass | 95 | 87 | 71 |
| vinyl, firm, two passes | 97 | 95 | 93 |
| vinyl, light | 88 | 73 | 56 |
| kneaded, firm, one pass | 86 | 73 | 53 |

Rubbing out a construction line: replay its gesture with the eraser (same
start, same tremor, same line). Scrubbing is a gesture too: a zigzag of
alternating sideways pushes while moving along.

`ink preview <run> <file> [--box …]` integrates the gestures without
drawing: trajectories over the target and the painting (a dot every 50 ms:
close dots are slow), each start ringed and numbered, and per gesture its
end, final heading, length, duration and the miss from `aim`. Aim, preview,
correct, then draw.

What worked on the heron (`paintings/heron-pencil3/batches/`):
- the rough sketch: one or two gestures per outline, light (L84), loose,
  each repeated twice as a searching second pass; corrected by `aim` to a
  few mm;
- tone: rows of feather flicks (accelerate, ease off) along the form, each
  row fanned and scaled so its strokes stay inside the shape; built in
  layers of fine lines (2B, then 4B, then 6B–8B in the darks) — one layer of
  0.8 mm lines only reaches ≈L85, so mid tones take two or three;
  side-of-lead tone reads as a grainy smudge at this scale;
- blades and stalks: `together` strands fanned to a point; seed heads as a
  stem with two repeated rows of drooping spikelets;
- water: wavering horizontal strokes (alternating turns), zigzags as
  alternating sideways pushes while moving down;
- construction lines erased by replaying the rough gesture with
  `tool: eraser` (same start, same tremor, same line); highlights lifted
  with eraser flicks along the feathers.

Measured: hatching at 0.7 mm — HB p0.6 ≈ L88, 2B p0.6 ≈ L83, 4B p0.7 ≈ L74
(one layer, on drawing paper). Grades and pressures for `value`/`tone` come
from the calibration (`ink strokes calibrate <run>`).

## Codebook: marks by example

The library's kinds are a few hand-made gestures. The **codebook** is thousands
of them: gestures sampled across brush size, length, bend, S-curve, pressure
profile (landing, body, swell, lift), speed, load and water, each painted once
on scrap, dried and measured (length, and width, darkness and centreline at 24
points along it).

```bash
ink codebook build <run> [--n 12000]    # ≈20 marks/s, in its own tab (≈10 min); resumable
ink codebook info <run>
```

Every gesture is painted once, horizontally, and placed anywhere by a
rotation, a translation and (for a bend the other way) a mirror — never
painted per angle. That is **approximate**: the brush's lean carries over from
the stroke before and swings round as it moves, so the same gesture at another
angle comes out a little different (`ink codebook test`: width ±2–4 mm,
length ±8–20%, against ±0.6 mm / 4% for the same angle moved 45 mm). Treat a
codebook mark as a close proposal: `fit` in `search` and `codebook fit` paint
every candidate for real and keep what actually works. Direction of travel
matters (a brush lands and lifts differently), so a mark and its reverse are
separate entries; matching tries both.

```json
{"type": "lib", "stroke": "fit", "path": [[0.863, 0.67], [0.824, 0.72], [0.79, 0.787]]}
{"type": "lib", "stroke": "fit", "path": [[0.2, 0.5], [0.3, 0.45]], "width": 6, "value": 35, "ends": [15, 20]}
{"type": "lib", "stroke": "code:4127", "from": [0.4, 0.5], "to": [0.46, 0.42]}
```

- `fit` measures the reference along `path` (snapping it onto the mark and
  carrying it on to the mark's real, paler tips — hops a crossing mark), or
  takes `width`/`value` (+ `ends`: taper lengths in mm) as a description;
  finds the nearest codebook marks (either direction, mirrored if that fits
  better), aligns each to the path (least squares), and **interpolates** the
  gestures of the nearest few (same size and direction; weights by closeness).
  `"mode": "nearest"` uses the single best mark instead; `k`, `sizes`,
  `direction: "forward"` narrow it. As candidates (search, codebook fit) it
  offers the nearest marks, blends around the best three, a *solved* gesture
  (a local linear fit of how the mark changes with each parameter, inverted
  for the target — best on length, worst on value), and the library's own
  line and blade for the same mark. Measured on new gestures: repainted from
  the codebook they land within ≈2 mm of width, 6–7 L* and 10–16% of length.
- `code:<id>` places one entry from→to (`mirror: true` to bend the other way).
- Widths are measured at half depth against the mark's own surroundings (a
  wash behind it is background), so reference marks and codebook marks compare.

The codebook proposes; the simulation decides. Two ways to let it:

```bash
ink search <run> spec.json        # spec: {"fit": {"path": [...]}, "k": 10} → nearest + interpolations, each painted and scored
ink codebook fit <run> --box 0.55,0.5,1,1 --darker-than 45 [--k 8] [--marks t0,t2]
```

`codebook fit` traces the marks in the box, and for each (palest first)
paints its candidates — the nearest marks and interpolations — from the
painting plus the marks already chosen, keeps the best, and writes a batch
(`batches/fit-<box>.json`, with a sheet beside the target) to `act` or `try`.
`ink codebook test <run>` checks the claims: the same gestures at other angles
and mirrored against 0°, and new gestures predicted from the codebook
(nearest vs interpolated) against how they actually paint.

## Testing and extending

```bash
ink strokes test <run> batch.json    # paint on scrap, report measured vs asked for every lib stroke
ink strokes sheet <run>              # repaint the reference sheet with the current calibration
ink strokes save <run> <name> batch.json [--from x,y --to x,y] [--value L] [--description "..."]
ink strokes list                     # kinds, saved recipes, calibrated papers
```

`strokes test` is the loop for modifying a stroke at painting time: ask for a
mark, see the measured width/value/ends, adjust (width, value, or a raw
override), test again, then use it. When a hand-built stroke works — say a
leg with a soft landing and a knee — `strokes save` turns it into
`saved:<name>`, anchored on from→to, to be placed anywhere at any angle and
scale (brush sizes are kept; pass `value` to rescale its loads).
