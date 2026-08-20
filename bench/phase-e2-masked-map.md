# an earlier release — the masked-map fast path

Measured on August 18, 2026, on the same Windows 11 machine and in one session. The
before build is commit `021090d` (the E2 spec, before any implementation) in a detached
worktree, still carrying the nested-loop form of `examples/crypt.qbsk`. The after build is
the E2 working tree with the same file rewritten to
`put MAP at (0, 0) mask: seen`.

## Commands

```powershell
git worktree add --detach <tmp>\qbsk-e2-before 021090d
npm.cmd run build
node dist/cli/main.js profile examples/crypt.qbsk --frames 60
```

The profile command was alternated `before, after` three times within minutes.

| run | before (loop, `021090d`) | after (mask, E2) | speedup |
|---|---:|---:|---:|
| 1 | 0.946 ms/frame | 0.281 ms/frame | 3.37x |
| 2 | 0.922 ms/frame | 0.293 ms/frame | 3.15x |
| 3 | 0.932 ms/frame | 0.293 ms/frame | 3.18x |
| mean | **0.933 ms/frame** | **0.289 ms/frame** | **3.23x** |

The stage's criterion was "halves or better", target ≤ 0.40 ms against the phase
document's 0.805 ms baseline. This session measured the loop form at 0.933 ms — within the
session-to-session variance `bench/baseline.md` §13.1 documents — and the composite at
**0.289 ms**, under the target by a clear margin.

## The picture did not change

`qbsk run examples/crypt.qbsk` produces **byte-identical** output before and after
(820 bytes both). The game's eight behaviour tests (`tests/unit/crypt-game.test.ts`) pass
**unmodified**, and `tests/unit/masked-map.test.ts` pins the loop form and the composite
producing the same canvas on the same map and mask.

## turns.qbsk — measured, then rewritten in follow-up

At stage close `turns.qbsk` was left on the loop form and measured at 2.061 / 2.132
ms/frame. It was rewritten immediately afterwards, in its own commit, once the construct
had proven itself on `crypt`.

Its map is larger than crypt's, so the win is larger. Same binary both sides — only the
`.qbsk` file differs, which isolates the change completely:

| run | before (loop) | after (mask) | speedup |
|---|---:|---:|---:|
| 1 | 1.983 ms/frame | 0.442 ms/frame | 4.49x |
| 2 | 1.929 ms/frame | 0.434 ms/frame | 4.44x |
| 3 | 1.869 ms/frame | 0.438 ms/frame | 4.27x |
| mean | **1.927 ms/frame** | **0.438 ms/frame** | **4.40x** |

Output byte-identical (1220 bytes both), `tests/golden/turns.qbsk.out` unchanged, and the
27 tests in `tests/unit/turns.test.ts` pass unmodified. The `room` layer stays **dynamic**,
as it must.

**Criterion 4 — "the old pattern still works" — is now held by a test rather than by an
example**, and that is the weaker of the two. `tests/unit/masked-map.test.ts` draws both
forms over the same map and mask and compares the canvases byte for byte, so the loop path
cannot rot silently. But no example exercises the whole-map loop end to end any more. That
is recorded here rather than glossed: if the loop form is ever to be deprecated, this is
the paragraph that says what stopped covering it.

## Staticity baseline

`examples/masked_map.qbsk` adds two provably static layers, moving the repository baseline
from 57/140 to **59/142** by addition. The classifier's verdict on each of the original 140
layers is unchanged, and `crypt.qbsk`'s floor stays **dynamic** — as it must, since its
mask changes every turn.

## Deliberately left out

- No new keyword and no new native: the frozen surface stays at 77 natives and 51 keywords.
- No rewrite of any other example. `turns.qbsk` was rewritten in follow-up (see above);
  the remaining per-cell loops in the repository are not the map-through-mask shape and
  the composite does not apply to them.
- No mask predicate beyond "a space hides": `sight()` already answers in that alphabet, and
  a configurable test would be a named argument with no measured caller.
- No caching of the resolved cells across frames — the mask is what changes, so a cache
  keyed on it would miss every frame it mattered.
