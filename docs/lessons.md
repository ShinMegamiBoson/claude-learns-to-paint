# Tips and tricks

What worked, what didn't, and the evidence, from building a paint simulator and an agent that learned to use it. The numbers come from the run records in [`paintings/`](../paintings/). Scores are error against the reference, so lower is closer, and they only compare within one medium.

## The agent loop

- **Give the agent a mind's eye.** A reference image made in the simulator's own medium (gpt-image-2.5, with a sim-painted style sample attached) gives every checkpoint something concrete to be scored against.
- **Checkpoint often, roll back freely, keep the branches.** Every few actions, save a checkpoint and judge it. A rolled-back branch is a lookahead you can return to. Rollback should reach any checkpoint, or a single action inside one.
- **Make replay deterministic.** A seeded random generator and a virtual clock make every run replay exactly. Then a run's record is the painting, and anything (a new render style, a time-lapse, a camera move) can be regenerated from it. Record the code version in each run, because a replay drifts when the code changes.
- **Make trying cheap.** Restoring a checkpoint took 1 ms and scoring a candidate in the page took 18 to 131 ms. That turned lookahead from a few hand tries into searches over dozens of painted variants per mark, and 7,165 candidates for one ink heron.

## The judge decides what gets kept, so keep fixing the judge

- **A global score drowns small changes.** Judge only where a batch painted: error within a tolerance, over-darkening, precision, texture. Blame individual actions. The first run's keep/reject calls make a good test set for a new judge; the local judge flagged all 12.
- **Every scorer has blind spots, and the agent will find them.** A darkness-only score rewarded pale smudges, so outline and structure terms went in. Tone compared patch by patch pulled a pencil drawing toward smudge. For opaque paint, use colour distance and don't penalize too-dark, since it can be painted over.
- **The judge is not the eye.** A readable eye, a reflection without regular chevrons, fine reeds a millimetre off, a signature: all were marked worse and kept on purpose. Override with a stated reason, and treat any override as a hint that the score needs work.

## Calibrate your tools before blaming the simulator

- **Ask whose fault it is.** In the first ink painting, 18 of 36 checkpoints were rolled back, and most of that came from misjudging how the brush turns a path into a mark. The simulator was rarely the problem.
- **Measure what each brush really does.** Paint calibration sheets (brush × size × pressure, pigment × load), measure them, and compile requests like "a 4 mm mark at lightness 60 here" into brush moves. A closed loop (paint a verify sheet, measure, correct) took the ink library's median miss from 0.5 mm / 3.8 L* to 0.16 mm / 0.5 L*.
- **Check the planner's prediction against what got painted.** Gouache filberts painted about 40% wider than modelled, and strokes started about 2 mm late and ended 1 to 4 mm early. A width model plus lag compensation raised the smallest brush's coverage from a third to two thirds.
- **Read positions from the reference, not by eye.** Hand-placed coordinates were 5 to 10 mm off. Tracing marks from the reference fixed it.

## Measure before fixing

- Stripes in watercolor strokes had five separate causes, found with a spectral test. The worst was the demo script itself, which spaced its passes exactly. Another was a pigment deposit tied to frame rate: a 120 Hz screen laid 1.8× more paint than 60 Hz.
- "Why aren't the results better?" had a measurable answer. The traced strokes covered only 22% of the visible ink in the reed passage, and the nearest codebook marks were 1.5 to 3.6 times farther off than marks sit from each other. Painting accuracy itself was fine.

## Drawing like a hand

- **The machine look comes from uniformity, not position.** A minimum-jerk speed profile and the two-thirds power law (slower in tight curves), lines that swell and thin, and hatching in bursts of 5 to 9 strokes with jittered angles: these mattered more than placement.
- **Constrain the action space.** Once paths were forbidden and every mark had to be a gesture (start, velocity, pushes), the aiming tools followed: a preview that traces gestures without drawing, aim points that report the miss, and steering one push at a time from the start of the stroke. The motion-only heron also scored better (6.16 → 5.20).
- **Press the way the reference asks.** Tone-following pressure (harder where the reference is darker, lighter where the drawing is already dark enough) was the biggest single improvement across the pencil herons.
- **Run strokes along the grain, as a guide rather than a rail.** An orientation field read from the reference took one pass from 9.04 to 6.55. Welding strokes to it left blank seams: faded stroke ends piled up exactly at outlines. Steering gently with momentum and a turn limit removed the seams by construction.
- **Lift instead of adding.** A kneaded-eraser lift only where the drawing was too dark gave the biggest single gain on a portrait (to too-dark zero). Close-up "detail" passes were rolled back every time.
- **Build tone in light layers.** One layer of flicks only reaches about lightness 85, so lay several, each computed against the drawing as it stands. Batching layers together made each compute against blank paper and tripled the darkness.

## Painting with an economy of strokes

- **Charge a price per stroke.** A greedy planner that picks the single stroke removing the most remaining error, with a budget and a minimum gain, took the robins from 14,541 strokes to about 1,000. The marginal gains show the diminishing returns: background error fell from 34.9 to 17.1 in the first 25 strokes, and only to 10.3 after 102.
- **Put every brush in one pool.** Fixed budgets per brush waste strokes. Let all brushes propose candidates and let the best gain win.
- **Spend effort where people look.** Segment the reference into parts and weight them (eye 8, beak 6, head 4 … background 1). In robin 7 the head got 12% of the strokes for 2.7% of the area, and beat the unweighted run at every stroke count.
- **Zoom in with levels.** Go from the whole sheet to regions to parts to features, each finer (3 → 5 → 8 → 12 px/mm) and with a lower price per stroke. Add a stroke type that traces thin dark and light lines from the reference. That finally painted the pale feather edges the generic candidates never could.
- **Paint the eye last, by hand.** Later strokes dull it, and automatic accents came out far too big. One small-filbert touch plus a catchlight read best.
- **Re-render instead of repainting.** Keep physics and display separate. A finished painting's saved state can be re-rendered with new bristle furrows, impasto and board grain without changing a stroke.

## A signature that looks practised

- A signature is one practised motion. Record it once and replay it, moved and scaled onto a baseline. The time stays the same at any size, as it does for people.
- Exact tracing made the hand buzz: the pushes flipped direction 43% of the time. Solve all pushes together with a jerk penalty, or take the minimum-jerk path through the letters' turning points.
- Make it fast (about 1 s at roughly 240 mm/s), with almost no pen lifts, entering and leaving in motion, and heavier downstrokes. Use one brush that holds enough paint for the whole name on one load (here a fude). Expect a fast hand to round small loops; that's what signatures do.

## Making time-lapses

- **Record while painting.** An unrecorded run has to be re-simulated to make a video. Here that meant 57,000 frames of brush time, about 25 minutes.
- **Size the frame spacing from the brush time** (sim frames ÷ frames wanted), never by guess.
- **Cut, don't pan, for zooms.** Before cutting to a close-up, hold the whole sheet for a few frames while the brush is already working, like a painter stepping back to look.
- **No crossfades once the brush is in the frame.** A blended frame shows two half-transparent brushes.
- **Show writing in stop-motion "on twos"** (each frame held for two). Signing reads better smooth and in real time.
- **Match the video to the song exactly, and never trim the audio.** Pace the painting into the exact length and let the final hold absorb the rest. Suno exports Opus inside .m4a, which macOS tools can't decode; headless Chrome's WebAudio can (`scripts/decode-audio.mjs`).
- **Replay in small slices.** Headless pages free memory only when a call returns, so long replays crash unless they run a few actions per call.
