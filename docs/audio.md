# QBSK — Audio Spec (docs/audio.md)

> **Status:** an earlier release. Every audio implementation complies with this spec.

---

## 1. Design principles

1. **Synthesis is pure mathematics** (`src/audio/tone.ts`): waveforms are generated
   from math into raw PCM samples, with zero dependencies and zero I/O. Deterministic
   by construction — the same parameters always produce the byte-identical buffer, so
   it is golden-testable exactly like `Cell`/`Canvas` ANSI output.
2. **One door to the hardware** (`src/audio/device.ts`): the only module that touches
   an audio device or spawns a player process. Nothing else in the engine may — the
   same discipline the engine applies to the screen (`src/engine/render.ts`).
3. **Fallback is silence, never a crash**: no backend available, or `--no-audio`,
   degrades to silence without breaking anything.
4. **`tone` is a first-class DSL primitive**, at the same level as `put`/`box`/`line`
   — not a separate API (review §7).
5. **Audio observes, never drives**: sound never affects scene composition, the frame
   loop, or the byte-exact goldens.

---

## 2. The synthesis module — `src/audio/tone.ts`

- **Sample format**: 16-bit signed PCM (Int16), mono, 44100 Hz.
- **Waveforms** (pure functions of phase `θ(t) = 2π·f·t`):

  | Wave | Value |
  |---|---|
  | `sine` | `sin(θ)` |
  | `square` | `sign(sin(θ))` |
  | `triangle` | `(2/π)·asin(sin(θ))` |
  | `sawtooth` | `2·frac(f·t) − 1` |
  | `noise` | seeded white noise (below) |

- **Noise is deterministic**: white noise comes from a seeded PRNG (mulberry32) with a
  fixed documented seed — never `Math.random()`. `random()` remains the language's only
  non-deterministic source (§5.2 of `docs/language.md`), so it cannot appear in goldens.
- **Click-free envelope**: every tone gets a 5 ms linear attack and release. Without
  it the discontinuity at each end of the buffer is a click; the ramp is pure math and
  keeps the goldens stable.
- **Volume**: samples scale by `volume` (0..1), then `round()` to Int16 and clamp to
  the signed 16-bit range.
- **API**: `synthesize({ freq, wave, duration, volume }) -> Int16Array`.
  - `duration` in seconds; sample count `= round(44100 · duration)`.
  - `freq > 0`; `duration > 0`; `volume` clamped to [0, 1].
  - Deterministic → byte-exact goldens in `tests/golden/tone-*.out`.

---

## 3. The device door — `src/audio/device.ts`

**Backend (owner decision 2026-08-07): OS delegation.** Synthesize the buffer, write a
temp WAV, play it through the platform's own player. Zero npm dependencies — the
deferred hardware hand-off (review §7) lives in exactly this one replaceable file.

| Platform | Player |
|---|---|
| Windows | `powershell -NoProfile -Command "(New-Object Media.SoundPlayer 'path').PlaySync()"` |
| macOS | `afplay path` |
| Linux | `aplay path` |

- **WAV serialization lives here too**: a pure `encodeWav(Int16Array, 44100) -> Buffer`
  (RIFF/WAVE, 16-bit mono, 44-byte header) — part of the hardware hand-off, not of the
  synthesis.
- **Never blocks the loop**: `spawn` (async), never `execSync`. The device queues a
  play and returns immediately.
- **`enabled` flag**: `false` → every call no-ops (silence). The CLI derives it from
  `--no-audio`; Studio hosts set it per run; tests and the MCP manual generation
  construct it disabled.
- **Spawn failure is silence**: missing player, temp-file error, non-zero exit —
  caught and warned once on stderr, never thrown into QBSK.

---

## 4. The QBSK surface — `tone`

```
tone <freq> [wave: <name>] [duration: <sec>] [volume: <n>] [loop: <bool>]
```

