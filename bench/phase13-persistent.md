# QBSK — an earlier release persistent interpreter profile

Compared against `bench/baseline.md` (frozen reference, commit `a0a5494`) and against the
pre-change an earlier release baseline (same machine, `dist/` = Phase-11 build).

## Measurement environment

| | |
|---|---|
| Date | August 7, 2026 |
| Node | v24.19.0 |
| Shell | PowerShell 5.1 |
| Command | `node dist/cli/main.js profile examples/bounce.qbsk --frames 300` |

## Result (persistent interpreter)

```
frames: 300  updates: 299  target: 60 fps
fps mean: 60.2  p99: 31.1
cells/frame: 2.98  bytes/frame: 17.1
ms/frame — script: 0.735  compose: 0.001  diff: 0.012  emit: 0.017
```

## Comparison (like for like, same scene and flags)

| Metric | baseline.md (a0a5494) | pre-change (Phase-11 build) | an earlier release (persistent) |
|---|---|---|---|
| fps mean | 60.1 | 60.1 | 60.2 |
| p99 fps | 32.0 | 31.2 | 31.1 |
| script ms/frame | 0.885 | 0.991 | **0.735** |
| compose ms/frame | 0.001 | 0.001 | 0.001 |
| diff ms/frame | 0.015 | 0.022 | 0.012 |
| emit ms/frame | 0.020 | 0.028 | 0.017 |
| total CPU ms/frame | 0.921 | 1.042 | **0.765** |
| cells/frame | 2.98 | 2.98 | 2.98 |
| bytes/frame | 17.1 | 17.1 | 17.1 |

## Reading

1. **Script cost dropped ~26%: 0.991 → 0.735 ms/frame** (and ~17% vs the original
   baseline's 0.885). The interpreter is no longer re-created and the native environment
   rebuilt every frame — that is the earlier change (one `SceneProgram`, top level once,
   per-frame dispatch + re-compose).
2. **The p99 (31.1) stays in the scheduler-noise band** of the environment (32.0 baseline
   vs 31.7 pre-change) — not a regression. avg fps steady at 60.
3. **diff + emit are still ~4% of the frame** (0.029 of 0.765 ms). The diffing heuristic
   is untouched, as `bench/baseline.md` mandates.
4. The `keys.qbsk` example (2 event handlers + 3 layers) profiles at
   `script: 0.279 ms/frame` at 20 fps — event dispatch is not a measurable cost at this
   scale.

## Reproduction

```bash
npm run build
node dist/cli/main.js profile examples/bounce.qbsk --frames 300
```
