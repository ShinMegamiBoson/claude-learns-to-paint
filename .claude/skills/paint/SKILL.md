---
name: paint
description: Paint a picture with this project's watercolor / sumi-e ink / pencil / gouache simulation. Generates a reference painting in the simulator's own medium with gpt-image-2.5-sunburst, then paints it with a calibrated stroke library in headless Chrome, checkpointing every few actions, drying each checkpoint forward, judging it where it painted, and treating every rolled-back branch as a lookahead (any checkpoint, or any action inside one, can be returned to). Records a video of the whole process. Use when asked to paint something with the simulator, recreate an image in watercolor or ink, or run the painting agent.
---

# Paint from a reference

You are the painter. The tools give you a brush that behaves like the real
simulation (every stroke goes through the same bristle, water and pigment
code as a person painting in the app), a reference to paint toward, and a
checkpoint tree so you can look ahead and take back what did not work.

All commands are `node .claude/skills/paint/scripts/ink.mjs <command> ...`
from the project root (below: `ink`). A headless-Chrome daemon starts on
first use. Everything for a run lives in `paintings/<run>/`. The action
language is in [ACTIONS.md](ACTIONS.md) — read it before writing strokes.

## 1. Set up

```bash
node .claude/skills/paint/scripts/ink.mjs new <run> --medium ink|watercolor|pencil|gouache --subject "what to paint" [--paper xuan|xuanHalf|xuanSized|hot|cold|rough|bristol|drawing|toothy] [--every 6]
```

- `--every N` is the checkpoint cadence: `act` checkpoints after every N
  actions. 5–8 is a good default; use 3–4 for delicate passages (ink leaves,
  final darks) and 8–10 for broad washes.
- The printout lists the pigments, brushes with widths in mm, and tools.
  Sheet is 304.8 × 228.6 mm (landscape) — coordinates are fractions of it.

## 2. Reference

```bash
ink reference <run> --prompt "subject and composition in plain words"   # needs OPENAI_API_KEY
ink reference <run> --from some-image.png                                # or use the user's image
```

- The prompt you give is the subject/composition; the command adds the medium
  (paper, the exact palette, brush look, "flat scan, no border") and, by
  default, attaches a painting the simulator itself made as a style reference
  (images/edits endpoint). `--no-style-ref` sends a plain generation.
  `--dry-run` shows the request without sending it. `--quality` defaults to
  `high` (`xhigh`/`max` are slower and cost more).
- It writes `reference.png`, then `target.png` (cropped to the sheet, paper
  white-balanced to the simulator's paper), `target-grid.png` (with a 0.1
  coordinate grid) and `palette.png`.
- **Look at `target-grid.png`.** Regenerate (at most twice) if it is not
  paintable with this simulator: photographic detail, pen or pencil lines,
  white paint on dark, text/signatures, a frame or a photo of paper, or (for
  ink) lots of colour. Say what you changed in the prompt.
- Without an API key, tell the user it needs `OPENAI_API_KEY` in the
  environment or in `.env` at the project root; never ask them to paste it.

## 3. Study before painting

```bash
ink calibrate <run>                       # swatches: pigment × load → value on this paper (cached)
ink regions <run> --by value --levels 4   # value masses as outlines (ids v0.*, v1.* …)
ink regions <run> --by color --k 6        # colour clusters (ids c0.*, c1.* …)
```

Read `calibration.png`, `regions-value.png` and the calibration table.
Value bands are cumulative: `v0.*` is everything darker than bare paper,
`v1.*` everything darker than the next threshold, and so on — the natural
order for watercolor (paint the lightest band first; each darker band goes
on top). Region rings include holes: lights inside a shape that stay paper.

Calibrate the stroke library for this medium and paper (once; ≈15 s, kept
in `strokes/`) and look at its reference sheet — it shows every library
stroke as it really lands:

```bash
ink strokes calibrate <run>     # then read strokes/reference-<medium>-<paper>-marked.png
```

Zoom in on any region to work on it alone:

```bash
ink zoom <run> --box 0.36,0.03,0.68,0.40 [--grid 0.01] [--cp id]   # target | painting | difference, fine grid
```

