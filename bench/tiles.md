# QBSK — tileset lookup workload

an earlier release (C1) criterion 1: **measure before designing.** The question was where a tile
lookup should happen in the paint pipeline. A tileset renderer paints an image for a cell
that has a tile and falls back to the character otherwise, and a 120x40 grid is 4800 cells
— so the obvious concern is that "resolve every cell every frame" eats the frame budget.

Two candidate designs:

| | resolution scope | cost scales with |
|---|---|---|
| **full-grid** | every cell, every frame (4800 lookups) | grid area |
| **diff-ride** | only the cells the diff reported as changed | changed cells |

The DOM painter already patches exactly the cells the diff reported (`paint.ts`), so the
diff-ride lookup rides the same list and adds nothing to the painter's work.

## Measurement environment

| | |
|---|---|
| Date | August 8, 2026 |
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.19.0 |
| Command | `node bench/tiles.mjs 120 40 300` |

The workload is a real animated 120x40 scene (moving ball + static walls + HUD text)
stepped through `SceneProgram` and diffed with `computeDiff` — the same pipeline the
Studio window runs. The tileset maps every drawn glyph, which is the worst case for both
designs.

## Result

```
QBSK tileset workload — 120x40, 300 frames, both designs

  design      | ms/frame | % of budget | lookups/frame
  ------------+----------+-------------+--------------
  full-grid   | 0.0528 |     2.64%  | 4800
  diff-ride   | 0.0013 |     0.06%  | 18.0

  changed cells/frame: 17.99 of 4800
  16.6 ms is one frame at 60 fps; the 2 ms budget is the whole-frame CPU line.
```

> **The absolute figures move between runs; the ratio does not.** Re-running this script
> on the same machine and Node build produced `0.1581` / `0.0031` — three times higher,
> both columns, with the same ~50× gap and the same 18-of-4800 lookup count. So read the
> **ratio and the lookup count** as the finding here, not the milliseconds: they are what
> the decision rests on and what reproduces. `bench/baseline.md` exists so that
> performance claims are numbers rather than opinions, and a number that does not
> reproduce should say so rather than be quietly trusted.

## The decision

**The tile lookup rides the diff.** It scales with what a scene actually repaints
(≈18 cells/frame here) rather than with its area, and either way it lands far under the
2 ms whole-frame budget. The full-grid pass is roughly **40–50× the work for the same
result**: a lookup on a cell that did not change cannot change the output, because the
tile for that cell was already painted when it last changed.

The whole point of diffing (docs/engine.md §5) is that an unchanged frame costs zero; a
tileset must inherit that property, not lose it. A full-grid resolution every frame would
be the "clear the screen every frame" anti-pattern in lookup form — a constant tax paid
even when nothing moved.

## When to revisit

Re-run `node bench/tiles.mjs` if a scene ever repaints most of the grid every frame (a
flickering full-screen effect). At that point diff-ride and full-grid converge on the same
cost, but so does the text path — a scene that repaints everything is paying the whole
grid in the diff itself, and the lookup is then irrelevant next to the script cost.
