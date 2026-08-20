# static-layer — static-layer cache

Measured on August 15, 2026, on the same Windows 11 machine and in one session. The
before build is commit `34ec4f5` in a detached worktree; both builds use the same
`bench/static-layer-12k.qbsk` file and the same installed dependencies.

## Commands

```powershell
git worktree add --detach C:\Users\emir\AppData\Local\Temp\agent\qbsk-e1-before 34ec4f5
npm.cmd run build
node dist/cli/main.js profile bench/static-layer-12k.qbsk --frames 60
```

The profile command was alternated `before, after, before, after` within minutes. Exact
script results:

| run | before (`34ec4f5`) | after (E1 working tree) | speedup |
|---|---:|---:|---:|
| 1 | 12.058 ms/frame | 0.686 ms/frame | 17.58x |
| 2 | 12.360 ms/frame | 0.634 ms/frame | 19.50x |
| mean | **12.209 ms/frame** | **0.660 ms/frame** | **18.50x** |

Both after runs are below E1's `< 2 ms/frame` script criterion. The complete CPU split
for the second pair was:

```text
before — script 12.360, compose 0.001, diff 0.465, emit 0.950 ms/frame
after  — script  0.634, compose 0.001, diff 0.380, emit 0.783 ms/frame
```

The first frame still evaluates, mounts, and captures all 12,000 primitives. Later frames
reuse whole-layer runs; there is no per-primitive lookup in the hot path. `cells/frame`
and `bytes/frame` were identical in all four runs: **450.00** and **466.4** respectively.

## Staticity report

```powershell
node dist/cli/main.js check --layers bench/static-layer-12k.qbsk
```

```text
layer scenery: static — proven stable
OK: 'bench/static-layer-12k.qbsk' has no problems
```

The production call-graph analyzer proves **57/140** example layers static. This corrects
the temporary planning probe's 63/140: seven unsafe false positives are now dynamic (two
helper call chains reading a `var`, four shade layers, one animated sprite layer), while
one locally seeded RNG layer is correctly proven deterministic.

## Deliberately left out

- No `static` keyword or other language-surface change.
- No per-primitive cache.
- No caching for depth-tested layers, tones, shades, imported bindings, indirect calls,
  animated sprites, mutable top-level reads, or unknown natives.
- No attempt to preserve cache entries across `evalSnippet`; every eval invalidates all
  entries before parsing or execution.

## Independent reproduction — August 17, 2026

A second session on the same machine rebuilt the `34ec4f5` worktree from scratch and
alternated the same four runs. The ratio holds; the absolute numbers moved by less than
the session-to-session variance `bench/baseline.md` §13.1 documents.

| run | before (`34ec4f5`) | after (E1 working tree) | speedup |
|---|---:|---:|---:|
| 1 | 12.316 ms/frame | 0.581 ms/frame | 21.20x |
| 2 | 12.249 ms/frame | 0.620 ms/frame | 19.76x |
| mean | **12.283 ms/frame** | **0.601 ms/frame** | **20.44x** |

`cells/frame` 450.00 and `bytes/frame` 466.4 were again identical across all four runs,
and the `57/140` example-layer baseline reproduced exactly from a fresh analyzer walk.