It shows the region enlarged with a grid in sheet coordinates (and the box's
own u, v) and prints that region's error. Write the corrections for it in
the box's own coordinates by adding `"frame": [x0, y0, x1, y1]` to an action
(its points are then 0..1 across the box), act, and zoom again.

A wide box stacks target, painting and difference so each is large; zoom
until a stroke's width is several pixels (a 0.07-0.3 wide box for marks,
`--grid 0.01`). Work a region at a time: zoom, measure (`dL` per cell),
correct, zoom again.

On a pencil run, see where gestures will go before drawing them:

```bash
ink preview <run> batch.json [--box x0,y0,x1,y1] [--dump traj.json]   # trajectories over target | painting; end, heading, length, miss from "aim"
```

Measure where marks are instead of reading positions off the grid by eye —
eyeballed coordinates were the largest source of error in practice (several
mm to a centimetre on leaves):

```bash
ink trace <run> --box 0.55,0.45,1,1 --darker-than 45   # centrelines, widths, values of dark marks, ready as lib lines
```

Overlapping strokes merge into one piece; raise the threshold to split them
into their dark cores, and extend a core toward its paler tip by eye.

Then write `paintings/<run>/plan.md`: the value masses light → dark, what
stays bare paper, the order of passes (with where the sheet must be dry
first), and for each element the library stroke, width and value (read the
L* off the target). Keep it short; revise it as you go.

## 4. Paint: batch → checkpoint → judge → keep or go back

Write each step of the plan as a JSON list of actions (e.g.
`batches/007.json`). Prefer **library strokes** ([LIBRARY.md](LIBRARY.md)):
ask for the mark — where it starts and ends, its width in mm and value in
L* — and the library picks brush, size, pressure and load and compensates for
how the fude trails, so it lands where you asked (median error ≈0.5 mm, 7%
width, 4 L*). Raw actions ([ACTIONS.md](ACTIONS.md)) are still there for
anything the library does not cover. Give every action a `label`.

```bash
ink act <run> batches/007.json [--note "reed leaves"]
```

`act` checkpoints every N actions. Every checkpoint is dried forward, and two
things are measured:

- the **judge** (use it for decisions): only where this batch changed the
  sheet, with ~1.6 mm tolerance for misregistration — did the local error
  fall; did the new ink land on target ink at least that dark (**precision**);
  how much went darker than the target allows (**over-dark**, strict for pale
  tones); the fine-texture balance (**texture**, < 0 = smoother than the
  target); and **structure**: whether the local edges — how crisp, which way
  they run, how dense — came closer to the target's (the structure tensor at
  ≈0.8 and ≈2 mm tolerance). Tone alone rewards a soft smudge that darkens
  the right area; structure does not. Verdict **better / flawed / worse** and a
  **net** number (tone + structure, equal weight) for
  comparing alternatives, plus the same per action and, when one action did
  the damage, the **culprit**.
- the global score and **progress %** (0 = blank sheet): the trend only. It
  averages over the whole sheet, so a batch that touches 2% of it moves the
  score by noise-sized amounts — do not decide on it.

Read the eval image too (target | painting | error map: red too dark, blue too
light, magenta hue).

### Deciding

- **better** → keep going.
- **worse** → this batch was a lookahead: roll back (`ink back <run>`) and
  try it differently — lighter, thinner, drier, dry the sheet first, a
  different stroke.
- **flawed** → if a culprit is named, keep the good part: `ink checkout <run>
  <cp>@k` rebuilds the batch without action k+1 and what followed, then
  repaint that element differently. With no single culprit, roll back and
  retry.
- Compare alternatives with `ink judge <run>`: it ranks every lookahead from
  the same checkpoint by net and lists flawed checkpoints on the way here.
  Continue from the best one (`ink checkout <run> <cp>`), even one you rolled
  back from earlier.

**Rolling back works at any checkpoint** in the tree — the parent, any
ancestor, a sibling, a branch abandoned long ago — and inside one (`cp@k`).
When a problem traces to an earlier batch (darks bleeding because an earlier
wash was still wet; a shape that no later stroke can fix), go back to that
batch, not just one step.

