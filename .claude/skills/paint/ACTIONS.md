# Actions

Most marks are easiest as library strokes (`{"type": "lib", ...}`, see
[LIBRARY.md](LIBRARY.md)): you ask for the mark, the library works out the
brush. This file is the raw action language underneath.

A batch is a JSON array of actions, applied in order by `ink act`, `ink try`
or `ink scratch`. The whole batch is checked before anything is painted; an
invalid action paints nothing and names the action and field.

## Coordinates

- Points are `[x, y]` or `[x, y, pressure]`: fractions of the sheet, **x to
  the right, y down**, 0..1 (−0.05..1.05 allowed, to start or end a stroke off
  the edge). Read positions off `target-grid.png` (lines every 0.05, labels
  every 0.1).
- The sheet is 304.8 × 228.6 mm landscape (228.6 × 304.8 portrait). Lengths
  in actions are in mm: 0.1 of the width ≈ 30.5 mm, 0.1 of the height ≈ 22.9 mm.

## Brush settings

Every painting action accepts these fields. `set` makes them sticky for the
rest of the run; a field on an action applies to that action only.

| field | values | meaning |
|---|---|---|
| `brush` | `round` `flat` `mop` `rigger` `fude` | hair and shape (widths per size: `ink info <run>`) |
| `size` | 0–9 | e.g. round 0 = 2.1 mm … 9 = 15.8 mm; mop 8–31 mm; flat 3–51 mm; fude 3–14 mm; rigger 0.7–4 mm |
| `pigments` | `{"Ultramarine": 1, "Burnt Sienna": 0.5}`, `["Pine soot"]`, `"Indigo"`, or palette index | the mix, by relative amount; names match name / short name / code, case-insensitive, substrings OK |
| `load` | 0–1 | pigment strength in the mix; **pick it from the calibration table** (value on paper per load) |
| `water` | 0–1 | how wet the brush is: 0.2–0.35 dry-brush, 0.45–0.6 normal, 0.7–1 flooding washes |
| `pressure` | 0–1 | default for points without their own: ~0.2 tip only, 0.6 normal, 1 pressed flat (full width) |
| `speed` | mm/s | default 250 (dab 600). Fast strokes on a drier brush break into dry-brush streaks |
| `tip` | bool | ink: dip the tip in dark ink over a paler belly, so one stroke grades across its width |
| `tool` | `brush` `water` `lift` `spatter` `salt` `seal` | `water` is a clean wet brush (softening, backruns, pre-wetting) |
| `lift`, `settle` | ms | how long the brush travels while lifting off (default 70) / landing (default 45) |
| `rinse` | bool | default: rinse automatically when the mix changes or the load drops (the brush keeps 12% of what was in it); `false` keeps a deliberately dirty brush |
| `flatAngle` | radians | chisel angle of the flat brush |

Each stroke reloads the brush from the palette with the current mix, load
and water (painters reload between strokes; a long stroke still runs dry).

## Painting actions

**stroke** — the brush along a path (splined through the points).
```json
{"type": "stroke", "pts": [[0.1, 0.6, 0.3], [0.3, 0.62, 1.0], [0.5, 0.6, 0.2]], "brush": "round", "size": 6, "speed": 200}
```
Per-point pressure shapes the mark: swell and taper by varying the third
number. The brush lands over `settle` ms and keeps moving for `lift` ms after
the last point, so the mark starts a little late and trails past the end.
Starting pressed flat (pressure ≥ 0.9 at the first point) splays the hairs
into a hook; land lighter and press after a few mm.

**dab** — press-and-lift touch, the natural leaf/petal/dot stroke.
```json
{"type": "dab", "at": [0.47, 0.30], "angle": 35, "length": 60, "press": 0.6, "curve": 0.25}
```
`angle` in degrees (0 = right, 90 = down), `length` in mm (path length),
`press` peak pressure, `curve` −1..1 bends it, `profile` overrides the
pressure swell (`[[t, factor], …]` or evenly spaced factors). The mark is
shorter than the path — about 55–65% of `length` at press 0.6 — because the
tip leaves the paper as the pressure fades.

**press** — the brush straight down onto one spot: pressure ramps in, holds, lifts.
```json
{"type": "press", "at": [0.3, 0.4], "press": 0.8, "down": 120, "hold": 200, "up": 120}
{"type": "press", "at": [0.3, 0.4], "press": 0.8, "tilt": [0.35, -0.5]}
```
With no `tilt` the handle is held upright: the hairs fan out all round into an
irregular rosette that grows with `press` (moss dots, blossoms, berries, a
knee). With `tilt` [x, y] (−1..1, the direction the handle leans) the belly
lies over and prints a teardrop pointing that way (a pressed leaf or petal).
`down`/`hold`/`up` are ms; a longer hold lets more ink flow out.

