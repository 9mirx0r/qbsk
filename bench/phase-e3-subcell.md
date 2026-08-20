# an earlier release — subcell resolution

Measured on August 18, 2026, on the same Windows 11 machine and in one session.

This stage is judged by pictures, not by milliseconds: it adds drawing-time helpers, not a
per-frame cost, so there is no A/B to run against a previous commit. Four of its five
closing criteria are visual or structural and are pinned by tests and a golden. The one
number it does owe is braille's.

## Criterion 4 — a braille plot of 100 points costs under 0.1 ms

```powershell
node bench-script.mjs   # 200 warm-up runs, then 500 timed, both shapes
```

The cost is isolated by timing an identical loop that does everything except call
`braille`, and subtracting:

| | ms per run |
|---|---:|
| whole program, 100 points drawn | 0.1193 |
| same loop, no dots drawn | 0.0423 |
| **the 100 braille points** | **0.0770** |

Under the 0.1 ms budget. The subtraction matters: at this size the interpreter's loop
overhead is more than a third of the total, so a figure quoted without it would be
measuring `while` rather than braille.

`tests/unit/subcell-natives.test.ts` also pins the order of magnitude in the suite, with a
deliberately loose bound — a threshold tight enough to be interesting is a threshold that
fails on a loaded machine, which `bench/baseline.md` §13.1 is emphatic about.

## Criterion 3 — the aspect correction, asserted rather than eyeballed

A character cell is about one wide and two tall. Splitting it horizontally makes each
subpixel about square, so a circle plotted with **one radius on both axes** must come out
spanning twice as many cells across as down. For R = 8, measured from the rendered canvas:

```text
width  = 17 cells   (2R + 1)
height =  9 cells   (R + 1)
ratio  ≈ 1.89
```

The test asserts the two extents exactly, not just their ratio, so a change that scaled
both would still fail.

## Criteria 1, 2 and 5

- **1** — `examples/subcell.qbsk` draws the same circle and the same sine twice, at one
  glyph per cell and at one subpixel per half cell, in one scene.
  `tests/golden/subcell.qbsk.out` pins it byte for byte, and a second test asserts all
  three alphabets are present (`#`, half blocks, braille) so the comparison cannot quietly
  become a comparison of nothing.
- **2** — two subpixels of different colours in one cell produce `▀` with fg = top and
  bg = bottom, tested in the pure module and again end to end through the native.
- **5** — `plot` and `braille` are registered, specced in `docs/engine.md` §11.14, joined
  to the frozen surface deliberately (77 → 79 in `v01-surface.test.ts` and
  `docs/language.md` §17.1), and `docs-truth.test.ts` is green.

## Deliberately left out

- **Quadrants (`▘▝▖▗▚▞▙▟`), and the reason is geometric rather than budgetary.** The phase
  document proposed them as a fallback "when a cell needs a 2x2 split". In a half-block
  system no cell ever needs one: two subpixels have four states and all four have a glyph.
  A 2x2 split is not a fallback but a different trade — twice the horizontal resolution,
  the square pixel given up, because a quarter of a 1x2 cell is 0.5 x 1 and exactly as
  lopsided as the cell was. Square pixels are the entire visual win here, so that trade
  belongs to a caller who asks for it, not to a silent fallback. None of E3's five closing
  criteria name quadrants; its two-colour criterion is the half-block `▀` case.
- **No capability detection.** The glyphs require a Unicode font. Windows Terminal with
  Cascadia has them, `cmd.exe` with a raster font does not. Documented as a contract, the
  same one the box-drawing characters have carried since the first golden.
- **No anti-aliasing and no coverage-weighted glyph choice.** A subpixel is lit or it is
  not. Weighting by coverage needs the measured ramp table, which is E4.
- **`plot` does not read the ramp.** It draws blocks, not densities; `glyph()` remains the
  way to turn an intensity into a character.
