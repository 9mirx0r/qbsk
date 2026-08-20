# QBSK — Performance baseline

Frozen reference point **before** starting an earlier release of the roadmap
(`the roadmap`, item 0.2). Any future measurement is
compared against this. A regression on these numbers is a red PR (RULE #3).

## Measurement environment

| | |
|---|---|
| Date | August 6, 2026 |
| Commit | `a0a5494` (versioned initial state) |
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.19.0 |
| Shell | PowerShell 5.1 |
| Command | `node dist/cli/main.js profile examples/bounce.qbsk --frames 300` |

## Result

```
frames: 300  updates: 299  target: 60 fps
avg fps: 60.1  p99: 32.0
cells/frame: 2.98  bytes/frame: 17.1
ms/frame — script: 0.885  compose: 0.001  diff: 0.015  emit: 0.020
```

| Metric | Value | Budget | Margin |
|---|---|---|---|
| avg fps | 60.1 | 60 | on target |
| **p99 fps** | **32.0** | — | **see note** |
| script | 0.885 ms | 2 ms/frame total | ×2.3 |
| compose | 0.001 ms | | |
| diff | 0.015 ms | | |
| emit | 0.020 ms | | |
| **total CPU** | **0.921 ms** | **2 ms** | **×2.2** |
| cells/frame | 2.98 | | |
| bytes/frame | 17.1 | | |

## Reading

1. **The interpreter is 96% of the per-frame cost** (0.885 of 0.921 ms). `diff` + `emit`
   together are 0.035 ms — 3.8%. Confirms answer 3 of the review
   (`the roadmap` §5): if optimization is ever needed, it is the
   interpreter, not `render.ts`. **Do not touch the diffing heuristic** — that would be
   premature optimization on 3.8% of the budget.

2. **The p99 of 32.0 fps is the number to watch.** The review measured p99 56.6 on a Linux
   sandbox; here, on Windows, it gives 32.0 with the same scene. The difference is
   environmental (Windows scheduler + OneDrive syncing the folder during the measurement),
   not the code — the avg fps and the ms/frame match in shape what was reviewed. Even
   so, this is the honest value for Windows and it is the one to use as the local
   reference: if a future change lowers the p99 **in this same environment**, it is a
   real regression.

3. **Real margin ×2.2 over the 2 ms budget** with `bounce.qbsk` (~3 primitives).
   The review estimated ×6-7 on Linux; on Windows the margin is tighter. The review's
   synthetic scenes (320 and 2000 primitives) were not re-run here — when an earlier release starts
   it is worth regenerating them on Windows before deciding anything about performance.

## How to reproduce

```bash
npm run build
node dist/cli/main.js profile examples/bounce.qbsk --frames 300
```

---

## Addendum (2026-08-07): absolute ms are not comparable across sessions

an earlier release nearly produced a false alarm, and the lesson is worth more than the numbers.

`bench/phase13-persistent.md` recorded **script 0.735 ms/frame**. Measuring the same
scene after an earlier release gave **~1.02 ms** — consistently, across three runs. That reads as a
38% regression.

It is not one. Checking out **the earlier commit itself** (`fc9cb35`) into a clean
worktree and profiling it on this machine, that same day, gave **~0.975 ms**. The code
that once measured 0.735 now measures 0.975. Nothing regressed; the machine did.

**Therefore:**

1. **Never gate on a number recorded in an earlier session.** Background load, thermal
   state and OneDrive syncing move these figures by 25% or more on this hardware. The
   0.885 in this file is a *shape* reference, not a threshold.
2. **Compare A/B back to back**, in one sitting, ideally by checking the older commit out
   into a worktree and profiling both within minutes of each other. That is the only
   comparison that isolates the code.
3. The **ratios** in this file remain trustworthy — the interpreter dominating the frame,
   `diff` + `emit` being a rounding error next to it. Those held at every measurement.

an earlier release was verified this way and introduced no measurable cost, which is expected:
`bounce.qbsk` uses no tweens, and the tween store is only touched when `animate` is called.

---

## Addendum (2026-08-14): the gate that could not fail, and the 2.4× it hid

`npm run bench` was two lines — it printed "no benchmarks yet (milestone M14)" and exited
0 — while six real benchmarks sat in this directory unrun and this file's numbers came
from a command the runner never called. RULE #3 asked for the benchmarks green before a
milestone closed, and that gate reported green without measuring anything.

What it cost, measured the day it was fixed. L10 changed `evalDslExpr` to stop using an
exception to ask whether a bare word is a colour name (`examples/main_menu.qbsk` was
building **121,471 error objects per run** that way):

| | before | after | |
|---|---|---|---|
| script | 0.885 ms | **0.373 ms** | ×2.4 faster |
| total CPU | 0.921 ms | **0.393 ms** | ×2.3 faster |
| whole test suite | 62.6 s | **7.75 s** | |

`npm run bench` reported **nothing**, in either direction. It would have hidden a 2.4×
*slowdown* exactly as well — which is the real point, and why a gate that cannot fail is
worse than no gate at all.

The runner now runs the reference profile plus every read-only benchmark, and its exit
code answers the question a machine can honestly answer — *did every benchmark still
run?* — rather than pretending to judge absolute milliseconds, which the addendum above
already proved unreliable across sessions. See `docs/engine.md` §13.1.

The ratios held again, as they always have: **interpreter 94.9%, diff + emit 4.8%.** The
interpreter got 2.4× faster and it is still where essentially the whole frame goes.

---

## Addendum (2026-08-19): an earlier release, and why this file is the wrong place to read it

F6 compiled the interpreter's tree walk into a tree of closures (`the roadmap`,
rungs 5–7). On a 100,000-iteration arithmetic loop it is **331× → ~107× of plain JS, 48 ms →
15.4 ms** — just over 3×.