**A lookahead is just painting forward and rolling back.** Every branch you
leave is kept as a lookahead: it stays in `ink tree` (tagged `lookahead`),
in the video, and can be resumed. `ink try <run> batch.json` does both in one
step — paint, checkpoint, judge, come back. Use it when two approaches seem
close: try each, then `judge` and continue from the better.

### Search instead of hand-tuning

When an element needs getting right (a leaf, a cap, a group of feathers),
don't write attempt after attempt: write it once and let the page try
variants. Each candidate is painted from the head, dried and scored where it
painted (≈150 ms each); the best few become lookahead checkpoints with the
full judge, and a sheet shows them beside the target:

```json
{"label": "big dark leaf",
 "base": [{"type": "dry"}, {"type": "lib", "stroke": "line", "path": [[0.78, 0.8], [0.83, 0.73], [0.9, 0.645]], "width": 6, "value": 32}],
 "n": 48, "seed": 7,
 "vary": {"shift_mm": 4, "rotate_deg": 8, "scale": 0.15, "width": 0.3, "value": 8,
          "texture": ["natural", "dry"], "speed": [250, 480], "reverse": 0.5, "taper": [0.05, 0.8],
          "taper_mm": [6, 20], "pressure": 0.15, "curve": 0.2}}
```

```bash
ink search <run> spec.json [--keep 3] [--sheet 8] [--take] [--no-dry] [--rank net|sheet]
```

- `vary` applies to every action in `base` (each gets its own draw; set
  `"together": true` to move them as one). Candidate 0 is the batch as written.
- `{"candidates": [[...], [...]], "labels": [...]}` compares explicit
  alternatives instead (e.g. two different approaches to the same passage).
- The in-page `net` is a ranking score (more forgiving than the judge, same
  ordering); the kept winners carry the real judge. `--take` checks out the
  best; otherwise head stays put and the winners are lookaheads to pick from.
- `--no-dry` scores wet (≈20 ms each) for a quick first screen of many
  variants; then search the best region again dried.
- **Look at the sheet** (`search/search-NNN.png`): it shows the leading
  candidates (all of them for an explicit list; `--sheet N`) beside the
  target. When every candidate scores badly, the sheet usually shows why: the
  mark runs the wrong way (thick end where the target is thin), or the stroke
  kind cannot make the shape. `--keep 0` searches without adding checkpoints.
- Search explores the family you give it: it moves, bends, thickens and dries
  a stroke, but if the stroke type is wrong for the shape (a line where the
  reference has a two-pointed leaf), change the type — no amount of search
  fixes that. Or search the **codebook** instead (`{"fit": {"path": [...]}}`,
  see [LIBRARY.md](LIBRARY.md)): its candidates are thousands of measured
  marks, matched to the reference's own width and value along the path, so
  the shape family comes from the reference rather than from you.