**wash** — fill a region with overlapping passes, reloading each pass.
```json
{"type": "wash", "rect": [-0.03, -0.03, 1.03, 0.45], "brush": "mop", "size": 6, "pigments": {"Ultramarine": 1}, "load": 0.18, "water": 0.75}
{"type": "wash", "region": "v1.0", "brush": "round", "size": 8, "pigments": {"Ultramarine": 1, "Burnt Sienna": 0.6}, "load": 0.35}
{"type": "wash", "poly": [[0.2, 0.5], [0.5, 0.35], [0.8, 0.5], [0.8, 0.7], [0.2, 0.7]], "angle": -10}
```
One of `rect` `[x0, y0, x1, y1]`, `poly` `[[x, y], …]`, `rings`
`[outer, hole, …]` (even-odd: holes stay paper), or `region` (an id from
`ink regions`, expanded to its rings). `angle` rotates the passes (degrees,
0 = horizontal), `spacing` is the pass spacing as a fraction of the brush
width (default 0.6; smaller = more overlap, wetter, more even), `inset`
pulls pass ends in from the outline (fraction of width, default 0.3). Passes
land and lift quickly so the wash stays inside its outline; for a full-bleed
wash extend the rect past 0 and 1. Wet paper grows: on raw xuan expect a
few mm of bleed beyond the outline.

**lift** — blot with a thirsty brush/tissue along `pts` (or at `at`): lifts
paint best from wet or damp washes and much less once dry; staining pigments
(phthalo, quinacridone, sumi) hold on harder than granulating earths.

**spatter** — flick the loaded brush along `pts`: droplets of the current mix.

**salt** (watercolor) — sprinkle salt along `pts` into a *wet* wash; starbursts as it dries.

**seal** (ink) — press the cinnabar seal at `at` (about 12 mm square).

## Time and the board

| action | meaning |
|---|---|
| `{"type": "wait", "s": 5}` | time passes: paint flows, sinks in, dries. 3–15 s after a wash gives the damp stage for wet-in-wet charges and soft lifts |
| `{"type": "dry"}` | run the hair dryer until the sheet is dry (`max` seconds, default 240; `"dryer": false` to air-dry). Do this before wet-on-dry layers and hard edges |
| `{"type": "tilt", "x": 0, "y": 0.5}` | tilt the board, −1..1 (1 ≈ 30°): paint drifts toward +x / +y (right / down). Subtle: grades a very wet wash, it does not pour. Stays until you set it back to 0 |
| `{"type": "dryer", "on": true}` | leave the dryer running (until `on: false`) |
| `{"type": "humidity", "value": 40}` | room humidity 20–85% (default 55): lower dries faster |

Measured drying times (sim seconds; the sim runs ~10× faster than that in
wall time), air at 55% RH: a watercolor wash (mop, water 0.6) keeps a wet
surface for ~10 s and is dry at ~35 s; at water 0.9, ~20 s and ~50 s. Ink on
raw xuan sinks in within a few seconds and is dry in ~50 s. `dry` with the
dryer takes 5–15 s.

## How the brush really marks (learned painting the heron)

- **Pressure spreads the belly.** A fude's long hairs splay to ~3× the
  nominal width at pressure 0.8. Use 0.4–0.55 for a "normal" line of the
  brush's width; 0.8+ only for deliberately broad, pressed strokes.
- **Marks trail the stroke.** The tip drags behind the handle, so a mark lands
  short of the path's end and a little back toward its start (by ~0.02–0.04 of
  the sheet for a fude). Overshoot: extend paths past where the mark should end
  and shift leaf/blade paths ~0.03 toward their tips; end with pressure ~0.02.
- **Landing splays.** Where a stroke lands at pressure ≥ 0.4 the hairs spread
  into a knob. Land at 0.15–0.3 and press after a few mm (or `settle` 20).
- **Pale ink has a floor.** Below load ~0.1 the ink strength bottoms out (≈L85
  in a wash). For paler tones pre-wet with the `water` tool and wash in with
  light pressure (0.45), speed 400, spacing 0.8 (≈L90–92, soft edges).
- **Thin strokes read paler than washes** of the same load: add ~0.1–0.2 load
  for stalks, legs and lines; below pressure ~0.4 a size 0–1 tip may not touch.
- **Darks into a damp wash bleed** into one mass: `dry` first, then paint the
  darks wet-on-dry with water ≤ 0.35.

## Recipes (tested on scrap)

Test your own with `ink scratch` before using them on the painting.

- **Bamboo leaf (sumi)**: `set` fude size 4, water 0.55, load 0.35–0.55, tip
  true; then `dab` press 0.55–0.65, length 55–75, speed 540–780, angle toward
  where the leaf hangs; groups of 2–5 fanning from one point.
- **Bamboo stalk segment**: fude size 7, water 0.42, load 0.16–0.4 (far = pale),
  a straight stroke bottom → top at speed 190–260 with pressure ~1.1 → 0.94 →
  0.86 → 0.94 → 1.1 along it; leave a 2–3 mm gap between segments for nodes.
- **Flat graded sky (watercolor)**: mop size 6, water 0.75, load from
  calibration for the top value, `wash` a full-bleed rect with `tilt y 0.4`,
  then a second wash lower down in a warmer mix while the first is wet.
- **Soft cloud**: `wait` 4–8 s after the sky wash, then `lift` along the cloud
  shape with a size 5–7 brush.
- **Dry-brush texture**: water 0.2–0.3, load 0.5+, speed 400+, pressure 0.3–0.5.