**`bounce.qbsk` does not move at all.** Measured across the whole stage, alternating in
one sitting, `profile … --frames 120`:

| program | pre-F6 (`0cf0ee0`) | F6 done (`8700bad`) | change |
|---|---|---|---|
| `main_menu.qbsk` | 4.035 / 3.955 ms | **3.520 / 3.548 ms** | ~11% faster |
| `first_person.qbsk` | 1.030 / 1.018 ms | **0.804 / 0.848 ms** | ~19% faster |
| `cell_block.qbsk` | 0.900 / 0.948 ms | **0.779 / 0.798 ms** | ~15% faster |
| `caves.qbsk` | 0.431 / 0.455 ms | 0.433 / 0.403 ms | inside the noise |
| `bounce.qbsk` | 1.590 / 1.578 ms | 1.596 / 1.589 ms | **none** |

A program gains from F6 in proportion to how much of its time it spends *dispatching*.
`bounce.qbsk` is twelve lines — two layers, a `fill`, a `border`, a `sprite` — so its
frame is almost entirely the engine work those three natives do. Compiling the dispatch in
front of them changes nothing, correctly.

That makes this file's reference program the case where the stage buys the least, and
anyone reading F6 through it would report a 3× speedup as a no-op. The reference profile
is a **shape** reference: it tells you the split between script, compose, diff and emit,
and it is deliberately small. It is not a sample of what the interpreter costs.

It also fixes how the ratio line should be read. **That line compares the SCRIPT bucket
against emission, and the script bucket includes everything the natives do on the
interpreter's behalf.** It has never meant that dispatch is 98% of a frame — `bounce.qbsk`
is the proof, since its script bucket barely moved when dispatch got three times cheaper.

⚠️ **The ratio itself moved across F6, and the direction is the expected one.** Measured
on this machine: **98.1% / 1.8%** before rung 5, **95.5% / 4.4%** at `2252c21`. Compiling
the dispatch away shrank the script bucket, so emission is now a larger share of a smaller
frame — which is the same ~95/5 the review skill records as historically stable, arrived
at from the other side. A single figure quoted from one run is not a property of the
engine; the pair is.

The absolute numbers in this addendum are ~1.6× higher than the ones above it for the same
work. That is the machine on the night they were taken, not a regression: §13.1 again, and
the reason every row here is a pair measured back to back rather than a figure carried
between sessions.