- A whole passage (or sheet), automatically: `ink codebook paint <run> --box
  x0,y0,x1,y1 [--act]`. It paints what is still **missing** (the residual:
  target reflectance over the painting's): pale masses first (mist or wash),
  then strokes level by level from the darkest (L40, 55, 68, 80), found by
  skeletonising the residual, splitting it at crossings and rejoining what runs
  straight through. Each stroke is fitted from the codebook, the codebook
  **grown** toward it (a few dozen nearby gestures painted and kept), the best
  candidate **refined** in place, and every candidate scored with ink outside
  the mark's measured outline counted against it. About 15 s per stroke; the
  reed passage (≈55 marks) took 13 min. `--grow 0 --refine 0` for a quick pass.

Speed, for planning (1024 cells, this machine): a stroke ≈25 ms, drying a
passage 0.1–0.4 s, a whole painting replayed from blank ≈3.4 s, restoring any
kept checkpoint 1 ms. 2048 cells is ≈3.5× slower.

Use scrap paper to learn or adjust a stroke without touching the painting:
`ink strokes test <run> batch.json` paints library strokes on scrap and
reports measured width/value/ends against what you asked; `ink scratch` shows
any raw batch dried. Save strokes that work: `ink strokes save`.

Note decisions (`ink note <run> <cp> "why"`): notes are the captions in the
tree and the video. Aim for batches of 3–6 actions on detail, 6–10 on broad
passes, so a bad stroke costs little.

## 5. Finish

```bash
ink finish <run>     # lets the sheet air-dry, renders final.png and final-eval.png
```

Show the user `final.png` next to `target.png` (and `final-eval.png`), and
report honestly: checkpoints made, how many were rolled back and why, the
final score against the blank-sheet score, and what still differs.

## Technique

**Watercolor** (hot/cold/rough): big light washes first with the mop or a
large flat (water 0.7+, load from calibration), wet-in-wet charges while the
wash is still damp (`wait` a few seconds, no `dry`), `dry` before any
wet-on-dry layer or hard edge, `lift` for soft lights in damp paint, darks and
details last with the round and rigger. Reserve whites by leaving them out of
washes (region holes). Tilt (`tilt y 0.3–0.6`) grades a wash downward.
Granulating pigments (ultramarine, burnt sienna, ochre) settle into the tooth.

**Texture** is not automatic: feathers, bark, reeds and hair need a
semi-dry or dry brush on *dry* paper (`"texture": "dry"` on library strokes,
a `dry` action first) — wet strokes over a damp wash always merge smooth.
Dots and blossoms are `press` actions (upright: a splayed rosette).

**Pencil** (bristol / drawing / toothy) draws by motion only: every mark is a
`gesture` (start, velocity, pushes) and path kinds are refused. Build it as a
draughtsman does — rough the whole thing first (light, loose gestures on every
outline, a second searching pass), then the definitive lines, then tone in rows
of feather flicks along the form (`repeat` with `fan`/`scale` to stay inside
the shape), layered 2B → 4B → 6B/8B, then the darks and accents; erase the
construction lines by replaying the rough gestures with the eraser (vinyl lifts
cleanly when pressed; kneaded lightens). Pencil time-lapses show the pencil, held
and moving through the air between strokes (`--no-tool` to hide it). Aim every
gesture (`aim`) and check it with `ink preview` before any graphite goes down.
See LIBRARY.md (Pencil).

**Sumi-e** (xuan): few, confident strokes; each element is one gesture and is
never retouched. Value comes from load (calibration: pine soot is steep —
roughly L78 at load 0.1, L50 at 0.25, L20 at 0.45). Raw xuan bleeds several
mm at wet edges (nijimi); drier brush (water 0.3–0.45) or sized paper for
crisp marks. `tip: true` loads dark ink on the tip over a paler belly, so one
stroke grades across its width. Paint far/pale elements first, near/dark last.

**Gouache** (`--medium gouache`, papers board / canvas / cold; use `--res 2048`):
opaque body colour. Later paint covers earlier paint as far as its own hiding
power allows, so you can paint light over dark and fix mistakes by painting
over them. Wet paint blends with the next stroke and is picked up by a nearly
empty brush; it dries in about 45 s (thin films sooner), and dry paint is
permanent. Brushes: flat, filbert (rounded flat, the workhorse), round,
rigger. On a gesture, `"color": "#rrggbb"` mixes that colour from the tubes
(`paintmix.mjs`, Kubelka–Munk; it warns when a colour is out of reach), `load`
is how much paint the brush picks up, `water` thins it, `marble` how loosely it
is mixed (streaks), `flatAngle` turns a flat or filbert (radians, sim y up).
The palette has no black: ultramarine with burnt sienna, or crimson with
phthalo green, make the darks. The judge works on colour difference (ΔE) and
the score does not penalise too-dark (it can be painted over).

Work big to small with the stroke planner, one pass per brush:

```bash
python3 .claude/skills/paint/scripts/paintplan.py paintings/<run> spec.json batch.json --render <head dry png> --preview plan.png
```

It starts a stroke wherever the painting is still off by `threshold` ΔE, in
the reference's colour averaged over the brush's footprint, and carries it
along the forms for as long as that colour helps; strokes are pooled into
palette mixes (`mix_tol` ΔE) and laid dark to light. Options: `box`,
`px_per_mm` (finer for small brushes), `regions` (polygons in a roles file:
`use` or `avoid`; strokes stop at the edge, so a subject is cut in cleanly;
`masksnap.py` snaps a rough outline to the reference), `only` (darker or
lighter accents), `dry_first`, `pause_s` between mixes, and `dry_between`
for accents that must not smear into wet paint. What worked on the robins
(robin-3): background with a 1" flat avoiding the subject (no pauses, so it
blends), a 5/8" filbert, then the subject's masses and forms inside its
outline, then rounds No. 8 → No. 2 everywhere, then the head, darks and lights
with `dry_between`. For economy, `"select": "greedy"` with a `budget` per pass picks the
stroke that takes the most error off the sheet each time (in the colour that
fits its whole footprint) and stops when strokes stop paying (`min_gain`);
`trace_tol` lets strokes run longer through similar colour. robin-4 used
1,204 strokes (budgets 100 / 120 / 250 / 200 / 300 / 200 / 60 from a 1" flat
down to a No. 2 round) against robin-3's 14,541, at score 5.4 vs 3.1.
Better still (robin-6: 1,022 strokes, score 5.06): `paintmulti.py` puts
every brush's candidate strokes in one pool and lays whichever takes the most
error off next, scored against the reference as the score sees it, weighted
by where people look (`weights`) and doubled on bare board; run it in closed
loop with `runmulti.sh <run> <spec> <batches>` (60 strokes a batch, each
planned from the real painting). The planner's widths and the brush's lag at
both ends of a stroke are calibrated (paintplan.py `mark_width`, `LAG`).
Best so far (robin-7: 1,017 strokes, score 4.87): a salience map from a
segmentation of the reference (ask the image model to repaint it with each
part in a flat colour: eye, beak, head, throat, breast, wing, legs, buds,
branch, background; `salience.py` turns that into weights, `"salience":
"salience.png"` in the paintmulti spec), so the price of a stroke is lower
where people look. Every three batches, step back: look at the painting next
to the reference and decide where extra strokes are worth it (a `box` batch at
higher `px_per_mm` and a lower `min_gain` for the head or wing) and where to
stay lazy (background). Paint the eye last, or later strokes dull it.
Zoom levels (robin-8: 3,450 strokes, score 3.98, the best face and wing):
tone the board with one thin wash first; then `runmulti.sh <run> L0` (whole
sheet, 3 px/mm) until nothing is worth its price; then `runlevel.sh <run>
<level> <tiles> <batches>` for level 1 (regions, 5 px/mm), 2 (parts from the
segmentation: head, wing, legs, each bud, the branch; 8 px/mm) and 3 (eye,
beak; 12 px/mm). `levels.py` picks the tiles with the most salience-weighted
error left; each level's spec (plans/L1..L3.json) lowers the price and adds
`lines` (thin dark and light lines traced in the reference, `linecands.py`):
that is what finally painted the wing's pale feather edges.
Eyes and other single touches are best aimed by hand as a
gesture or two and checked with `ink preview` first: `dabs.py` (automatic
blob accents) made marks far too big.

