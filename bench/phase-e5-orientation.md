# an earlier release — orientation glyphs

Measured on August 18, 2026. Like E3, this stage is judged by pictures and by
boundaries, not by milliseconds: it changes which character a line draws, not how often
anything runs. There is no A/B to report, and none is invented to fill the space.

## Criterion 1 — the difference is in the bytes

`examples/orientation.qbsk` draws one figure twice: the left half with `line` as it has
always behaved, the right half with `style: stroke`. Comparing the halves of
`tests/golden/orientation.qbsk.out` column by column:

```text
cells where the halves disagree: 91 of 92 inked
glyphs present: * ╱ ╲ │ ─
```

The stage asked for the difference to be visible in the golden diff itself rather than
claimed. It is 99% of the inked area. A test asserts the ratio stays above 0.9 and that
all four orientation glyphs plus the untouched `*` appear, so the example cannot decay
into a comparison of nothing.

## Criterion 2 — the angle rule, at its boundaries

`tests/unit/stroke.test.ts` pins the thresholds by constructing directions whose
corrected `|cos|` sits either side of each one and checking the glyph flips exactly
there: `> 0.87` horizontal, `< 0.32` vertical, quadrant signs between.

**The aspect correction is checked rather than asserted.** The claim in §11.16 is that
without doubling `dy` a two-across-one-down step reads as horizontal, and the test
computes both angles to prove it:

```text
uncorrected |cos(atan2(1, 2))| ≈ 0.894   →  over 0.87, would draw ─
corrected   |cos(atan2(2, 2))| ≈ 0.707   →  diagonal, which is what 45° on screen is
```

The one-across-one-down case is pinned too, precisely because it comes out diagonal with
or without the correction — it is the case that would let someone delete the `* 2.0` and
watch the suite stay green.

## Criterion 3 — the old default is untouched

`line` with no `style:` draws the `*` it always drew. All 21 pre-existing goldens pass
byte-identical, and a test states the case directly rather than relying on their silence.
The style set is closed in the parser, like `border`'s: an unknown name reports with a
suggestion instead of falling through to a default that would draw something looking
deliberate.

## Criterion 4 — Sobel proves itself offline

`spriteEdgeGlyphs` in `src/tools/spriteGen.ts` runs Sobel over a sprite's filled mask and
emits the glyph running **along** each edge. A gradient points across an edge, so the
`(-gy, gx)` rotation is where this inverts if it is going to; the test builds diagonals
whose direction is known before measurement and asserts `╲` and `╱` at their centres,
then runs the whole thing over a real generated sprite and checks every emitted character
is one of the four.

## Criterion 5 — spec before code, docs-truth green

§11.16 was written before `src/engine/stroke.ts` existed. `stroke_glyph` joins the frozen
surface deliberately: 79 → 80 in `v01-surface.test.ts` and `docs/language.md` §17.1.

## Deliberately left out

- **No runtime Sobel, ever.** At run time this engine has no pixel source, and a native
  that sampled one would be inventing its input — invariant I2. §11.15 draws the same
  line for the same reason.
- **`line` picks one glyph for the whole line, not one per cell.** A straight line has one
  direction; Bresenham's steps wobble around the true slope, and glyphs chosen from that
  wobble would flicker between two characters along a single edge.
- **No orientation in the ramp.** `glyph()` still answers "how much", and these answer
  "which way". Combining them into one call was considered and dropped: they are
  independent questions and a caller may want either alone.
- **No curve fitting.** A polyline gets a glyph per segment; smoothing across joins would
  need to know the shape, which is the caller's business.
