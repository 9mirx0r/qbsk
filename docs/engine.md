# QBSK — ASCII Engine Spec (docs/engine.md)

> **Status:** 1.0 — this document is the specification. Any engine change is made here
> corrected architecture decisions. Every engine implementation complies with this spec.

---

## 1. Architectural principles

1. **A single door to the system**: only `src/engine/render.ts` (`renderFrame`) writes
   ANSI bytes to the terminal. No other module writes ANSI. (The historical
   `src/engine/terminal.ts` named in earlier drafts does not exist; the emitter is
   `render.ts`.) Audio has its own single door, `src/audio/device.ts` (`docs/audio.md` §3).
2. **Double buffer always**: `FrontBuffer` (on screen) / `BackBuffer` (being drawn).
   Repeated frame → 0 bytes emitted. No-flicker guaranteed.
3. **Differential diffing**: only changed cells, grouped into runs of identical style.
4. **100% ANSI**, no ncurses. Windows 10+ via Virtual Terminal Processing; `--no-ansi`
   fallback if capabilities are missing.
5. **Visible metrics**: ms per phase (script/composition/diff/emission), emitted cells,
   mean/p99 fps. Target: 120×40 @ 60 FPS, ≤ 2 ms/frame.

## 2. ANSI inventory (exact sequences)

| Function | Sequence |
|---|---|
| Alternate screen (enter/exit) | `\x1b[?1049h` / `\x1b[?1049l` |
| Hide/show cursor | `\x1b[?25l` / `\x1b[?25h` |
| Position cursor (1-indexed) | `\x1b[{y};{x}H` |
| Home | `\x1b[H` |
| Clear screen | `\x1b[2J` |
| SGR reset | `\x1b[0m` |
| 16-color fg/bg | `\x1b[3x m` / `\x1b[4x m`, bright `9x`/`10x` |
| Truecolor fg/bg | `\x1b[38;2;{r};{g};{b}m` / `\x1b[48;2;{r};{g};{b}m` |
| Styles | bold `1`, underline `4`, reverse `7` (bitmask 1/2/4) |

## 3. Terminal cross-platform