Display only (no replay needed): `ink dump <run> [cp]` saves a checkpoint's
state; `ink view <run> <cp> --width 2400 [--set impasto=2,furrow=0.4]` renders
it with the current display code; `ink resume <run> [cp]` continues painting
from a dump without a replay (when only display code changed).

**Time-lapses with zooms.** Fastest: turn recording on before painting (`ink
record <run> on --every 6`); batches run by runmulti.sh/runlevel.sh pass their
zoom box to `act`, so the camera moves in while it paints and every checkpoint
keeps its `zoom`; end with `ink camera <run> full` (a pull-back), then `ink
timelapse <run> --recorded --seconds 80` builds the video from those frames in
a minute, leaving out rolled-back batches. For a run painted without
recording: `ink timelapse <run> --zoom --frames 2500` replays it with the camera
following each checkpoint's `zoom` (and records only about as many frames as
the video needs). Leaving a close-up cuts straight back to the whole sheet;
going into one waits a random 4–20 frames of the brush at work first (`--lag
4,20 --seed 7`), as a painter steps back to look at the whole for a moment.
`--sparse-every 100000` leaves out drying and waiting, so the brush moves in
every frame.

**To a song.** `--total 109.207` makes the video exactly that long: the
painting is paced into it and the last hold takes up the rest. Audio Suno
gives as Opus-in-m4a (afconvert and AVFoundation can't read it): `node
scripts/decode-audio.mjs song.m4a song.wav` decodes it in the daemon's Chrome,
`afconvert -f m4af -d aac -b 256000 song.wav song-aac.m4a`, then
`paintings/.ink/bin/mux video.mp4 song-aac.m4a out.mp4` (from `scripts/mux.swift`)
joins them, refusing if the lengths differ by more than 0.05 s: nothing is
ever trimmed.

**Signing.** A signature is one practised motion, recorded once and replayed:
`scripts/signature.py IMAGE SPEC.json OUT.json [--preview P.png]` traces an
image of a signature from waypoints given in writing order (the trace follows
the darkest ink between them), takes pressure from the ink's width and timing
from the two-thirds power law, and writes gestures whose pushes are solved all
at once with a jerk penalty (`smooth`, default 3e-4; 1e-3 for a fluid hand:
smoothness matters more than hitting the trace). A signature must look
practised: one brush, the capital, one short lift, then the whole name and
its flourish in one unbroken stroke, fast (~240 mm/s, about a second), entering
and leaving in motion (`ease: [0.85, 6]`, `entry_mm`, `exit_mm` for the hairline
flick), with heavier downstrokes (`rhythm`). A fude holds enough paint for it on
one load; a No. 2 round runs dry, a rigger smears in the turns, and splitting
the name to reload shows at every restart. At speed, lower `smooth` (8e-5) or
the letters flatten into waves. `ink strokes save <run> claude-signature OUT.json
--from x,y --to x,y` (the baseline) marks a recipe made only of gestures as a
recorded motion, which runs that draw by motion accept: `{"type": "lib",
"stroke": "saved:claude-signature", "from": [x, y], "to": [x, y]}` signs any
painting, moved and scaled onto that baseline with the same timing. Claude's is
saved (paintings/signature/sig-v2-spec.json; 64 mm wide in the bottom-left
corner of robin-8). For the video, sign with recording on (`ink record <run>
on --every 2`, `act ... --zoom-box ... --lag 2,3`) and play those frames one
output frame each (`"nframes": 1` in the manifest): smooth, real time;
`--realtime last` does the same from a replay; `--append
actions.json --append-zoom box` adds actions after the chain as one more
checkpoint (replays are exact), so the video can render while the run's own
page is still being rebuilt to commit them.

**Title cards.** `scripts/lettering.py IMAGE SPEC.json --width-mm 220 --at
0.5,0.47 --size 2 --pigments '{...}'` traces an image of brush lettering
automatically (skeleton, spurs pruned, strokes followed through junctions,
nearly-meeting ends joined, missed centreline painted too, reading order) into
a spec for signature.py. For a dark ground, paint the board off camera first
(robin-8's tone.json gestures with a crimson + phthalo black, three coats), then
`ink record <run> on` and act the lettering. To put it before a time-lapse,
merge the two frame manifests into one directory; a manifest entry with
`"hold": 2.0` is held that many seconds outside the pacing (the clean title).
video.py never crossfades: hard steps only.

## Recording a video

```bash
ink record <run> on [--every 2]   # before painting: frames (with the brush) are saved on every act
ink video <run>                   # after finish: paintings/<run>/<run>.mp4
```

The video plays every batch in order — including the ones later rolled back —
with a card at each checkpoint (dry preview, error map, judge, verdict), a
banner wherever a lookahead is rolled back (with the note you wrote), a
running score chart and the final painting beside the reference. Write clear `note`s: they are the captions.
`--speed 2` halves the painting time-lapse; `--hold 0.6` shortens the cards.

## Housekeeping

- `ink tree <run>`, `ink show <run> [cp]`, `ink status <run>`, `ink list`.
- `ink verify <run>` checks that replaying the run from blank reproduces the
  head exactly (it should; the page keeps the latest 32 checkpoints on the GPU
  and rebuilds older ones by replay).
- If the simulation code changes mid-run, replays warn that they may differ.
- `ink stop` shuts the daemon down (log: `paintings/.ink/daemon.log`).