| Param | Kind | Default | Rules |
|---|---|---|---|
| `freq` | positional, required | — | int or float > 0, Hz |
| `wave:` | named | `square` | `sine`, `square`, `triangle`, `sawtooth`, `noise` |
| `duration:` | named | `0.1` | int or float > 0, seconds |
| `volume:` | named | `0.5` | float 0..1 |
| `loop:` | named | `false` | bool |

- `freq` and `duration` accept int or float and are converted explicitly to float:
  they are physical quantities, not grid addresses — the same category as `gameTime()`
  and `animate(...)`, where the runtime keeps the two types distinct but both write
  forms are valid.
- Unknown `wave:` name → runtime error with a span (like an unknown easing name).
- `tone` composes like any primitive: inside a layer or at top level, subject to the
  per-primitive state directives (§7.1b). `visible: false` hides it (no sound) exactly
  as it hides a `put`; `z:` and `color:` are irrelevant to audio and ignored for it.
- `qbsk run` (one-shot) plays the tones its single composition triggers; loop mode
  triggers per frame (§5).

---

## 5. Scheduling — how `tone` plays over time

Composition is a pure function of `gameTime` (persistent interpreter, `docs/language.md`
§7.7), so the **audio plan is deterministic**: the same (scene, game time) always
produces the same list of tone triggers. Playback itself is wall-clock and never part
of a golden.

- The tone plan contains only the tones **visible** at that frame (`visible: false`
  contributes nothing — mirroring "writes no cells").
- Each frame the host feeds the device `device.frame(tonePlan, gameTime)`, where
  `tonePlan` is the frame's composed tones and `gameTime` is the frame's game clock
  (the frame result carries it).
- The device keeps **host-side trigger state per tone identity**, in the same
  `GameRuntime`-owned space as the tweens — never inside the interpreter. Identity =
  layer name + declaration position, stable for a stable scene.
- Trigger rule (same shape as the tweens' continue/restart rule, `docs/engine.md` §11.2):
  - no record → **play now**, record `{ start: gameTime, params }`;
  - params changed → **restart** (play now, new record);
  - same params and `gameTime < start + duration` → still playing, **do not retrigger**;
  - same params, finished, `loop: false` → silent (the record survives so the identity
    does not retrigger);
  - same params, finished, `loop: true` → **play again** (start = gameTime).
- A tone absent from a frame has its record dropped, so gating it with `visible:` makes
  it play exactly when it becomes visible — the dialogue-beep pattern the `pitch`
  fields of `examples/awakening.qbsk` ask for.

This is why a `tone` declared unconditionally in a scene plays **once at scene start**
and not sixty times a second: re-composition with identical parameters continues, never
retriggers — exactly how `animate` reads.

---

## 6. Fallback and CLI

- No backend, spawn failure, or `--no-audio` → silence; the program runs unchanged.
- `qbsk run --no-audio <file.qbsk>` (also accepted by `--ansi --loop` and `profile`).
- Note: `--no-ansi` is referenced in `docs/engine.md` §1/§3 but does not exist in the
  code — ANSI is opt-in via `--ansi`. `--no-audio` is a true disable flag for a
  default-on capability. The fallback *discipline* is the same; the flags are not.

---

## 7. Goldens and determinism

- `synthesize()` buffers are golden byte-for-byte as `tests/golden/tone-*.out`
  (space-separated Int16 values) — the audio analogue of the ANSI goldens.
- The trigger plan is deterministic and pinned in unit tests: drive a `tone` scene
  through `SceneProgram` and assert which tones trigger at which game times. Playback
  is never asserted.

---

## 8. Non-goals (deferred, recorded so they are not mis-built)

- **Software mixing / polyphony**: overlapping tones are delegated to the OS mixer
  (separate player processes); sample-accurate mixing is a non-goal of the
  OS-delegation backend.
- **Handler-side sound**: `tone` is declarative (layer / top level), mirroring `put`;
  triggering from `on key` / `on tick` is a future extension.
- **ADSR, stereo, sample-rate control, effects** (echo/reverb): later phases.
- **Live streaming**: the device plays whole WAVs; no real-time buffer streaming.