- **Windows**: in Node.js, libuv enables `ENABLE_VIRTUAL_TERMINAL_PROCESSING` and VT input
  automatically on Windows 10+ for TTYs. The Win32 API does NOT need to be called by hand
  (Node does not expose it). Check at runtime and degrade if it fails.
  (Correction to report #2: writing `\x1b[?1049h` does NOT enable virtual mode.)
- **Detection**: `CI` or `TERM === 'dumb'` → no truecolor, basic mode. `COLORTERM ===
  'truecolor'` → 24-bit RGB. If there is no TTY → `--no-ansi`.
- **Raw mode**: `process.stdin.isTTY` → `setRawMode(true)`, `resume()`,
  `setEncoding('utf8')`; restore in try/finally + `exit`/`SIGINT`/`uncaughtException`.
- **Mandatory restoration**: `\x1b[0m\x1b[?25h\x1b[?1049l` on all exit paths.
   Never leave the terminal without cursor/echo.
- **Resize**: `SIGWINCH` (POSIX) / console events (Windows) → queue `on resize(w, h)`.

## 4. Cell and buffers

```ts
interface Cell {
  char: string;      // 1 character
  fg: number;        // 0xRRGGBB or -1 = default (packed: cheap diffing)
  bg: number;        // same
  attrs: number;     // bitmask: 1=Bold, 2=Underline, 4=Reverse
}
```
- `eqCell(a, b)` (free function, `cell.ts`) = comparison of primitives (no objects).
  It is the hottest function.
- `ScreenBuffer { width, height, front: Cell[], back: Cell[], dirtyLines: Set<number> }`
  (`buffer.ts`) — **flat 1D arrays** indexed `y * width + x`. Never
  `Array<Array<Cell>>`. Double buffer: `front` = what is on screen, `back` = what
  is drawn; `swap()` swaps references and clears the back with
  `back.fill(DEFAULT_CELL)` (a template instance, no per-cell allocations).
- `beginFrame()` cleans the back + `dirtyLines`; `setCell(x, y, cell)` and
  `paintCanvas(canvas)` mark the dirty lines; out-of-range cells are discarded.
- `reset(w, h)` resizes; `DEFAULT_CELL` = `{char: " ", fg: -1, bg: -1, attrs: 0}`.

## 5. Differential diffing

```
for each y in dirtyLines (Set<number>):
  for each x:
    if !back[i].eq(front[i]):
      if real cursor != (x, y) → emit \x1b[y;xH
      if style changed → emit a single SGR + update lastFg/Bg/attrs
      emit char; update virtual cursor
      copy back[i] → front[i]   (inline sync)
```
- **dirtyLines**: only touched lines are scanned; they are marked in composition.
- **Runs**: consecutive cells with the same SGR are emitted as a single escape + text.
- **Cursor heuristic (deterministic, not "shortest text" cost)**: if
  `changed * 2 >= width` the line is fully rewritten (`rewrite`, jump to col 1 +
  entire row + reset); otherwise, per-run jumps (`\x1b[{y+1};{x+1}H` per run). The diff
  tests fix the threshold (5/10 → rewrite, 2/10 → runs).
- Unchanged frame → 0 bytes (mandatory test).

## 6. ANSI emitter

- `src/util/ansi.ts`: pure builders (`cursorTo(row, col)`, `sgr(codes)`, `RESET`,
  `hideCursor`, `showCursor`, `altScreen`, `exitAltScreen`, `clearScreen`, `home`).
  Single source of the engine's escapes.
- `src/engine/render.ts`: `renderFrame(diff, width)` → ANSI string with virtual cursor:
  a single SGR per group of cells with the same style; style transition = `\x1b[0m` +
  new SGR (avoids dangling attributes); final reset if there was style; lines with
  `rewrite` always end in `\x1b[0m` (clears previous styles on screen).
- Color selection: truecolor if `COLORTERM`, otherwise 256 palette, otherwise 16.

## 7. Game loop (fixed timestep)

`src/engine/loop.ts`:

```ts
interface LoopOptions {
  fps: number;                 // logic at a fixed dt = 1/fps
  frames?: number;             // > 0 → stops on its own; default infinite (stop())
  now?: () => number;          // injectable clock in seconds (deterministic tests)
}
class GameLoop {
  constructor(opts: LoopOptions, handlers: {
    update?: (dt: number) => void;   // logic at fixed timestep
    render: () => string | null;     // diff+flush; null = unchanged frame
  })
  step(): void;                // one clock frame (public for tests)
  run(): void;                 // real loop: setImmediate (no setInterval, no drift)
  stop(): void;
  report(m: FrameMetrics): void;  // ms per phase + emitted cells/bytes
  stats(): LoopStats;             // mean/p99 fps, cells/frame, ms per phase
}
```

- Fixed timestep with accumulator (BigInt ns): `while (accumulator >= timestep) { update(dt); accumulator -= timestep }`; render at the terminal's real rate. `setImmediate` yields to the event loop (correction to report #1, which proposed `setInterval`).
- `FrameMetrics { scriptMs, composeMs, diffMs, emitMs, cells, bytes }` — the caller measures each phase's duration with `performance.now()` and reports them; the loop computes fps (mean and p99) from each frame's time.
- The program is evaluated with a **persistent interpreter** (spec language.md §7.7):
  the AST is parsed and the top level evaluated once; per frame the event handlers run
  and the scene re-composes from the live environment, with `runtime.gameTime` advanced
  by fixed dt (the native `gameTime()` reads it). The AST is never re-parsed and the
  interpreter is never rebuilt inside the loop.
- `qbsk profile scene.qbsk --frames 300` prints the summary and the results are versioned
  in `bench/`.

## 8. Input

The terminal decoder turns bytes on stdin into the canonical names of
`src/engine/keys.ts` — **the same names the Studio window produces**, because a scene
that works in one host and not the other is worse than one that works in neither.

| bytes | name |
|---|---|
| `\x1b[A` | `arrow-up` |
| `\x1b[B` | `arrow-down` |
| `\x1b[C` | `arrow-right` |
| `\x1b[D` | `arrow-left` |
| `\x1b[H` / `\x1b[F` | `home` / `end` |
| `\r` or `\n` | `enter` |
| `\x7f` or `\b` | `backspace` |
| `\t` | `tab` |
| `\x1b` alone | `escape` |
| a space | `space` |
| any other printable character | itself |

> **Correction.** This table used to read `up/down/right/left`, with no `arrow-` prefix,
> while the language spec, the parser's own error text, both test files and every example
> wrote `arrow-left`. Matching is an exact lookup with no fallback, so an implementation
> that followed this section would have shipped **arrow keys that silently never fire**.
> The prefixed form wins; this file was the outlier.

### 8.1 A chunk accumulator, not a `toString()`

`\x1b[A` can arrive split across two `data` events, so bytes are buffered until a
sequence is complete rather than decoded per chunk. A partial escape is held, never
guessed at.

**`\x1b` is both the escape key and the first byte of every arrow.** A lone escape is
therefore only reported once something arrives that does not continue it, or the stream
goes quiet. Reporting it immediately would emit a phantom `escape` before every arrow;
never reporting it would lose the key entirely.

### 8.2 The queue is capped at 256, dropping the oldest

The spec used to say "max size N", with N never chosen. It is **256**.

Measured before picking it: the queue was unbounded, and 50 000 presses drained in one
frame took **832 ms**. A held arrow under OS key repeat reaches that scale, and a frame
that long is a freeze. Dropping the **oldest** keeps the most recent input, which is the
one the player still means.

### 8.3 One press per key per frame (repeat coalescing)

A held key under OS auto-repeat arrives many times between two frames. Every queued
press used to dispatch, so holding an arrow moved the player once **per press**, not once
per frame: measured at **20 cells for 20 presses landing in a single frame**. That is not
a frame rate the player can see or aim at — it is the operating system's repeat rate
leaking into the game's movement speed, and it differs per machine.

**Within one frame, repeated presses of the SAME key dispatch once.** Different keys in
the same frame all dispatch, in arrival order. A held arrow now moves one cell per frame,
which is a rate the game controls through `fps:`.

```
queue: right right right up right      →  dispatches: right, up
```

This is engine policy, not a per-game option, and that is the deliberate part: a game
that wants to know *how much* input arrived is asking a question about the input device,
while a game asking "which keys are down this frame" is asking about the player. The
second is the question a turn or a frame is actually answering.

**What it costs:** a program that counted presses to measure held duration cannot. No
example did — checked before the change — and counting frames while a key repeats is the
same measurement with a unit the game chose.

The cap in §8.2 still applies underneath: coalescing reduces *dispatches*, not the
queue's memory, so a 50 000-press burst is still bounded by 256 before it is bounded by
the number of distinct keys.

### 8.4 `pressKey`, not `pollKey`

An earlier draft promised `pollKey()` — a loop that *pulls*. The implementation and
`docs/language.md` §7.7 are the opposite: the host *pushes* into a queue the program
drains inside `step()`.

Push is the right direction, because a key arrives between frames and a pull would have
to poll for it. Corrected here rather than in the other two documents: one of the three
had to move, and this is the one that was alone.

## 9. Scene graph and composition

Per frame:
1. Run QBSK script (events, tweens) → state.
2. Sort layers by ascending `zIndex` (layer z can be an expression: dynamic
   per frame since M15).
3. Per layer: discard `visible: false` primitives and sort the rest by their
   ascending `z` (stable: tie = declaration order).
4. Clear backbuffer (base background).
5. Per layer, per primitive: **mandatory clipping** (`0 <= x < width`, `0 <= y < height`)
   — including negative coords; never index out of range.
6. Dump cells into the backbuffer (upper layer overwrites).
7. Diff + flush. 7. Swap.

Layer and primitive z are re-evaluated per frame (game clock `gameTime()`):
reordering layers/primitives at runtime is reflected in the next frame without mutable
state — the full mount happens once per frame (§7).

## 10. Coordinates

- `src/choreo/coord.ts`: pure world↔local conversion:
  `localToWorld(lx, ly, x, y) = (lx + x, ly + y)` and `worldToLocal(lx, ly, x, y)`.
- `LayerDef` carries offset `at` (default `(0,0)`); every local primitive is composed at
  `at + local`. A primitive with `world: true` (absolute position) is composed as-is,
  without adding the layer offset.
- Resolution at mount (`sceneMount.ts`): `world: (x, y)` primitives are
  marked `world: true` with their absolute position; locals with `at (x, y)` stay
  `world: false` and composition adds `layer.at` to them (conversion in `coord.ts`).
- Anchors: `anchor: top-left | top-center | top-right | middle-left | center |
  middle-right | bottom-left | bottom-center | bottom-right | (fx, fy)` — **9 named
  points** plus the fractional form; translation and scale pivot. An object anchored at
  center moves without jumps (the pivot doesn't change with position). The anchor is a
  property of the `sprite` primitive, never of the `.qba` file (§12).
- 1.0 transformations: translate (`at`/`world:` + derivation via `gameTime()`) and
  scale (character repetition, `scale: (fx, fy)`). **No rotation** (documented
  as future).
- Clipping in composition with world coords included: outside the canvas it is discarded.

### 9.1 Static-layer cache (static-layer)

Layer staticity is inferred from the parsed program; it is not author syntax. A layer is
cacheable only when the analyzer can prove that every value it reads is stable and every
call it reaches is deterministic. Reads of top-level `var` bindings, imported module
bindings, mutable indexed values, indirect or unknown calls, animated sprites, tones,
shades, `put ... depth:`, and volatile natives make the layer dynamic. Function calls are
followed through the program's call graph, so a layer calling a helper that eventually
reads a `var` stays dynamic. Any case the analysis cannot prove is reported as dynamic. There is no `static`
keyword and no annotation that can override the analyzer.

`qbsk check --layers <file.qbsk>` prints one line per layer in source order, in the form
`layer NAME: static|dynamic — REASON`, where the reason is the proof or the first
conservative objection:

```text
layer back: static — proven stable
layer ball: dynamic — calls gameTime
```

(`examples/bounce.qbsk`, verbatim.)

The first planning probe reported 63 static layers out of 140. The production call-graph
walk corrects that baseline to **57/140**: the shallow probe had seven false positives —
two helpers that read the mutable `t` value, four shade layers, and one animated sprite
layer — and one false negative, a locally seeded RNG layer whose sequence is deterministic.
Keeping the seven unsafe layers dynamic is the required conservative correction; matching
an older count is never allowed to outrank output correctness.

The runtime caches a static layer as **whole-layer cell runs**. A run contains consecutive
cells actually written by that layer; untouched cells are absent. This distinction is
semantic: an explicitly drawn space must overwrite a lower layer, while an untouched cell
must let it show through. Runs are replayed in the ordinary ascending layer-z order, so
dynamic layers above and below them compose exactly as before. A cached layer is
composed against its own depth buffer rather than the scene-wide one, which is sound
only because `put ... depth:` is itself a dynamic reason — no cacheable layer can write
depth. That policy is the invariant, not an incidental detail, and a test pins it. Caching individual
primitives is forbidden: it would add a lookup to every primitive in the hot path the
cache exists to remove.

The cache belongs to one `SceneProgram`. Its entries are dimension-specific and are
discarded together whenever `evalSnippet` is called, before parsing or evaluating the
snippet. Studio snippets can mutate indexed data held beside a `const` binding; the next
composition must therefore evaluate and capture every static layer again. Cache misses
change cost only, never output. Existing one-shot execution remains uncached because it
already composes only once.

## 11. Animation

### 11.1 Easings

Pure, stateless curves `f(t) -> number` for t in [0, 1] (`src/choreo/easing.ts`):
`linear, ease-in, ease-out, ease-in-out, bounce, elastic`.

Every curve guarantees `f(0) = 0` and `f(1) = 1` exactly, so an animation starts and
lands where it was told. `bounce` and `elastic` may leave [0, 1] mid-flight — that
overshoot *is* the effect. `t` is clamped before the curve is applied, so a tween that
has run past its duration holds its final value instead of extrapolating.

### 11.2 Tweens

```qbsk
animate(name, from, to, duration)             -> float
animate(name, from, to, duration, easing)     -> float
animate_done(name)                            -> bool
animate_reset(name)                           -> bool
```

**Where "when did it start" lives: host-side, beside `gameTime`** (`GameRuntime.tweens`),
never inside the interpreter. That is what keeps a tween a pure function of
`(gameTime, recorded start)`: the scene block re-runs every frame and reads the same
tween many times, and every read in a frame returns the same number. Accumulating per
frame instead would drift and would make byte-exact goldens impossible.

Re-declaring a tween with identical parameters **continues** it; changing any parameter
restarts it from the current game time. That is what makes the obvious scene code work —
the line below executes 60 times a second and still takes exactly two seconds:

```qbsk
put "o" at (round(animate("hero", 5.0, 40.0, 2.0, "ease-out")), 10)
```

### 11.3 Rounding — use `round()`, not `int()`

A tween returns a **float**; the canvas addresses **integer** cells. QBSK keeps the two
types distinct (RULE #4), so the scene must convert explicitly — a tween is not allowed
to smuggle a silent truncation past that rule.

**Which conversion matters, and it is not a matter of taste.** `int()` truncates, so a
value must fully reach `8.0` before it occupies cell 8. Two consequences, both measured:

- Motion stutters: with easing, the dwell time per cell becomes uneven.
- Worse, it is **frame-rate sensitive**. `gameTime` accumulates `dt` as a float, so ten
  steps of 0.1 s give 0.9999999999999999 while twenty of 0.05 s give 1.0000000000000002.
  That 3e-16 gap is meaningless as time, but when a tween value lands exactly on an
  integer it decides which side of the truncation it falls on — and the character jumps a
  whole cell. Measured: with `int()`, the same scene at 10 fps and at 20 fps disagreed at
  game time 0.5; with `round()`, all sampled times agreed.

So: **`round()` for tween output.** It centres the cell, which both smooths the motion and
puts the float noise nowhere near a decision boundary. `int()` remains correct for values
that are genuinely integral already.

### 11.4 Frame-swapping

```qbsk
sprite "res/walk.qba" at (10, 20) frames: 6 fps: 10 loop: true
```

`fps` here is the **animation** rate, unrelated to how often the scene is drawn: a
6-frame walk at `fps: 10` cycles in 0.6 s whether the window repaints 20 or 60 times a
second. Without `frames`, a multi-frame `.qba` still shows frame 0.

`loop: false` **holds the last frame** rather than looping or vanishing — what a
one-shot animation (a door opening, an explosion) needs.

Declaring more frames than the file contains is an error with a span naming both counts.

**The frame follows the GAME clock, never the render clock and never `Date.now()`.**
Enforcing that took more than reading the right variable: `gameTime` accumulates `dt` as
a float and a frame boundary is exactly where `floor` changes its answer, so at t = 0.25
a 20 fps run and a 60 fps run showed different frames. `pickFrame` adds a 1e-9 epsilon —
accumulation is ~1e-16 per step, so ~2e-11 after an hour at 60 fps; a nanosecond of
tolerance swallows it with orders of magnitude to spare and is far below anything
perceivable.

### 11.5 Timelines

```qbsk
const talk = timeline_sequence([
    timeline_step("line1", 2.4),
    timeline_wait(0.5),
    timeline_parallel([timeline_step("door", 1.0), timeline_step("music", 2.0)]),
])

timeline_duration(tl)              -> float
timeline_active(tl, t)             -> list of names active at t, in order
timeline_progress(tl, name, t)     -> float in [0,1], or -1.0 when not running
```

**A timeline is a value that is queried, not a scheduler that runs.** Asking the same
timeline the same time twice always gives the same answer, so it composes with the
per-frame re-evaluation model and keeps goldens byte-exact. There is no cursor, so times
may be asked out of order.

- `sequence` sums its children; `parallel` takes the **longest** — a parallel block ends
  when its slowest member does, not its first.
- A `wait` occupies time and contributes **no name**, which is what makes a sequence read
  the way it looks.
- Nesting works in **both** directions: a `parallel` inside a `sequence` and a `sequence`
  inside a `parallel`, to any depth.
- `timeline_progress` returns **-1.0** rather than 0 when a step is not running: 0 would
  be indistinguishable from "just started", which is a real ambiguity for a caller
  deciding whether to draw something.

`examples/jail.qbsk` drives its conversation this way — each line is a named step with its
own duration, and `gameTime() % timeline_duration(talk)` loops it.

## 12. Sprite format (.qba)

```
# comment
META name: walker, width: 4, height: 3
 O
/|\
/ \
---
# Frame 2 — the --- separator
 O
/|\
 |
```
- META accepts exactly three keys: `name`, `width`, `height`. **An unknown key is an
  error**, not a silent skip (§15.9 of the language spec). This example carried
  `anchor: center` while the loader dropped it — the spec's own canonical example taught
  a key that did nothing. An anchor is a property of the `sprite` primitive
  (`sprite "walker.qba" at (0, 0) anchor: center`), never of the file.
- META applies to the whole sprite and is read once, before the first frame's art. A
  later `META` line inside a frame is not an override; it is not read at all.
- Tolerant loader: ignores `#` and blank lines outside the art; internal empty
  lines = spaces. Clear error with file name if the resource is missing. The width check
  is one-sided: a row LONGER than the declared width is an error, a shorter one is padded.

## 13. Target benchmarks (versioned in bench/)

| Scenario | Target |
|---|---|
| Full redraw 120×40 without diffing | ~5 MB/s stdout (bound I/O) |
| With diffing, 5% cells changing | < 50 KB/s, ≤ 2 ms/frame CPU |
| Repeated static scene | 0 bytes emitted |
| Sustained FPS (Alacritty/Kitty/Windows Terminal) | ≥ 60 FPS, target 120 |
| Windows Terminal vs Linux | Parity if redundant SGRs are minimized |

### 13.1 `npm run bench` — what it does and what it deliberately does not

RULE #3 requires the benchmarks green before a milestone closes. That gate was
**theatre**: `bench/run.mjs` printed "no benchmarks yet (milestone M14)" and exited 0,
while six real benchmarks sat beside it, unrun, and `bench/baseline.md` held real
numbers reproduced by a command the runner never called. A gate that cannot fail is
worse than no gate, because it reports confidence it never measured.

Concretely, what that cost: a change to `evalDslExpr` made the interpreter **2.4×
faster** on the reference scene (script 0.885 → 0.366 ms/frame) and `npm run bench`
reported nothing at all, in either direction.

`npm run bench` now runs the reference profile plus every read-only benchmark and
prints one table. Two design decisions matter more than the runner itself:

**It does not fail on absolute milliseconds.** `baseline.md`'s own addendum records why:
the same commit measured 0.735 ms in one session and 0.975 ms in another, on the same
machine, with nothing changed but background load and thermal state. A threshold on those
numbers would cry regression at the weather. So the runner **reports** and the human
compares; the exit code is about whether every benchmark RAN, not about whether it was
fast. RULE #3's gate is "the benchmarks still work and their output is on the record",
which is a claim the machine can actually make.

**It runs only the read-only benchmarks.** `bench/` also holds asset generators
(`sprite-gen`, `worldgen-gen`, `worldgen-names-gen`, `spritesheet-slice`,
`sprite-gen-batch`) which WRITE files into `examples/res/`. They are development tools
that happen to live here; running them from a quality gate would mutate the repository as
a side effect of measuring it, and a gate with side effects is not a gate.

That is not a hypothetical. While wiring this runner up, running those generators by hand
to see what they printed rewrote `worldgen_npcs.qbdata` and `pixelart_creature.qbdata`,
and two determinism tests went red — they compose committed `.qbdata` against a golden,
so regenerating the data breaks them by design. A gate that did that on every invocation
would have made the suite's determinism guarantee depend on whether anyone had recently
measured performance.

What to trust in the output, in order:

1. **Ratios**, always. "The interpreter is 96% of the frame" and "diff + emit are a
   rounding error" have held at every measurement on every machine. If a ratio moves, the
   shape of the engine changed and that is worth reading.
2. **Back-to-back A/B**, when a number matters. Check the older commit into a worktree and
   profile both within minutes of each other. That is the only comparison that isolates
   the code from the machine.
3. **Absolute ms**, never across sessions. They are a shape reference, not a threshold.

## 14. Common errors (forbidden)

1. `\x1b[2J` per frame → flicker. Only double buffer + diffing.
2. Visible cursor → `\x1b[?25l` always at startup.
3. Not restoring the terminal on crash → exit hooks + try/finally.
4. Diffing comparing complex objects → flat cells with primitives.
5. Allocations on the hot path (clear/eq/diff) → pre-allocate, reuse.
6. Frame-swap with real time → game clock.
7. Blocking input on expensive frames → queue + drop-oldest.

## 15. Implementation order (blueprint)

1. **Base systems**: terminal init, raw mode, ANSI sequences, TerminalBuffer.
2. **Graphics loop**: fixed timestep + diffing + flush to stdout.
3. **Primitives and scene graph**: box/text/layers with z-index + clipping.
4. **Input and events**: non-blocking capture.
5. **QBSK integration**: connect the language AST to the engine.

## 16. GitHub blueprints (reference)

- `sindresorhus/ansi-escapes` — reference for correct ANSI sequences in Node.
- `chjj/blessed` / `neo-blessed` — virtual buffer management (Screen/Element),
  high-speed cell diffing.
- `zarstensen/AsciiRenderer` — C++ renderer at high FPS: double buffering, window/title,
  only modified tiles. 
- `Thraka/SadConsole` — .NET: tile maps, fonts, entities, layers and importers.
- `spencergoldade/AskeeDS` — declarative design system (YAML) for TUIs; validates
  our declarative DSL approach.
- `renpenguin/gemini-py` — (x,y) coords-to-grid mapping. ⚠️ DEPRECATED for performance
  (ported to Rust `gemini-engine`): study the design, don't adopt its runtime.
- `ondras/rot.js` — JS roguelike toolkit: per-cell loops, FOV, tilemaps.

### 11.6 Shades — per-cell colour transforms

```qbsk
shade <name> [x: <n>] [y: <n>] [radius: <n>] [tint: <colour>] [strength: <n>] [speed: <n>]
```

A shade is a pure function of `(cell, x, y, gameTime)` applied over the composed canvas
**before** the caller diffs it. It changes **colour only** — geometry stays decided
entirely by the primitives, and a shaded frame's `renderText()` is byte-identical to an
unshaded one. That is what makes "shader" mean something on a character grid.

| Name | Effect | Parameters it reads |
|---|---|---|
| `radial` | falloff from a point — torchlight, an explosion flash | `x`, `y`, `radius` |
| `grade` | uniform wash — night grading, a damage tint | — |
| `pulse` | breathes on the game clock | `speed` |
| `scanline` | banding on odd rows — a CRT feel | — |

All four take `tint` (a colour name; default is "darken towards black") and `strength`
(0..1, default 0.3). Shades compose: several in a scene apply in declaration order, and
each obeys the per-primitive state directives, so `visible:` gates one exactly as it
gates a `put`.

**Defaults are deliberately gentle.** A bare `shade grade` darkens rather than washes, so
adding one to an existing scene is a nudge and not a repaint.

**Two decisions worth knowing:**

- **`radial` divides x by the 2.0 cell aspect**, because a cell is about twice as tall as
  it is wide. Without that, a light with `radius: 10` comes out as an ellipse.
- **A default-coloured cell (`fg` = -1) is left alone**, never graded. Giving "no colour
  set" a colour would make unstyled cells suddenly opinionated, and a scene that never
  mentions colour should stay monochrome even under a shade.

**Why the set is fixed rather than user-programmable.** A 120×40 grid is 4800 cells. A
shade written in QBSK would mean 4800 interpreter calls per frame, and `bench/baseline.md`
measures the interpreter at **96 % of frame cost for a three-primitive scene**.
Programmable shades are the more flexible design and the wrong one until the interpreter
is far cheaper; the trade-off is recorded in `src/engine/shade.ts` so it can be revisited
when that changes rather than rediscovered.

**Implementation note that matters beyond this feature.** `Canvas` initialises its grid
with `new Array(w * h).fill(DEFAULT_CELL)`, so every untouched cell is the *same object*.
`applyShades` therefore replaces cells instead of mutating them — mutating in place would
rewrite the shared default and bleed colour into every unwritten cell of every canvas
alive in the process.

### 11.7 Projection — `project()`

```qbsk
const cam = {"x": 0.0, "y": 0.0, "z": -10.0, "tx": 0.0, "ty": 0.0, "tz": 0.0, "fov": 60.0}
var p = project([3.0, 0.0, 0.0], cam, 80, 24)
visible: p[3]
put "!" at (p[0], p[1])
```

Turns a world point into a grid coordinate. The smallest useful piece of "ASCII 3D",
and useful entirely on its own: anchoring a label to a 3D position needs this and
nothing else.

**The camera is an ordinary dict**, so this needs no new syntax: `x`/`y`/`z` for the
eye, `tx`/`ty`/`tz` for the target, `fov` in degrees, and an optional `aspect`.
Missing keys take defaults.

**Returns a list** — `[u, v, depth, visible]` — because a caller almost always feeds
it straight into a `put`.

**`visible` means "in front of the camera", not "on screen".** A point can be visible
and still project outside the grid; clipping to the viewport is the caller's business,
and `put` already clips silently. Only the near plane is decided here.

**`aspect` is a parameter, not a constant.** A cell is roughly twice as tall as it is
wide, so a horizontal offset must be scaled or a cube projects as a rectangle. The
default of 2.0 suits a typical terminal, but `studio/renderer/fit.ts` already carries a
**per-font** ratio — Unifont is 0.50 em wide, JetBrains Mono 0.60 — and hard-coding one
value has caused a real sizing bug here before. A renderer that knows its font should
pass its own.

**No matrix library, deliberately.** Matrices earn their keep when thousands of
vertices share one cached transform — a rasterizer's problem, and there is no
rasterizer yet. The same arithmetic done directly is shorter, has fewer places to be
wrong, and is exactly as correct. `Mat4` arrives with the thing that needs it.

**Degenerate cameras return `visible: false` rather than NaN:** an eye that coincides
with its target, and a camera looking straight up or down (where the world-up vector is
parallel to the view axis and the usual cross product collapses — that one falls back to
a second reference and still works).

Cells are **rounded, never truncated**. Truncation biases every coordinate toward the
origin, which reads as jitter when a camera pans slowly.

### 11.8 Depth testing — `put ... depth:`

```qbsk
var p = project(corner, cam, 70, 26)
put "@" at (p[0], p[1]) depth: p[2]
```

`src/engine/depth.ts` holds a flat `Float32Array` beside the cell grid, reset with
`.fill(Infinity)` and never re-allocated per frame — allocation inside the composition
path is the first anti-pattern the ASCII-3D research names. Its index arithmetic is
deliberately identical to `Canvas`'s (`y * width + x`) so the two grids stay in step.

**It answers one question:** is this fragment nearer than whatever already wrote here?
Two glyphs landing on the same cell then resolve by distance instead of by which was
declared last.

- **A scene that never says `depth:` composes exactly as before, byte for byte.** That
  is the compatibility guarantee, and it is what lets every existing golden keep
  passing untouched.
- **Depth is per CELL, not per string.** `put "FFFF" ... depth: 20` competes character
  by character, so a nearer glyph wins only where it actually lands.
- **Equal depths keep the FIRST writer.** Ties are common on a character grid — a whole
  face can share one depth — so they fall back to declaration order, the rule the rest
  of the engine already uses.
- **Off-grid fails rather than throwing.** The canvas clips silently; a depth buffer
  that threw where the canvas shrugs would be a trap for exactly the code that draws
  projected points.
- **A non-finite depth never claims a cell**, so an unprojectable point cannot poison
  the buffer.

Negative depths are ordinary values here: deciding what is behind the camera is
`project()`'s job (§11.7), not the buffer's.

### 11.9 Glyph density ramps — `glyph()` and `lit()`

```qbsk
var p = project(corner, cam, 70, 26)
put glyph(lit(p[2], 14.0, 30.0)) at (p[0], p[1]) depth: p[2]
```

| Native | Returns |
|---|---|
| `glyph(intensity)` | a character from the default ramp `" .:-=+*#%@"` |
| `glyph(intensity, ramp)` | ... from a ramp given as a string |
| `lit(depth, near, far)` | intensity in [0, 1] — 1 at `near`, 0 at `far` |

This is the piece that makes a character grid read as a **lit surface** rather than a
stencil. With `project()` (§11.7) a shape has position, with `depth:` (§11.8) it has
occlusion, and with a ramp it has shading. `examples/cube.qbsk` composes all three.

**`glyph()` decides a CHARACTER; colour is `shade`'s job** (§11.6). Keeping them apart
means a scene can shade by glyph alone on a monochrome terminal, by colour without
touching glyphs, or both.

- **The default ramp starts with a space**, so an unlit surface disappears rather than
  sitting there as a faint dot. A scene that wants a visible floor passes its own ramp
  beginning at `.`.
- **Steps are equal-width buckets** — step *k* covers `[k/n, (k+1)/n)`. `floor`, not
  `round`: rounding would give the first and last buckets half the width of the others
  and quietly bias the whole image.
- **Intensity is clamped, not rejected.** Shading maths routinely overshoots by a
  hair — a dot product just over 1, a falloff just under 0 — and throwing on those
  would force every caller to clamp defensively first.
- **`lit()` exists so the direction cannot be got backwards.** Inverting it makes
  distant things bright, which reads as a bug in the geometry rather than in the
  shading. A degenerate range (`far <= near`) does not divide by zero, and an
  unprojectable depth is unlit rather than NaN.

Reversing a ramp is just passing it reversed — `glyph(i, "@%#*+=-:. ")` — for dark
glyphs on a light terminal.

### 11.10 Time-indexed particles — `particle()`

```qbsk
const embers = {
    "x": 34.0, "y": 20.0, "count": 40, "life": 2.6,
    "speed": 7.0, "angle": 90.0, "spread": 26.0,
    "fall": 0 - 2.0, "drift": 1.4, "seed": 7,
}

var p = particle(i, gameTime(), embers)
put glyph(1.0 - p[2], " .:*oO") at (p[0], p[1])
```

`particle(index, t, spec)` returns `[x, y, age]` — a cell position and an age in
`[0, 1)`, `0` at birth and approaching `1` at death.

**It is a closed-form function of `t`, not a simulation.** Nothing accumulates and
nothing is stored between frames; particle 17 at `t = 90.0` is computed directly,
never by stepping 90 seconds. This is the same discipline as tweens (§11.3) and
frame-swapping (§11.4), and it buys three things a stateful emitter cannot:

- **Frame rate cannot change the picture.** At 5 fps or 200 fps, `t = 3.0` is the
  same frame — so a golden can pin a particle effect at all.
- **Time is seekable.** Jump the play head anywhere and the effect is already correct;
  there is no warm-up.
- **A reload does not restart the fire.** The scene rebuilds, `gameTime()` carries on,
  and the embers are where they should be.

| Key | | Meaning |
|---|---|---|
| `count` | required | how many particles; valid `index` is `0` to `count - 1` |
| `life` | required | seconds from birth to death, then the particle is reborn |
| `x`, `y` | `0.0` | the emitter, in cells |
| `speed` | `5.0` | cells per second at birth |
| `angle` | `90.0` | degrees, `0` right and turning **anticlockwise**, so `90` is up |
| `spread` | `20.0` | half-angle of the cone, in degrees; `0` is a beam, `180` a burst |
| `fall` | `0.0` | downward acceleration, cells per second squared |
| `drift` | `0.0` | sideways wander, in cells |
| `seed` | `1` | changes the layout without changing the shape |

- **`angle` is anticlockwise so that up is `90`.** The grid's y grows downward, so the
  screen-faithful spelling of up would be `-90`. Smoke, sparks and fountains all go up,
  and the common case should read as the plain number rather than the negative one.

  > **Correction (2026-08-08).** An earlier version of this paragraph justified the
  > choice by claiming QBSK has no unary minus. **It does** — `-90`, `[-5]` and
  > `{"fall": -2.0}` all work, verified by running them. The decision stands on its own
  > merits; the reason given for it was false, and a false statement in the spec is the
  > exact failure this project keeps being bitten by, so it is corrected rather than
  > quietly edited away.
- **`fall` is named for its effect, not its sign:** positive falls, and smoke rises with
  a negative one. A field called `gravity` would have forced a choice between agreeing
  with `angle` and agreeing with the screen; naming it for what it does removes the
  question instead of answering it.
- **Births are staggered** — particle *i* is born at `i / count` of the way through a
  lifetime — so an emitter produces a steady stream from its first frame rather than
  pulsing all `count` at once, and it looks right on the very first frame instead of
  needing a second to fill in.
- **x is scaled by the cell aspect** (2.0, as in §11.6 and §11.7), so a `spread: 180`
  burst is round on screen instead of an ellipse squashed to half height.
- **The randomness is the audio PRNG** (`docs/audio.md` §2), seeded per particle. There
  is one seeded generator in QBSK and this is it; `random()` remains the language's
  only non-deterministic source and still cannot appear in a golden.
- **An unknown key is an error, not a shrug.** `"lifetime"` instead of `"life"` would
  otherwise leave every particle on the default and look like a physics bug.

### 11.11 Drawing in a loop

A layer body is ordinary QBSK, and anything it draws is collected — including from a
`while`, an `if`, or a function it calls:

```qbsk
layer fire z: 2
    color fg: bright-yellow
    var i = 0
    while i < 40
        var p = particle(i, gameTime(), embers)
        put glyph(1.0 - p[2], " .:*oO") at (p[0], p[1])
        i += 1
```

Before this, a layer drew only what was written directly in its body: a `put` inside a
loop ran, produced its primitive, and the primitive was dropped. Forty embers meant
forty hand-written `put` lines, and an emitter whose `count` was a variable was simply
not expressible.

- **Execution order is the collection order**, so a state directive above a loop
  applies to everything the loop draws, exactly as it applies to a primitive written
  in place. `color fg:` before a `while` colours the whole loop.
- **A function called from a layer body can draw.** This is the reusable-widget door:
  a `func healthbar(x, y, pct)` full of `put` and `box` becomes something a layer
  calls, and it works because a drawing function is just a body whose primitives are
  collected like any other.
- **Outside a layer nothing changed.** The collector exists only while a layer body is
  evaluating; a `put` in a plain function still evaluates to a value nobody keeps.
- **A `tone` inside a loop keeps a distinct identity** — numbered within its
  statement — so that re-composing a frame is still "the same tones", not a fresh set
  of sounds every frame (docs/audio.md §4).
- This does **not** make a layer imperative. It is still evaluated fresh every frame
  from live state, and it must still be a pure function of that state — a loop reading
  `gameTime()` is deterministic, a loop reading `random()` is not, and only the first
  can be pinned by a golden.

### 11.12 The masked map — `put ... mask:` (an earlier release)

§11.11 makes the loop expressible. This makes the commonest one unnecessary.

The dominant shape in a real game is a **constant map drawn through a changing mask**:
the level never moves, but what the player can see does. Written as a loop it is

```qbsk
layer floor z: 0
    for y in 0..H
        for x in 0..W
            if seen[y][x] != " "
                put MAP[y][x] at (x, y)
```

which re-reads a constant `MAP` 2×640 times per frame in `crypt.qbsk` alone. The layer is
**dynamic** — `seen` changes every turn — so §9.1's static cache cannot touch it. Measured:
`crypt.qbsk` spends 0.870 ms/frame in script, `turns.qbsk` 1.892 ms, and across all 39
examples 27 of the loops inside dynamic layers are this exact shape.

The same picture, as one composite:

```qbsk
layer floor z: 0
    put MAP at (0, 0) mask: seen
```

**Why `put` and not a new keyword.** `put` already draws glyphs at a position, already
carries a closed named-argument set (`depth:`), and adding `mask:` to that set is an
addition to an existing construct rather than a new one. It sits where every named
argument in the language sits — after the positional clauses, beside `depth:` — so there
is one place to look for it and no second spelling of anything. §17.1 freezes 51 keywords, and a
new keyword is a minor bump paid for in the lexer, the parser, the AST printer and every
tool that walks them. `mask` is an ordinary identifier in named-argument position, so this
costs no token and no keyword. A `stamp` statement and a `stamp` native were both
considered: the statement adds the keyword this avoids, and a `stamp` native cannot work
at all — a native returns a *value*, and `put` mounts a value as one line of text, so the
composite could never emit more than a row.

**The rule is one sentence: a space in the mask hides the cell, any other character shows
it.** That is not a new convention — `sight()` already answers in exactly that alphabet
(`"."` visible, `" "` not), and a hand-kept remembered map is built from the same two
characters. It is why `crypt`'s `!= " "` and `turns`'s `== "."` are the same test written
twice.

- **`put MAP at (x, y) mask: seen` is byte-identical to the loop it replaces.** Cell
  `(col, row)` of the map is drawn at `(x + col, y + row)`, in row order then column
  order, if and only if `mask[row][col]` is not a space. Nothing else is written: an
  unmasked cell is not painted with a space, it is **not painted**, so the layer below
  shows through. Blitting a sprite is the opposite contract (§7) and would be wrong here.
- **The mask must cover the map**: at least as many rows, and each row at least as long as
  the map row beside it. That is precisely the in-bounds condition the loop needs, so no
  program that works as a loop can fail as a composite. A mask that does not cover reports
  with the two sizes named.
- **Both must be lists of strings**, the same shape `path()` and `sight()` already
  take (§13.1). Anything else reports the type it found.
- **The layer's state directives apply unchanged.** `color`, `z:`, `visible:`, `world:` and
  `depth:` mean here what they mean for any `put`; `depth:` competes per cell, as §11.8
  specifies.
- **The loop form is not deprecated.** It stays legal, it stays specified, and a test pins
  that both forms produce identical bytes on the same map and mask. A composite that only
  covers the common case must not make the general case wrong.

**`put` with a list, and no `mask:`, now reports.** It used to stringify it: `put MAP at
(0, 0)` on a two-row map drew `[ab, c` — the list rendered as text and clipped at the
canvas edge. That is a §15 silent-wrong-value, and it is closed here rather than left
beside the feature that gives the construct meaning. The error names the replacement:

```text
put draws one line of text; to draw a list of rows through a mask,
use 'mask:' — put MAP at (0, 0) mask: seen
```

Scalars are untouched: `put int(gameTime() * 10) % 60 at (14, 0)` still stringifies, as
`examples/hud.qbsk` has always relied on.

**Composition cost.** The composite mounts as a single bulk primitive carrying the cells it
resolved, not as N `put`s — the same discipline §9.1 states for the static cache, and for
the same reason: a per-cell primitive would move the loop from the interpreter into the
compositor rather than removing it.

### 11.13 A canvas drawn into a layer — `put <canvas>`

`canvas(w, h)` builds an off-screen grid that `put`, `box`, `line` and `fill` draw into
(§7). Getting the result onto the screen was broken: `put c at (x, y)` stringified the
canvas — `qbskStr` on a canvas is `renderText()`, which is multi-line — and wrote it into a
single-line text primitive. The newlines ended rows early, so an 8x4 scene came out as

```text
........
.####          <- five characters in an eight-wide row
##             <- a fifth line, past the scene's declared height
........
........
```

no error, a malformed grid, and the scene's own dimensions violated. It is the §15
silent-wrong-value shape, and the same one §11.12 closed for a list.

**A canvas now blits.** `put c at (x, y)` copies the canvas's cells to the layer with its
top-left at `(x, y)`, **colours and attributes included** — a canvas cell already carries
`fg`, `bg` and `attrs`, and dropping them would make the off-screen path unable to express
anything the on-screen one can.

- **A cell with no colour of its own takes the layer's.** `-1` is "no opinion" in the cell
  model, and the canvas natives are monochrome today, so every cell of a hand-drawn canvas
  says nothing about colour. Letting `-1` win would make a `color fg: red` above the blit
  do nothing at all — a directive evaluated and dropped, which invariant I2 forbids. A cell
  that does carry a colour keeps it, so a coloured plot survives being blitted.

- **It is opaque, unlike `mask:`.** Every cell of the canvas is copied, spaces among them.
  A canvas is an image with a known extent, not a sparse overlay: the author sized it and
  drew into it, so its blank cells are part of what it says. §11.12's transparency exists
  because a mask marks absence; a canvas has none to mark. `fill(c, " ")` then blitting is
  how you deliberately erase a region.
- **Off-grid clips**, as everywhere else: a canvas hanging over an edge draws the part that
  lands and discards the rest, rather than throwing.
- **`depth:` applies per cell** if given, exactly as §11.8 specifies.

It is also what makes the subcell natives (§11.14) reachable from a scene: they draw into
a canvas, and this is how a canvas arrives.

### 11.14 Subcell resolution — `plot()` and `braille()` (an earlier release)

A character cell is about **one wide and two tall**. That ratio is the reason ASCII
pictures look squashed, and it is also the opening: split the cell horizontally and each
half is about **one by one — square**. `plot()` draws into that doubled grid, so a canvas
`w` x `h` addresses `w` x `2h` subpixels and a circle drawn at 1:1 in subpixel space comes
out round.

```qbsk
var c = canvas(40, 12)              // 40 x 24 subpixels
plot(c, (20, 12), "bright-cyan")    // x in cells, y in half-cells
```

| Native | Grid | Colour | For |
|---|---|---|---|
| `plot(canvas, (x, y), colour)` | `w` x `2h`, square subpixels | per subpixel | curves, shapes, anything shaded |
| `braille(canvas, (x, y))` | `2w` x `4h` | none | dense monochrome plots, trails, minimaps |

Both take the position as a tuple, as `put`, `box` and `line` on a canvas already do —
the phase document's strawman spelled the coordinates apart, and consistency with the
four natives beside them won.

**The four states of a plotted cell, and the one that matters.** With two subpixels a cell
can be empty, top-only, bottom-only or both, and every one has a glyph:

| Lit | Glyph | Colour |
|---|---|---|
| neither | unchanged | — |
| top | `▀` | fg = the top subpixel's |
| bottom | `▄` | fg = the bottom subpixel's |
| both, same colour | `█` | fg = that colour |
| both, different colours | `▀` | **fg = top, bg = bottom** |

The last row is the whole trick. `▀` paints its upper half in the foreground colour and
leaves the lower half showing the background, so one cell carries two independently
coloured pixels. Nothing else in the engine can do that, and it is why `plot` takes a
colour per call rather than inheriting one.

**Plotting accumulates.** A second `plot` into a cell that already holds a half-block reads
what is there and resolves the pair, which is how `▀` then a bottom subpixel becomes `█` or
a two-colour `▀`. A cell holding anything else — a letter, a box character, whatever
`fill` left — is **replaced**, not merged: the engine cannot know which half of a `#` was
meant to survive, and guessing would be a §15 invention.

**Braille is the other end of the trade.** U+2800–28FF encodes eight dots in a 2 x 4 grid,
so `braille()` reaches four times the vertical resolution of `plot` and twice the
horizontal — at the price of colour, since the dots of one cell share a single foreground.
Use it where density beats hue: a curve, a trail, a minimap. The dot bits are the standard
ordering, low bit at the top-left:

```text
col 0  col 1        0x01  0x08
  .      .          0x02  0x10
  .      .          0x04  0x20
  .      .          0x40  0x80
```

**Off-grid clips**, as everywhere else in the engine. A subpixel outside the canvas is
discarded rather than throwing, matching `put`, `line` and the depth buffer.

**The font contract, stated rather than detected.** These glyphs must exist in the reader's
terminal font. Windows Terminal with Cascadia has them; `cmd.exe` with a raster font does
not. **No detection is attempted** — no capability detection exists anywhere in this engine
and none is added here. This is the same contract the box-drawing characters have had since
they first appeared in a golden (§11.2), and it is documented for the same reason: a
program that draws `╔` already assumes a Unicode font.

**Quadrants are deliberately absent, and the reason is geometric.** The phase document
proposed `▘▝▖▗▚▞▙▟` as a fallback "when a cell needs a 2x2 split". In a half-block system
no cell ever needs one: two subpixels have four states and all four have a glyph, so there
is nothing to fall back from. A 2x2 split is not a fallback but a **different trade** — it
buys twice the horizontal resolution and gives up the square pixel, because a quarter of a
1x2 cell is 0.5 x 1, exactly as lopsided as the cell was. Since square pixels are the
entire visual win here, that trade belongs to a caller who asks for it explicitly, not to a
silent fallback. None of E3's closing criteria name quadrants; its two-colour criterion is
this section's `▀` case.

### 11.15 The measured density ramp (an earlier release)

`glyph()` maps an intensity to a character through a ramp, and the default one is
hand-written: `" .:-=+*#%@"` (§11.9). "Does `%` cover more ink than `#`?" is a question
about a **font**, though, not an opinion — and the answer changes with the font. The
brief this phase comes from is blunt about it, and it is right.

QBSK has no glyph rasteriser and will not grow one: that means a canvas or a font
library, and the zero-dependency rule is load-bearing here. So the measurement takes its
pixels from where pixels already are — the same PNG path `spriteGen` uses — and the
rasterising happens **outside**, once, by whatever renders the author's terminal font.

```powershell
node bench/measure-ramp.mjs --png strip.png --glyphs " .:-=+*#%@" --out examples/res/ramp.qbdata
```

The strip is one image, one glyph per equal-width cell, left to right. The tool reads
each cell's mean ink and emits a `.qbdata` table:

```qbsk
use "res/ramp.qbdata" as ramp
put glyph(intensity, ramp.MEASURED["glyphs"]) at (x, y)
```

`glyph()` has always taken a ramp string as its second argument, so this is **a data
change, not an API change**. Nothing new is registered and nothing existing moves.

- **Coverage is a mean, not a threshold count.** A rendered glyph is antialiased, and
  rounding each pixel to ink-or-not throws away exactly the partial coverage that
  separates `.` from `,`. Alpha multiplies in, so a strip rendered onto transparency
  measures the same as one rendered onto white.
- **Luma is weighted (Rec. 601).** An unweighted mean would call a blue glyph lighter
  than a green one carrying identical ink.
- **Raw and normalised are both reported.** The raw numbers are what a person checks the
  measurement against; the normalised ones are what the ramp is built from, stretched so
  the lightest glyph reads 0 and the heaviest 1.
- **Ties keep their measured order, and duplicates are kept.** Two glyphs of equal
  density waste a bucket, but dropping one would make the emitted table disagree with the
  measurement it came from — and that agreement is the whole point.
- **`DENSITY_RAMP` does not move.** The measured table is an addition. Every existing
  golden renders through the old default, untouched.

**The brief's warning, kept and enforced.** *If the measured order comes out identical to
the hand-written guess, suspect the measurement.* The tool prints both and diffs them at
generation time, and says so out loud when they match. `--selftest` measures a synthetic
strip built at 0, ¼, ½, ¾ and 1 coverage and checks the pipeline reports those numbers
back — arithmetic knows the answer in advance there, so agreement means the measurement
measures what it claims rather than merely agreeing with a guess.

**The ramp belongs to a font, so the table is data.** A ramp measured from Cascadia is
wrong for someone running Iosevka. That is why this ships as a swappable `.qbdata` a
program `use`s rather than as constants compiled into the engine, and why the tool is a
tool rather than a build step.

`bench/measure-ramp.mjs` writes files, so — like the sprite generators — it is **not**
part of `npm run bench`. A gate with side effects is not a gate.

### 11.16 Orientation glyphs — `stroke_glyph()` and `line ... style: stroke` (an earlier release)

A ramp says how *much* ink a cell holds (§11.9). It cannot say which way the ink runs.
Two cells of equal density can be a horizontal edge and a vertical one, and a density-only
render draws them identically — which is why diagonal edges in ASCII look like gravel.

`stroke_glyph(dx, dy)` answers the other question, returning one of four:

| glyph | when |
|---|---|
| `─` | the stroke runs mostly across |
| `│` | mostly up and down |
| `╱` | diagonal, rising to the right |
| `╲` | diagonal, falling to the right |

**The aspect correction is the whole subtlety.** A cell is taller than it is wide, so a
stroke that moves one cell right and one cell down is not at 45° on screen — at the usual
1:2 it is at about 63°, and calling it `╲` is right only because the correction says so.
The angle is therefore taken in cell-shape-corrected space:

```
angle = atan2(dy * cellAspect, dx)
c     = abs(cos(angle))        // how horizontal the stroke is, 0..1
```

- `c > 0.87` → `─` — within about 29° of horizontal
- `c < 0.32` → `│` — within about 19° of vertical
- otherwise → diagonal, and the quadrant decides: `╲` when `dx` and `dy` share a sign
  (right-and-down, or left-and-up), `╱` when they differ. Screen `y` grows **downward**,
  which is why right-and-down is the falling glyph.

Without the correction a one-by-one step would read as `c ≈ 0.71` and land in the diagonal
band, which happens to be the same answer — so the correction looks free until a
two-by-one step, which is 45° on screen and must be diagonal, reads as `c ≈ 0.89` and comes
back `─`. The test suite pins both, because a correction that only matters in the cases
nobody checks is a correction nobody will keep.

**`cellAspect` is a parameter with a default of `2.0`, not a constant of nature.** It is
the cell's height divided by its width. `2.0` is correct for the default font and wrong
for half the others: `studio/renderer/fonts.ts` records each font's advance width, read
out of the font file rather than estimated, and GNU Unifont and Iosevka are 0.5 em (a 1:2
cell, so `2.0`) while JetBrains Mono and IBM Plex Mono are 0.6 em (so `1.667`).

The two aspects disagree for slopes between `dy/dx` **0.283 and 0.340** — derived, not
guessed: the horizontal threshold `c = 0.87` is 29.54°, whose tangent is 0.5668, so a
slope reads horizontal while `cellAspect * slope < 0.5668`. Inside that band the same
geometry draws `─` under one font and `╲` under another. Every example in this repo
happens to lie outside it, which is how the hardcoded constant survived an earlier release.

`src/` cannot read the font registry — the dependency arrow points `studio/ → src/` and
never back (docs/studio.md §2) — so the real ratio arrives as an argument from whoever
knows it. **Studio now sends it**: `cellAspectFor(chPerEm)` in `studio/renderer/fit.ts`
travels with `run` and `live` and reaches `SceneProgram`, so choosing JetBrains Mono
changes what is drawn and not only how it looks. The terminal renderer cannot know the
user's terminal font at all, and there `2.0` remains an assumption rather than a
measurement.

⚠️ **The 2.0 / 1.667 figures above are the ratio of the ADVANCE WIDTHS, and Studio's real
cells are taller than that.** A cell there is `chPerEm` em wide and **1.15** em tall — the
`.dom-grid` line height — so the shapes actually drawn are **2.30** and **1.92**. The
default of `2.0` is therefore wrong for all four registered fonts in Studio, not for two
of them, and it is nearest to Unifont rather than exact for it. The default does not move:
it is the terminal's documented assumption, and every golden depends on it.

An aspect that is not a positive finite number is **rejected**, which is the opposite
choice from `(0, 0)` below and deliberately so: a degenerate direction is ordinary data,
while an impossible cell shape is a caller stating something that cannot be true. Zero
would flatten every stroke to horizontal and a negative would mirror every diagonal —
both are pictures that look deliberate while being wrong (§15, I3).

This matters most in `edgeGlyph`, which an image converter uses to write glyphs into an
**asset**: a wrong aspect at draw time is a setting somebody can change later, while a
wrong aspect at conversion time is baked into the art and only a reconversion removes it.

**A zero vector has no direction**, and `stroke_glyph(0, 0)` returns `─` rather than
reporting — `atan2(0, 0)` is 0 by its own definition, and a throw here would force a guard
into every loop that walks a path and hits a repeated point. It is documented rather than
silent.

#### The `line` primitive

```qbsk
line (2, 2) to (30, 12) style: stroke
```

`line` has always drawn `*`, hardcoded. `style: stroke` makes it choose per cell from its
own direction instead. The named-argument set is closed, as §15.1's I1 requires, and
**absent means unchanged**: every scene that does not say `style:` draws the same `*` it
drew before, and every existing golden passes untouched. This is the same shape `box` and
`border` already use for their own `style:`.

#### Sobel, and where it is allowed to run

The second entry point is sampled rather than analytic: run a Sobel operator over a block
of pixels, and the gradient points **across** the edge, so the edge itself runs
perpendicular to it — `stroke_glyph(-gy, gx)`.

This lives **only in the offline sprite path** (`src/tools/spriteGen.ts`), where a pixel
grid genuinely exists. It is **not** a runtime feature and will not become one: at run time
this engine has no pixel source, and a native that pretended otherwise would be inventing
its input, which is what invariant I2 forbids. §11.15 draws the same line for the same
reason.

---

### 11.17 Converting a source image into a grid (an earlier release)

`src/tools/imageToGrid.ts` reads a picture and chooses a glyph per cell. It is offline,
like the Sobel pass above: at run time the engine has no pixel source, and a native that
sampled one would be inventing its input.

```
node bench/image-to-grid.mjs --png art.png --cols 120 --rows 40      --normalise --gamma 0.6 --out examples/res/scene.qbdata --name CELL
```

**The input has to be the art before it became ASCII.** Measured during an earlier release
spike: the project's first reference image was itself a glyph grid, with a dominant
horizontal period at 8 px. Sampling that at any other pitch beats against the period and
destroys the structure, and re-running at the source's own 192 columns only half fixed
it, because the information was already lost when the picture was rasterised into
characters. A render, a photograph or a painting converts; ASCII art converts twice and
arrives as mush.

**Tone mapping is not an optional flag.** On the reference render, raw luminance left
**78.9%** of cells blank — the image averages 0.068 and never rises above 0.77, so the
ramp's buckets went almost entirely unused. `--normalise --gamma 0.6` moved that to
**49.8%** and the scene became legible. Grid size, in contrast, changed nothing worth
reporting: 120×40, 200×60 and 220×64 all sat within a point of each other. The lever is
the curve, not the resolution.

**The score is a rank correlation, not a luminance error.** The first version of this
measured mean absolute difference between a glyph's ink and its cell's, and ranked the
unreadable conversion *above* the readable one: 3.27% error for raw against 6.97% for
tone-mapped, because an almost-black image is reproduced very faithfully by blanks. That
is correct arithmetic answering the wrong question. A tone curve is a **monotonic** remap
— it moves levels and preserves order — so what has to survive is the ordering of light,
and a rank correlation measures exactly that while staying blind to the curve, which is
an authorial choice rather than an error. The same two conversions score **52.45%** and
**91.68%** under it.

Ties get averaged ranks, and that matters rather than being a formality: the ramp has ten
steps and a grid has thousands of cells, so nearly every cell ties with many others.
Ranking ties arbitrarily would manufacture disagreement out of the quantisation itself.

**The API carries more than the file does.** `convertImage` returns the glyphs, the
per-cell intensity, the intensity *before* the tone curve, and the per-cell colour. The
generated `.qbdata` carries only the glyphs. That is deliberate and reversible: the
converter is deterministic and the source render is checked in beside it, so a scene that
later wants a flickering torch or the art's two light temperatures reconverts rather than
every asset carrying 12,000 floats nobody reads yet.

**Edge glyphs take the cell aspect** (§11.16), and it matters more here than anywhere
else: a converter writes those glyphs into an **asset**. A wrong aspect at draw time is a
setting somebody changes later; a wrong aspect at conversion time is baked in.

`examples/jail_scene.qbsk` is the demo, converted at 120×40 with the ordering preserved
at 91.68%.

⚠️ **The tool writes files, so it is not part of `npm run bench`** — a gate with side
effects is not a gate. It is listed among the writers in `tests/unit/bench-gate.test.ts`.

⚠️ **There is no primitive for blitting a plain block of rows.** `put <list>` is reserved
for a masked map (§11.12), so a converted backdrop is drawn a row at a time in a loop.
Converted art is the first thing that wants one; recorded here rather than worked around
in silence.

### 11.18 The cinematic vocabulary (an earlier release)

`examples/lib/cinematic.qbsk` is a QBSK library, not a set of natives, and that is the
whole design. `border` draws the box, `put` draws the text, `timeline_*` already
schedules beats and `animate` already moves figures — what was missing was composition,
and composition belongs in a library. Spending frozen native surface (§17.1) on what the
language can already express is how a small language stops being small.

| Function | What it answers |
|---|---|
| `cine.wrap(speech, width)` | the lines a string breaks into |
| `cine.box_height(speech, width, speaker)` | how tall the box must be, asked BEFORE drawing |
| `cine.box_lines(speech, width)` | the wrapped body, ready to draw |
| `cine.beat_at(tl, t)` | which scripted line is speaking, or -1 |
| `cine.beat_progress(tl, t, i)` | how far through its own beat, for a reveal |
| `cine.entrance_x(from, to, enters, seconds, now)` | where a figure is while walking in |
| `cine.on_stage(enters, until, now)` | whether to draw it at all |

These are module members reached through `use`, not natives — the table writes them
with the prefix a caller actually types, so nothing here reads as engine surface.

**Wrapping was the one real gap**, and it stayed in QBSK. A word longer than the line
overflows rather than being cut: truncating loses characters silently, and a name that
runs past the frame is a bug the author sees while a name missing three letters is one
only a reader finds. Empty or blank input returns **one** empty line, never zero — zero
would collapse a box to its border and read as a rendering fault. A width below 1 returns
the string unbroken, which is visibly wrong at the call site rather than an infinite loop.

`examples/cell_block.qbsk` is the demo, and it is where F1 and F2 meet: the set is 4,800
glyphs converted from a photograph (§11.17), and the dialogue, the speakers and the
physician walking in all come from this library. Measured at **1.072 ms/frame** with the
box active, against the 2 ms budget — and that is with the backdrop recomposing every
frame, because it reads a `use`d module binding and the classifier calls those volatile.

⚠️ **A scene seeds its own first frame.** The scene block composes once at startup,
before any tick has run (language.md §7.7), so a cinematic whose state starts blank pins
an empty dialogue box as its golden and nobody notices until the loop runs.

⚠️ **`text` and `at` are reserved** and cannot be parameter names — both were hit while
writing this library, after `world` was hit writing a benchmark. Worth knowing before
naming a function's arguments the obvious thing.

### 11.19 What a layer reads, and the mutation epoch (an earlier release)

E1 asks one question of a layer — *is this static forever?* — and gets one bit. A view
that changes only when the player acts is neither answer: it is stable between actions
and different after one. Answering that needs two things E1 never collected.

**`LayerStaticity.reads`** — the top-level names a layer depends on, helper calls
followed. `analyzeLayerStaticity` walks the raw AST rather than re-implementing the
expression grammar, because a node shape it failed to recognise would be a name silently
dropped, and a dropped name is a layer held stale.

**The mutation epoch** — a counter on the interpreter, bumped whenever a value is edited
**in place** rather than rebound. Identity cannot answer whether a list or dict changed:

```
d["k"] = v        // same object, different contents
push(list, x)     // same object, different contents
```

and module dicts are mutable too, despite §5 of the language spec calling them immutable
(`tests/unit/module-mutability.test.ts` pins both the direct form and the aliased one).

**Rebinding does not bump it, and that is the design.** A frame whose `on tick` only
assigns — which is most of them — must leave the cache intact, or the cache never hits
and the whole mechanism buys nothing. Rebinding is caught by comparing the read values;
the epoch exists only for the edits comparison cannot see.

**One counter for the whole program, not one per value.** It is conservative in the safe
direction: any edit anywhere invalidates every invalidation-cached layer, and on a frame
where nothing was edited that conservatism costs nothing — which is the frame the cache
exists for. Per-value versions would be less blunt and would require every mutation site
to know which value it touched. That is a larger surface for the one failure that matters
here: a layer held stale because a site forgot to report.

`MUTATING_NATIVES` is read out of `natives.ts` by hand — `push`, `pop`, `sort`,
`reverse` — so `tests/unit/mutation-epoch.test.ts` calls each and checks the epoch moved.
A mutator added later without being listed fails there rather than going quiet.

**`readTracked` is the bit that makes `reads` usable.** A layer is `readTracked` when
asking the classifier for a reason with name-reads SUPPRESSED returns nothing: whatever
survives that suppression is dynamism the read set cannot represent, and `untracked`
names it. Running the same classifier twice, rather than writing a second one, is what
keeps the two answers from disagreeing.

Checking the `reason` string instead would be unsound — `reason` reports the FIRST source
it finds, so a layer that reads a var *and* calls `gameTime` reports the var and looks
safe. `tests/unit/layer-read-tracking.test.ts` holds exactly that case.

Measured across `examples/` (156 layers): **70 static**, **64 dynamic but read-tracked**
— the population an invalidation cache can serve — and **22 dynamic and not**, whose
reasons are `calls gameTime` (9), `uses animated sprite frames` (6), `calls turn` (3),
`calls animate` (2), one indirect call and one depth test.

⚠️ **`reads` is necessary and not sufficient.** `collectReads` adds a name only when it
is a TOP-LEVEL binding, and a native call is not one. A layer whose only source of change
is `gameTime()` or `random()` therefore collects **nothing**, and would satisfy "none of
my reads moved" on every frame forever. The analyzer does flag them — "calls gameTime",
"calls random" — which is what keeps E1 safe, because E1 caches only what it proved
static. The invalidation cache is aimed at dynamic layers, which is exactly where that
protection stops. **A layer may be reused on the strength of its reads only when its
reads are the whole story**, and `reads.size === 0` on a dynamic layer is proof that they
are not. Pinned in `tests/unit/invalidation-cache.test.ts`.

**The cache, measured.** A layer in `layerReads` is reused when the mutation epoch has
not moved AND every recorded read still resolves to the same thing. Scalars compare by
value, everything else by identity: `beat = beat_at(...)` rebinds a fresh box every frame
while holding the same integer for seconds, which is exactly the shape a dialogue scene
has, so identity alone would miss on every frame of it. Lists and dicts compare by
identity because comparing contents is the O(size) walk the cache exists to avoid — and
in-place edits are the epoch's job, not this comparison's.

| Scene | No cache | Cached | | Hits / misses |
|---|---|---|---|---|
| `awakening.qbsk` | 0.275 ms | **0.182 ms** | 1.52× | 3439 / 249 |
| `jail_scene.qbsk` | 0.121 ms | **0.072 ms** | 1.69× | 460 / 1 |
| `cell_block.qbsk` | 0.276 ms | **0.181 ms** | 1.53× | 875 / 47 |

**Mutations of things born inside the layer do not count.** The epoch is global, and
before this it cost `cell_block.qbsk` everything: its two eligible layers missed on
*every* frame, because `cinematic.qbsk`'s `wrap` calls `push` on a list it just created,
`push` genuinely mutates in place, and one bump anywhere invalidated the whole frame.
0 hits against 922 misses, on layers with no connection to any of it.

A container created while a layer is being composed cannot be observed by any *cached*
layer: every entry in the cache was written before this layer began, so none of them can
reach something that did not exist then. Becoming observable requires attaching it to
something older, and attaching is itself a mutation of that older thing, which bumps.
O(1) per mutation, no walk.

⚠️ **Per LAYER, not per composition** — the first attempt scoped it to the composition
and was wrong. A list created at the top level would be exempt while a layer evaluated
after it is cached holding a reference, so an edit later in that same top-level run bumps
nothing and the layer is reused stale. `mutation-epoch.test.ts` turned four cases red at
once. Outside a layer the exemption does not exist at all: a tick handler runs between
compositions, so every cached layer predates it.

**Missing a birth is safe.** An unrecorded container is treated as old, the epoch bumps,
and the cache is merely more conservative — so only the interpreter's own list and dict
literals are recorded. Natives returning fresh lists (`split`, `map`, `slice`) are not,
and adding them can only raise the hit rate.

Per-object revisions are *not* the answer: a layer reaching `art.CELL["lines"]` would
need the revision of every object on the path, which is the O(size) walk again.

⚠️ **`layerReads` is the eligibility list, and absence is how ineligibility is said.**
There is no second test in `evalLayerValue`. A layer that is dynamic and not read-tracked
is simply never put in the map, so a future change that widens the map is the one place
that can break the guarantee.

### 11.20 What a layer produces, and what it registers (an earlier release)

Evaluating a layer does two things, and until now only one of them was a value.

It **produces** `primitives` — the cells the compositor paints. It also **registers**:
a `tone` writes no cells at all and contributes to the frame's audio plan (docs/audio.md
§4), and a `shade` contributes to the shade plan. Registration used to happen by pushing
straight onto the interpreter as the body ran, which works perfectly for as long as every
frame rebuilds every layer — and stops working the moment one does not.

The static cache (§11.16) already did not rebuild them, and it was safe here only by
**exclusion**: `analyzeLayerStaticity` returns "uses tone" or "uses shade" as a reason to
call a layer dynamic, so a cached layer never had effects to lose. That is a whitelist,
and §14 is a catalogue of what this project's whitelists do. The F4 invalidation cache
reached the same layer values by a path the exclusion does not guard, and a `tone` inside
a layer went silent after frame one — caught by the tone, timeline and E1 suites, none of
which is about caching.

The fix is not a narrower cache. A layer now carries a `LayerEffects` record of what it
registered, and both paths — the one that builds it and the one that reuses it — go
through `replayLayerEffects`. There is one way for a layer's effects to reach a frame, so
"built" and "reused" cannot drift apart.

Visibility is resolved when the effect is **recorded**, not when it is replayed: a `tone`
under `visible: false` is absent from the list rather than filtered on the way out. Replay
never re-decides what registration decided, which is what keeps the two paths identical
instead of merely similar.

`tests/unit/layer-effects.test.ts` forces layers into the cache rather than asking the
analyzer for them, because the property being held is the one the exclusion was standing
in for. The visibility case carries a hidden tone *and* a visible one on purpose: with
only the hidden one, `[0, 0, 0]` is also what an implementation that recorded nothing at
all would return, and the assertion would pass for the wrong reason.

### 11.21 Wall casting (an earlier release)

`raycast(rows, camera, columns, range, blocked)` walks a tile map and returns one wall
hit per screen column: `[distance, side, tile, hit]`, mirroring `project`'s positional
list rather than inventing a second convention beside it.

**DDA, not fixed-step sampling.** Stepping along the ray by a small increment and testing
each sample is easier to write and wrong in a way that shows: it misses walls thinner
than the step, and it costs the same whether the wall is adjacent or across the map. DDA
visits each tile boundary exactly once, so it is both exact and proportional to the
distance actually travelled.

**`distance` is perpendicular, measured along the camera's forward axis rather than along
the ray.** The two differ by the cosine of the ray's angle from centre, and drawing the
ray's own length bows a flat wall into a barrel — the fisheye every first raycaster has.
Correcting inside the caster means every consumer gets a flat wall without knowing why.

**`side` is which face was crossed**, `"x"` for a north-south wall and `"y"` for an
east-west one. The classic renderer darkens one of the two, which is what makes a corner
readable with no lighting model at all.

**Anything off the map is solid.** Reading past the array and getting `undefined` is how
a caster returns NaN and paints one garbage column that nobody can trace back.

**The camera is 2D and deliberately not `project`'s.** That one needs an eye, a target
and a cell aspect because it answers where a point in a room lands on screen. A wall
caster walks a grid, so it needs a position, a facing and how wide it sees; asking it for
a `target` would be asking for a number it has no use for. Missing keys default, matching
`project`, so `{"x": 3.0, "y": 4.0}` is a usable camera.

**What is NOT here**, each its own decision rather than an oversight: texturing, sprite
casting, floor and ceiling casting, and doors. And the *drawing* is not here either — a
column is a `line` whose height falls with distance and whose glyph comes from a ramp,
and QBSK says all three already. Spending frozen native surface on what the language can
express is how a small language stops being small (§11.18).

**Billboards are QBSK, not engine.** `examples/lib/firstperson.qbsk` places an entity in
a cast view with `atan2`, a subtraction and a comparison against the wall distance the
caster already returned — the same argument that kept `cinematic.qbsk` (§11.18) out of
the engine. Two details in it are worth more than they look:

- **The entity's depth is PERPENDICULAR**, exactly as the wall's is. Measured radially it
  reads as further away than a wall it is level with, so it hides behind that wall at the
  edges of the view while standing in front of it at the centre.
- **The bearing is wrapped to −π..π.** A player facing just west of north and an entity
  just east of it differ by a few degrees of bearing and by nearly a full turn of raw
  angle. Without the wrap that entity is off screen while standing directly in front of
  the player — a bug that appears in one heading out of four and survives casual play.

**The guards are entities, and they move on turns.** `spawn` (§12.2) gives each a stable
`id` that survives every turn that moves it; the dicts are then mutated in place, because
dicts mutate per key while lists are index-immutable, so rebuilding the list would be the
awkward way round. One `path` step per guard per turn, and a guard stops when it is
ADJACENT: sharing the eye's tile puts a body at distance zero, which the height clamp
renders as a wall of glyphs across the whole frame. `len(route) > 2` and not `> 1` is what
enforces it — a route of two is guard-then-player, so its second entry IS the player.

**Occlusion is decided per column, not per figure.** A guard stepping out from behind a
pillar is half hidden for a moment; one test against the centre column pops the whole
body in at once.

⚠️ **An equivalent mutant lives in the step choice.** Swapping `<` for `<=` when picking
which boundary is nearer passes the entire suite. The tie needs `sideX === sideY`, which
needs an exact diagonal, and `Math.cos(PI/4)` and `Math.sin(PI/4)` differ by one ulp in
JavaScript — so no angle reaches it. Recorded in the source rather than answered with a
test that would pin floating-point noise as though it were a decision.

## 12. Entities and turns (an earlier release)

Everything in §11 animates: tweens, particles, shades and the caret are pure functions of
`gameTime()`. That is right for animation and wrong for a game. A goblin should move
because the player moved, not because 33 milliseconds passed.

So the engine has **two clocks**, and the whole of this section is about keeping them
apart and honest.

| | advances when | drives |
|---|---|---|
| `gameTime()` | real seconds pass | tweens, particles, shades, a blinking caret |
| `turn()` | the player acts | entities, AI, the simulation |

### 12.1 Where entities live, and why

**In QBSK, as ordinary dicts.** Measured, not assumed — `bench/entities.md`:

```
   500 entities    1.86 ms/turn
  2000 entities    4.88 ms/turn      (60-200x slower than TypeScript)
```

The ratio is real and is not the deciding number. The absolute cost is, and 2000 entities
in under 5 ms fits with three times the headroom — **because a turn is not a frame**.
That work on a keypress is invisible; the same work sixty times a second would not be.

What it buys is the reason to prefer it even at 160×: an entity is a plain dict in the
live environment, so `vars`, `get` and console evaluation reach it the moment it exists.
The debugging loop built in an earlier release works on the simulation for free, and a native store
would be invisible to all of it unless deliberately surfaced — work that would then have
to be kept in step forever.

Revisit past **~5000 entities per turn**, which is where the table crosses the frame line.

### 12.2 The one thing the engine has to add: identity

> ⚠️ **Correction (an earlier release).** This section was written before that release, and its opening
> premise — that the language rejects `list[i] = v` — **is no longer true**.
> `list[i] = v`, `dict["k"] = v` and their compound forms are valid assignment targets
> (`docs/language.md` §4.4), including nested targets like `goblins[i]["hp"] -= 1`, and
> lists and dicts are by reference (§5.3), so a function can mutate an entity its caller
> holds. A turn CAN update an entity in place today.
>
> The correction was found the hard way: an agent read this section and the matching
> comment in `examples/turns.qbsk`, believed rebuilding was forced by the language, wrote
> a whole list rebuild to subtract one point of HP, and reported the resulting verbosity
> as a missing language feature. A stale claim in a spec does not merely fail to help —
> it actively produces wrong work, which is the reason this correction is written here
> rather than the paragraph quietly deleted.
>
> **Everything below about identity still holds**, for a reason that no longer depends on
> rebuilding: `find`/`without` return and produce *new* lists, entities are commonly
> filtered and re-collected, and a dict has no intrinsic name. Identity has to be a value
> the entity carries, whichever way the list is updated.

A turn may **rebuild the list**, accumulating with `push` — exactly as
`examples/cube.qbsk` rebuilds its projections — or it may mutate entries in place. The
rebuild is immutable by construction, so a half-updated turn can never be drawn; in-place
mutation is shorter and allocates nothing. Both are legitimate, and the choice is the
program's.

The rebuild path means every entity is a **new dict every turn**, which quietly destroys
identity: "the goblin that attacked me" cannot be referred to next turn, because that dict
no longer exists. Nothing else about the model is difficult; this is.

So an entity carries a reserved `"id"`: a stable integer that survives the rebuild.

```qbsk
var goblins = []
goblins = push(goblins, spawn({"x": 4, "y": 9, "hp": 6, "kind": "goblin"}))

var attacker = find(goblins, lastAttackerId)   // null if it died
```

| Native | |
|---|---|
| `spawn(components)` | the dict plus a fresh `"id"` |
| `find(entities, id)` | that entity, or `null` |
| `without(entities, id)` | the list minus that entity |

- **Ids come from a counter, not from randomness**, starting at 1 and incrementing. The
  same program spawning the same things in the same order always produces the same ids,
  which is what lets a turn sequence be pinned by a golden. `random()` remains unusable
  in anything a golden observes.
- **`find` returns `null` rather than reporting.** An entity that died is the normal case
  in a simulation, not an error — a corpse is not a bug.
- **`spawn` refuses to overwrite an existing `"id"`.** Silently renumbering an entity
  would break exactly the identity this exists to provide, so it is an error with a span.

### 12.3 The turn clock

A turn advances only when something advances it. **Never on a timer** — that would make it
a second frame clock and defeat the entire point.

```qbsk
on key "arrow-right"
    playerX += 1
    advance()          // moving costs a turn

on key "i"
    showInventory = true   // opening a bag does not

on turn(n)
    // every entity acts, once
```

`advance()` does not run the handlers itself. It **requests** a turn, and the requests
drain in their own stage of the frame, after keys and before composition — extending the
order fixed in `docs/language.md` §7.7:

```
  1. on start            once
  2. on tick(dt)         the animation clock has already advanced
  3. on key              FIFO
  4. on turn(n)          once per requested turn        <- new
  5. on resize
  6. the scene re-composes from the live environment
```

- **Requesting from a key handler lands in the SAME frame.** Press a key, the world reacts,
  and the frame you see already contains both. A one-frame lag between a keypress and its
  consequence is exactly the kind of thing that feels wrong and is hard to diagnose.
- **Several requests in one frame run several turns**, which is how "rest ten turns" is
  written: call `advance()` ten times.
- **A request made DURING a turn handler runs on the next frame**, not this one. That
  makes an infinite loop inside a single frame impossible to write by accident, at the
  cost of one frame of latency for a case that is rare and can always be written as an
  explicit count instead.
- **`turn()` is readable everywhere**, including from a layer, so a scene can draw the
  turn counter without a variable to keep in step.

### 12.4 Determinism, which is the whole reason this is not just a variable

The same starting state and the same sequence of turns must produce byte-identical
frames. That is what makes a simulation testable at all, and it is why the turn is a
first-class clock rather than an integer the game increments itself:

- turn handlers run at a fixed point in the frame, so composition always sees a whole turn
  and never half of one;
- ids are a deterministic counter;
- `random()` still cannot appear in anything a golden observes — a simulation that needs
  chance uses the seeded generator in `src/util/random.ts`, the one QBSK already has.

A golden driven through a scripted turn sequence is what turns that paragraph into a
check, and this phase ships one.

---

## 13. Pathfinding (C5)

```qbsk
const room = [
    "##########",
    "#....#...#",
    "#....#...#",
    "#....#...#",
    "#........#",
    "##########",
]

var route = path(room, (1, 1), (8, 1), "#")
```

`path(map, from, to, blocked)` returns the route as a list of `(x, y)` tuples.

| result | means |
|---|---|
| `[]` | there is no way through |
| one step | you are already there |
| `route[1]` | the next cell to move to |

**The path includes both ends.** That is what makes "already there" distinguishable from
"no route" — with the start excluded, both answer with an empty list, and a creature that
cannot reach you would behave identically to one standing on you.

### 13.1 The map is a list of strings

Because that is what an ASCII map already is. A game draws its walls as characters, so
pathfinding should read the same thing the player sees rather than requiring a parallel
structure to be built and kept in step — which is the bug that structure would eventually
have.

`blocked` is the set of characters that cannot be entered. **Blocked rather than
walkable**, because walls are the exception: a map has five wall glyphs and forty floor
ones, and listing the forty is how a floor tile gets forgotten and becomes invisibly
solid.

Rows may be ragged; a cell past the end of its row is off the map, not floor.

### 13.2 Eight directions, and no cutting corners

Diagonals are allowed — roguelikes have moved that way since Rogue, and on a grid whose
cells are twice as tall as wide a diagonal reads as a natural step. A fifth argument
restricts to four: `path(map, from, to, blocked, false)`.

> It is positional and not `diagonal: false` because **native functions do not accept
> named arguments** — only the scene DSL does. An earlier draft of this section promised
> the named form, which is a spec that could not be implemented. Named arguments for
> natives are a real language gap and worth having; they are not this phase.

**A diagonal between two walls is refused.** Moving from `A` to `B` here is not allowed:

```
  .#          the two walls touch at the corner; a body does not fit
  #B          through the gap, and a creature that slips through one
              reads as walking through a wall
```

This is the classic grid-pathfinding bug, and it looks exactly like a rendering fault when
it happens, which is why it is decided here rather than left to the caller.

### 13.3 Costs are integers, and that is a determinism decision

Orthogonal steps cost **10**, diagonal steps **14** — the standard integer approximation
of 1 and √2.

Floats would be more precise and would introduce ties that resolve differently depending
on the order two equal-cost nodes happen to come out of the queue. Every golden in this
project is byte-exact, and a route that varies between runs cannot be pinned by one. With
integer costs, the same map and the same endpoints always produce the same route:

- neighbours are examined in a fixed order,
- equal `f` scores break by lower `h`, then by cell index,
- so the queue's behaviour is a function of the input and nothing else.

### 13.4 What it is not

**It does not know about entities.** `path` reads a map of characters; if a creature
should block another, the caller stamps it into the map first. Teaching the pathfinder
about the entity model would tie two things together that have no reason to know about
each other, and would make the function impossible to test on its own.

**It does not move anything.** It answers a question. Moving is the `on turn` handler's
job, which is where the game's own rules live — whether a creature that cannot reach you
waits, wanders or gives up is a design decision, not a pathfinding one.

---

## 14. Field of view (C7)

```qbsk
var lit = sight(MAP, (playerX, playerY), 12, "#")

// lit is a mask the same shape as the map: "." you can see, " " you cannot.
if lit[g["y"]][g["x"]] == "."
    put g["glyph"] at (g["x"], g["y"])
```

`sight(map, from, radius, blocked)` answers **what can be seen from a cell**, and it is
the piece a roguelike cannot do without: until it existed, `examples/turns.qbsk` showed
the player every creature on the map through solid stone.

> **This was missing from the roadmap.** C1–C6 came from a sketch and no item covered
> field of view. It surfaced because `sight` sat in the bestiary with nothing able to use
> it — an unused field is a promise, and this is the phase that keeps it.

### 14.1 A mask, not a list

The answer is a **list of strings shaped like the map**, so a lookup is `lit[y][x]` — one
indexing operation, which strings gained in C5.

A list of visible coordinates would have been the obvious shape and the wrong one: a scene
asks "can I see *this* cell" once per creature and once per tile it draws, and answering
that from a list means a linear search each time. A mask makes the question O(1) and, as a
side effect, printable — `put lit[y] at (0, y)` draws the field of view itself, which is
how it gets debugged.

Same shape in, same shape out: `path` and `visible` both read the rows the player sees,
so a wall is a wall to both without a third structure to keep in step.

### 14.2 Recursive shadowcasting, and why

Eight octants, each scanned outward with a narrowing slope range. It is the standard
algorithm because it is **symmetric** — if you can see a cell, standing in that cell you
can see back — and because it produces no artefacts. Casting a ray to every cell in range
is simpler to write and leaves visible gaps behind corners that look like bugs.

- **A wall in view is lit.** You see the face of the wall that is blocking you; you do not
  see through it. Lighting only floor makes rooms look like they have no edges.
- **Radius is measured in CELLS, Euclidean**, and deliberately *not* corrected for the
  2:1 cell aspect. A player counts squares, not millimetres, and every roguelike measures
  the same way. `shade` and `project` correct for aspect because they are drawing a
  picture; this is answering a question about a grid.
- **The origin is always visible**, even standing inside a wall — a creature that cannot
  see its own square would be a strange thing to explain.

### 14.3 On determinism, since C5 made the opposite choice

Pathfinding uses integer costs specifically to avoid float ties (§13.3). Shadowcasting
uses fractional slopes and that is fine, because the two risks are different: A*'s hazard
was **ordering** — two equal-cost nodes leaving a queue in an unspecified sequence.
Shadowcasting has no queue and no ordering choice. The same map and origin run the same
comparisons in the same sequence and produce the same mask, which a golden pins.

Recorded because "we use integers for determinism" would be the wrong lesson to carry
over: the rule is *no unspecified ordering*, not *no floats*.

## 15. Tileset renderer (C1) — a second door to the screen

The window paints characters today. This adds a second emitter that paints **tiles**,
chosen by a lookup from the same `Cell { ch, fg, bg }` the engine already produces.
Cataclysm's fallback pattern: a tile if one is defined for that cell, the character
otherwise, so a half-finished tileset degrades to something playable rather than to
holes.

### 15.1 Where the decision is made — once, at the top

§1.1 requires a single door. This makes the screen door *two*, which is allowed only
because it stays explicit:

- **The choice (tiles or characters) is made once, in the host, per window** — when the
  owner picks a tileset in Studio's settings. The renderer never decides: it paints
  whatever the host shipped, a `Map<glyph, dataUrl>` or nothing, and nothing downstream
  branches on which backend is "live".
- **What the ANSI path MUST NOT learn about:** `render.ts`, `ScreenBuffer`,
  `computeDiff`, the CLI, `qbsk check`, the goldens and `qbsk_read_window` never see a
  tile. The tileset is loaded beside the diff and applied only in the DOM painter.
- **The character grid stays the truth.** A tiled cell keeps its character in
  `textContent`, so `renderText()` and `qbsk_read_window` still return characters; the
  tile is a background image over the cell and the text is made transparent only when a
  tile is present. The snapshot an agent reads is the character grid under the tiles.
- **Tiles never change the grid or the fit.** Cell count, rows, columns and font size
  are untouched; a tiled frame read back is byte-identical to the character frame.

### 15.2 The format — `.qbdata`, not a third format

A tileset is a `.qbdata` file (docs/language.md §12), so it already has the two
properties that matter: **it cannot run**, and **a shape catches a typo at its own
line**.

```qbsk
shape tile
    glyph: str
    image: str

WALL   = {"glyph": "#", "image": "res/tiles/wall.svg"}
FLOOR  = {"glyph": ".", "image": "res/tiles/floor.svg"}
PLAYER = {"glyph": "@", "image": "res/tiles/player.svg"}
```

- `glyph` is the cell character the tile stands for — exactly **one** character.
- `image` is a path relative to the tileset file. **SVG is the default**: text,
  diffable, hand-writable, no binary blobs in git. Any image the window can render
  works — the host reads the file and ships a data URL, so the format is not a hostage
  to SVG.
- The loader (`src/engine/tileset.ts`) reuses `loadQbdata` and adds three checks, each
  a **load error with a span** at the offending entry's line:
  1. every entry has string `glyph` (one character) and string `image`; otherwise the
     file is malformed;
  2. a **glyph mapped twice** — an error naming both entries, because two tiles for one
     glyph is a mistake, and the silent winner is whichever loaded last;
  3. the **image file exists** relative to the tileset; otherwise the error says which
     entry names the missing file.
- The `QbdataResult` contract gains an additive `entryLines: Map<string, number>`
  (name → line) so these tile-level errors can point at the right line. The three
  existing `loadQbdata` callers ignore it.

### 15.3 The lookup rides the diff (measured)

`bench/tiles.md`: a full-grid tile lookup at 120×40 costs **0.0528 ms/frame** (2.64% of
the 2 ms budget, 4800 lookups); a lookup applied only to the cells `computeDiff`
reported costs **0.0013 ms/frame** (0.06%, ~18 lookups). The DOM painter already
patches exactly the changed cells, so the tile lookup happens there — once per changed
cell, never a full pass over the grid. The decision lives in a pure function,
`tileForCell(cell, tiles)`, so the lookup is headless-testable and the painter's call
site is a single line.

### 15.4 The fallback is the default, and it is tested

- A cell with no tile entry draws its character — unchanged from today.
- A tileset that fails to load (missing file, shape violation, missing image, glyph
  mapped twice) **leaves the window exactly as it is today**. The failure is reported,
  never silent (the earlier rule), but it never blocks the scene.
- The off switch is the Studio tileset setting being "None", or
  `QBSK_STUDIO_NO_TILES=1` — the same shape as `QBSK_STUDIO_SMOKE`.

**On the literal `--no-tiles` flag:** there is none, deliberately. `--no-ansi` and
`--no-audio` exist because the CLI emits ANSI and plays audio. The CLI has no window and
no tile path, so a `qbsk run --no-tiles` flag would be a no-op — a ghost, which this
project has already shipped twice and stopped doing. The off switch lives where the
tiles live, in Studio. If tiles ever reach a CLI emitter (an image export), the flag
arrives with it, doing what it says.

### 15.5 Determinism

Tiles never enter the frame pipeline: the diff, the ANSI bytes and the golden output
are produced before the tileset exists. A tileset is a presentation layer over an
unchanged character grid, so **no golden changes**. A tile's data URL is a pure
function of its bytes — same file, same URL, every run.

---

## 17. ECS Foundation (an earlier design) — DESIGN, not yet built

> **Status**: this section is a DESIGN. Of the natives it specifies, only `spawn`,
> `find` and `without` exist today (they are the current dict-list model);
> `despawn`, `set_part`, `remove_part`, `has_part`, `query`, `entities_in_radius` and
> `entities_in_cell` are **not implemented**. The section is written in the present
> tense because it is a specification, and it was numbered §16 while another §16
> already existed — both were caught by `tests/unit/docs-truth.test.ts`
> (docs/language.md §16), which is what that test is for.
>
> Do not read a signature here as an API you can call. Check the registry:
> `node -e "import('./dist/interp/natives.js').then(m=>console.log(m.createNatives({print:()=>{}},{}).names().join(' ')))"`
>
> **Scope**: This section defines the entity-component system that replaces the
> current dict-list model (`var entities = []` + `spawn`/`find`/`without`). It is
> the foundation for an earlier design (Action/Rules), an earlier design (World Model), and all
> simulation work. The design draws from Caves of Qud's Parts system, CDDA's
> cell-list needs, and LambdaHack's content/enforcement separation — adapted to
> QBSK's dict-based, analyzer-checked, MCP-inspectable model.

### 17.1 Core Concepts

| Term | Definition |
|------|------------|
| **Part** | A named bundle of data (e.g., `Position`, `Velocity`, `Health`, `Brain`). Represented as a QBSK dict with a reserved key `__part: "name"` plus arbitrary data fields. |
| **Archetype** | A unique combination of part names (e.g., `["Position", "Velocity", "Renderable"]`). All entities with the same parts share an archetype. |
| **Pool** | A contiguous array of entities sharing an archetype. Each pool stores its parts in parallel arrays for cache locality. |
| **Entity Handle** | Opaque reference: `{ __entity: int, __archetype: int, __index: int }`. Never a raw dict. |
| **World** | Host-owned container: archetype registry, pools, spatial index, entity ID allocator. Lives in the host (TypeScript), exposed to QBSK via natives. |

**Key Invariants**:
1. An entity belongs to exactly one archetype at a time.
2. Adding/removing a part moves the entity to a different archetype (pool migration).
3. Entity IDs are stable across migrations (assigned once by `spawn`).
4. Pools are the unit of iteration — never scan all entities.

### 17.2 Part Model

A **Part** is a QBSK dict with a reserved structure:

```qbsk
# Minimal part (marker — no data)
{"__part": "Position", "x": 0.0, "y": 0.0}

# Part with data
{"__part": "Velocity", "vx": 1.5, "vy": -0.5}

# Part with nested data
{"__part": "Health", "hp": 10, "max_hp": 10, "regen": 0.1}
```

**Reserved keys** (enforced by analyzer):
- `"__part": string` — required, the part name (e.g., `"Position"`)
- `"__entity": int` — injected by host; entity's stable ID
- `"__archetype": string` — injected by host; archetype key for fast lookup

**Part Definition** (host-side, for validation and pooling):
```typescript
interface PartDef {
  name: string;                    // "Position"
  fields: Record<string, PartFieldDef>;
  required?: string[];             // fields that must exist
  defaults?: Record<string, any>;  // default values
}

type PartFieldDef =
  | { type: "int" | "float" | "bool" | "str" }
  | { type: "list"; item: PartFieldDef }
  | { type: "dict"; schema: Record<string, PartFieldDef> }
  | { type: "entity_ref" };        // reference to another entity by ID
```

**Standard Parts** (defined in host, available to all games):
| Part | Fields | Purpose |
|------|--------|---------|
| `Position` | `x: float`, `y: float`, `z: int` | Spatial location |
| `Velocity` | `vx: float`, `vy: float` | Per-turn movement |
| `Renderable` | `glyph: str`, `fg: str`, `bg: str`, `z: int` | Visual representation |
| `Health` | `hp: int`, `max_hp: int`, `regen: float` | Damage/death |
| `Brain` | `kind: str` (e.g., `"melee"`, `"ranged"`, `"flee"`) | AI behavior type |
| `Faction` | `name: str` | Hostility resolution |
| `Inventory` | `items: list[entity_ref]` | Carried items |
| `Name` | `name: str`, `description: str` | Display/info |

### 17.3 Archetype Registry & Pools

The host maintains an **Archetype Registry** mapping archetype keys to pools:

```typescript
type ArchetypeKey = string;  // sorted part names joined by "|", e.g., "Position|Velocity|Renderable"

interface Pool {
  archetype: ArchetypeKey;
  parts: Map<string, any[]>;  // part name -> contiguous array
  entityIds: number[];        // entity ID per index (stable)
  freeIndices: number[];      // recycled slots
}

class ArchetypeRegistry {
  private pools = new Map<ArchetypeKey, Pool>();
  private entityToPool = new Map<number, ArchetypeKey>();
  private entityToIndex = new Map<number, number>();

  getPool(archetype: ArchetypeKey): Pool { ... }
  migrateEntity(entityId: number, newArchetype: ArchetypeKey): void { ... }
  addEntity(parts: PartData[]): EntityHandle { ... }
  removeEntity(entityId: number): void { ... }
}
```

**Pool Layout** (example for `Position|Velocity|Renderable`):
```
Pool {
  archetype: "Position|Velocity|Renderable",
  parts: {
    "Position":  [{x:0,y:0,z:0}, {x:5,y:3,z:0}, ...],
    "Velocity":  [{vx:1,vy:0},   {vx:0,vy:-1}, ...],
    "Renderable":[{glyph:"@",fg:"white",bg:"black",z:1}, ...],
  },
  entityIds:   [42, 17, ...],
  freeIndices: [3, 8],
}
```

**Entity Handle** (opaque, returned by `spawn`):
```qbsk
# Opaque handle — never inspect directly
{"__entity": 42, "__archetype": "Position|Velocity|Renderable", "__index": 0}
```

### 17.4 Spatial Index (Cell List)

**Required** for O(1) neighbor queries (CDDA cell list, LambdaHack). The host maintains a **Cell List** overlaid on the world grid:

```typescript
class CellList {
  private grid: Map<number, Map<number, number[]>>;  // z -> (x,y) -> entityIds[]
  private cellSize: number;  // e.g., 10 tiles

  add(entityId: number, x: number, y: number, z: number): void { ... }
  remove(entityId: number, x: number, y: number, z: number): void { ... }
  move(entityId: number, oldX: number, oldY: number, oldZ: number, newX: number, newY: number, newZ: number): void { ... }

  // Returns entity IDs in cells overlapping the radius
  queryRadius(x: number, y: number, z: number, radius: number): number[] { ... }
  // Returns entity IDs in the same cell
  queryCell(x: number, y: number, z: number): number[] { ... }
}
```

**Cell Size**: Configurable (default 10). Larger = fewer cells, more entities per cell.

**Integration**: When an entity with `Position` moves, the host updates the cell list. Queries are exposed via natives:
```qbsk
# Entities within 5 tiles at (x, y, z)
var nearby = entities_in_radius(x, y, z, 5)
# Entities in the same cell
var here = entities_in_cell(x, y, z)
```

### 17.5 Host API (Natives)

All ECS operations are host-side; QBSK interacts via natives.

| Native | Signature | Description |
|--------|-----------|-------------|
| `spawn` | `spawn(parts: dict) -> entity` | Create entity from part dicts; assigns ID, registers in archetype, returns opaque handle |
| `despawn` | `despawn(entity) -> null` | Remove entity from all pools and spatial index |
| `find` | `find(entity, part_name) -> dict \| null` | Get a part's data from an entity (read-only) |
| `set_part` | `set_part(entity, part_name, data: dict) -> null` | Replace/add a part; triggers archetype migration if part set changes |
| `remove_part` | `remove_part(entity, part_name) -> null` | Remove a part; triggers migration |
| `has_part` | `has_part(entity, part_name) -> bool` | Check if entity has a part |
| `query` | `query(parts: list[str]) -> list[entity]` | Return all entities having ALL listed parts (pool iteration) |
| `entities_in_radius` | `entities_in_radius(x, y, z, radius) -> list[entity]` | Spatial query via cell list |
| `entities_in_cell` | `entities_in_cell(x, y, z) -> list[entity]` | Cell list single-cell query |

**Example**:
```qbsk
# Spawn a goblin
var gob = spawn({
  "Position": {"x": 10.0, "y": 5.0, "z": 0},
  "Velocity": {"vx": 0.0, "vy": 0.0},
  "Renderable": {"glyph": "g", "fg": "green", "bg": "black", "z": 1},
  "Health": {"hp": 10, "max_hp": 10},
  "Brain": {"kind": "melee"},
  "Faction": {"name": "hostile"},
  "Name": {"name": "Goblin"}
})

# Read position
var pos = find(gob, "Position")
print("Goblin at " + pos["x"] + "," + pos["y"])

# Query all entities with Position + Velocity (for physics system)
var movers = query(["Position", "Velocity"])

# Find nearby enemies
var enemies = entities_in_radius(pos["x"], pos["y"], pos["z"], 10)
```

### 17.6 Migration Rules

When `set_part`/`remove_part` changes an entity's part set:

1. Compute new archetype key (sorted part names).
2. If same as current → update in-place in pool arrays.
3. If different:
   - Allocate new slot in target pool (recycle free index or append).
   - Copy all part data to new pool.
   - Clear old slot in source pool (add to `freeIndices`).
   - Update `entityToPool` and `entityToIndex` maps.
4. Return new opaque handle (same `__entity`, new `__archetype`/`__index`).

### 17.7 Determinism & Testing

- **Entity IDs** are assigned sequentially from `sim.nextId` — deterministic.
- **Pool iteration order** is by `entityIds` array order (insertion order, minus removed).
- **Spatial queries** return entities in cell list order (deterministic for same inputs).
- **Golden tests**: `bench/ecs.mjs` measures pool iteration vs the dict-list baseline
  (the file was cited as `bench/ecs.md` here, which never existed).

### 17.8 Migration Path for Existing Code

| Old Pattern | New Pattern |
|-------------|-------------|
| `var entities = []` | (host manages storage) |
| `spawn({...})` | Same, returns opaque handle |
| `find(list, id)` | `find(entity, "PartName")` |
| `without(list, id)` | `despawn(entity)` or filter via `query()` |
| `entities[i]["x"]` | `find(entity, "Position")["x"]` |
| `for e in entities` | `for e in query(["Position"])` |

---

*End of §16. an earlier design implementation begins in `src/ecs/` (host-side pure TS, no Electron).*

---

## 18. A game can end, and it cannot crash the host (L17)

Three defects found by trying to write a small playable game rather than by reading. All
three were in the CLI's frame loop, not in the language or the renderer, and all three
were invisible to the 1400-test suite because nothing tested `src/cli/main.ts`.

### 18.1 `exit()` ends the loop

`exit(7)` inside a handler was **ignored** in loop mode: the program rendered its
remaining frames and the process exited 0. So a game could be started, and could crash,
but could not *finish* — "press q to quit" was unimplementable except through Ctrl-C.

Every mechanism was already correct. The interpreter latches the code, `SceneFrame`
carries it, and `step()` keeps reporting it on every later frame. The frame function
simply never looked. The fix is one `if`, symmetric to the error path beside it, and it
restores the terminal the same way: raw mode and a hidden cursor outlive the process, so
leaving either behind breaks the shell the player returns to.

`exit(0)` is a *clean quit*, not "no exit" — the distinction a quit menu depends on.

### 18.2 A scene may change size between frames

`scene S(width: w, ...)` takes an expression, so a program can reshape its own canvas.
The CLI allocated the `ScreenBuffer` once from the first frame and never revisited it, so
frame 2 reached `computeDiff` with a row shorter than the buffer and died:

```
TypeError: Cannot read properties of undefined (reading 'char')
    at eqCell (dist/engine/cell.js:10:15)
```

A raw host stack trace reaching the author is the RULE #4 violation that
`docs/language.md` §15 removed from the language — it was still alive in the engine.
Studio had handled this since it was written; the CLI had not, and the two hosts
disagreeing about whether a program crashes is worse than either answer.

The buffer is now re-allocated whenever the canvas geometry changes. The next diff
redraws everything, which is correct: the whole screen just changed shape.

### 18.3 Input in loop mode has no `print`

`print` from a handler goes nowhere in loop mode, in both hosts. That is **deliberate**
and now stated: the screen *is* the output there, and writing to stdout would corrupt the
diffed frame the renderer is maintaining. A game shows its state by drawing it.

Debugging a loop program therefore means drawing the value, or running it once without
`--loop` where `print` works normally.

### 18.4 What this cost, and what it says about the test suite

The three bugs sat behind the largest untested surface in `src/`: nothing referenced
`runFrameLoop`, `restore` or `setRawMode`. The suite tested the interpreter, the renderer
and the decoder — every part except the code that wires them into a program a person can
play.

`tests/unit/loop-exit.test.ts` now drives the real CLI as a subprocess and asserts on exit
codes, which is the only way to test this layer honestly. `examples/quit.qbsk` is the
demonstration: arrows move one cell per frame, `q` quits with 0, `x` quits with 3.
