# an earlier release — the measured density ramp

Measured on August 18, 2026. Like E3 and E5 this stage is judged by what it produces
rather than by milliseconds; the number it owes is the coverage table itself.

## The pixel source, and why it took a detour

The stage plan assumed a font-rendered PNG strip would be available as an input. It was
not producible inside the repository: the vendored `unifont-17.0.05.otf` carries CFF
outlines and **no bitmap table** (`CFF GPOS GSUB OS/2 cmap head hhea hmtx maxp name post`
— no EBDT/CBDT/sbix), Node has no canvas, and rasterising CFF is precisely the glyph
rasteriser this phase forbids under the zero-dependency rule.

So the strip came from outside, once: a screenshot of the glyphs echoed in a terminal,
committed as `bench/ramp-strip.png` so the measurement is reproducible rather than a
claim about a lost file.

Two things had to be solved before it could be measured, and both are in the tool now:

- **The shell echoed its own quotes.** `echo "█ .:-=+*#%@█"` in `cmd.exe` prints the
  quotation marks too, so inked glyphs sit *outside* the intended frame. Trimming to ink
  bounds would have landed inside the quote cells — a quote inks a sliver of its cell —
  and misaligned every glyph after it. `--markers` looks for **near-solid columns**
  instead: a full block is the only glyph inked its whole height, so the two blocks are
  found regardless of what surrounds them.
- **Both lines of the screenshot contain the sequence** (the command line and its echo),
  so `--rows` selects the band to measure.

The frame came out at **9.00 px per cell exactly**, which is the check that the markers
were found in the right place — a fractional result means they were not, and a test
asserts the width divides evenly.

## The measurement

```powershell
node bench/measure-ramp.mjs --png bench/ramp-strip.png --glyphs " .:-=+*#%@" `
  --markers --light-on-dark --rows 26:44 --out examples/res/ramp.qbdata
```

| glyph | raw | normalised |
|---|---:|---:|
| ` ` | 0.0471 | 0.0000 |
| `.` | 0.0675 | 0.0761 |
| `:` | 0.0880 | 0.1521 |
| `-` | 0.1039 | 0.2113 |
| `+` | 0.1504 | 0.3839 |
| `=` | 0.1608 | 0.4225 |
| `*` | 0.1651 | 0.4386 |
| `%` | 0.2515 | 0.7593 |
| `#` | 0.2528 | 0.7642 |
| `@` | 0.3163 | 1.0000 |

```text
hardcoded ramp: " .:-=+*#%@"
measured ramp : " .:-+=*%#@"
```

## Criterion 2 — the order differs, and one of the two differences is honest about itself

The hand-written ramp gets **two pairs backwards**:

- **`=` before `+`.** Measured, `+` is lighter (0.3839 vs 0.4225) — a gap of 3.9% of the
  range, comfortably outside anything the rendering could be blamed for. This is a real
  correction.
- **`#` before `%`.** Measured, `%` is lighter (0.7593 vs 0.7642) — a gap of **0.5%**.
  That is a genuine ordering in this font at this size, and it is also small enough that
  swapping the two changes almost nothing on screen. It is reported at its true size
  rather than dressed up: one of these two findings matters and one is a tie broken by a
  hair.

The brief's warning — *if the measured order matches the hand-written guess, suspect the
measurement* — did not have to be invoked. It stays in the tool anyway, which prints both
ramps, diffs them, and says so out loud when they agree.

## Criterion 5 — determinism

Regenerating the table from the same PNG produces a byte-identical file, verified by
running the tool twice and diffing. A test re-measures the committed strip from scratch
and asserts it reproduces the committed table's ramp, so the image and the table cannot
drift apart.

## What the pipeline is checked against

`--selftest` measures a synthetic strip built at 0, ¼, ½, ¾ and 1 coverage and reports
those numbers exactly. Arithmetic knows the answer in advance there, so agreement means
the measurement measures what it claims rather than merely agreeing with a guess. That
check is the stage's second criterion in its rigorous form, and it runs independently of
any font.

## Deliberately left out

- **`DENSITY_RAMP` does not move.** The measured table is an addition; every existing
  golden renders through the old default, untouched. Swapping the engine's default to
  match one terminal's font would be wrong for every other terminal.
- **One font, one size, one renderer.** This table describes the strip it was measured
  from. That is exactly why it ships as swappable `.qbdata` a program `use`s rather than
  as constants in the engine — a ramp measured from Cascadia is wrong for Iosevka.
- **No automatic candidate search.** The tool measures the glyphs it is given; choosing a
  better candidate set is a person's judgement about what reads well.
- **No subpixel or gamma modelling.** Coverage is mean linear-ish luma over the cell.
  Modelling display gamma would change the numbers and not their order, which is what a
  ramp uses.
