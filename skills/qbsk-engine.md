---
name: qbsk-engine
description: Skill for the architecture and implementation of the QBSK ASCII engine (screen buffer, double buffer, differential diffing, ANSI emission, frame loop, raw input, scenes, layers/z-index, coordinates, tweens, timelines, sprites, shades, depth, particles, pathfinding, field of view, tilesets and the ECS foundation). Use it ALWAYS when the task involves the engine: render, FPS, flicker, ANSI escape codes, cross-platform terminal, raw mode, resize, double buffer, diff, layer composition, animation, easing, frame-swapping, the .qba sprite format, or the game loop. Do not use it for the language itself (use qbsk-language).
---

# QBSK — ASCII Engine Architect

You are the senior architect of the QBSK ASCII scene engine: high-FPS, cross-platform
terminal rendering with hyper-detailed ASCII art and smooth animation.

> ⚠️ **Correction (review, August 2026 — §5 question 10).** This skill used to say "the
> whole engine is written IN QBSK on top of the runtime bootstrap". **That is NOT the
> project's direction today and must not be attempted.** The engine is written in
> TypeScript. Bootstrapping (the engine written in QBSK) requires a persistent state
> model that does not exist yet, and once the engine depends on the language, every
> language change becomes much more expensive. It is an ambition for after v1.0, with
> the language surface already frozen. If a task asks you to bootstrap the engine,
> **stop and consult**.

## 1. Non-negotiable architectural principles

1. **Single gateway to the system**: only `src/engine/render.ts` (`renderFrame`) writes
   ANSI bytes. ⚠️ **`src/engine/terminal.ts` does not exist and is not planned** — earlier
   drafts of this skill and of `docs/engine.md` named it, and it was never built. Raw mode,
   resize and the alt-screen lifecycle live in `src/cli/main.ts` (the only four
   `process.stdout.write` sites in `src/` are there). If a task says "touch the terminal
   gateway", it means `render.ts` for bytes and `main.ts` for the terminal lifecycle.
2. **Double buffer always**: `FrontBuffer` (what is on screen) and `BackBuffer` (what is
   being drawn). Writing the same frame twice → 0 bytes of output. Guaranteed no-flicker.
3. **Differential diffing**: only the cells that changed are emitted, grouped into runs
   of identical style. This is the key to high FPS.
4. **100% ANSI rendering**, no ncurses and no terminal dependencies.
5. **Visible metrics**: average/p99 fps, cells emitted per frame, time per phase.
   Target: 120×40 scene @ 60 FPS with ≤ 2 ms/frame of CPU.
6. **ANSI is opt-IN, not opt-out.** The flag is `--ansi`; plain text is the default.
   ⚠️ **`--no-ansi` does not exist** — earlier drafts of this skill told you to "degrade
   to `--no-ansi`", which would have added a ghost flag. There is also **no capability
   detection**: no `TERM`, `COLORTERM`, `CI` or `ENABLE_VIRTUAL_TERMINAL_PROCESSING`
   probing anywhere in `src/`. Do not describe any of it as existing.

## 2. Mandatory references BEFORE coding

- **`the roadmap`** → the operative source of truth for
  what is built and what is not.
- `docs/engine.md` → ANSI protocol, diffing, double buffer, and everything after M19
  (shades, projection, depth, glyph ramps, particles, entities/turns, pathfinding, FOV,
  the tileset renderer, the ECS foundation). It exists and is ~1280 lines through §16.
- ⚠️ An earlier draft sent you to a roadmap file that is not in this repository. The
  milestone names (M10–M19) survive in comments and mean only "when this was built" (M6–M9 are
  an earlier release). ⚠️ Parts of it teach syntax the language rejects — read it for intent only.
- `.qba` format (single + multi-frame with `---` separator) → `docs/engine.md` §12
  and §12 of this skill. ⚠️ **`docs/sprites.md` does not exist** — this skill used to
  cite it and that was false. Do not look for it or create it.
- The scene/layer syntax the engine executes → `docs/language.md`.
  ⚠️ **`docs/canvas-dsl.md` does not exist** — same correction.
- `examples/*.qbsk` → reference scenes the engine must render without regression.
  All examples use the `.qbsk` extension.

> `docs/` contains **four** specs: `language.md`, `engine.md`, `audio.md` and `studio.md`.
> An earlier version of this skill asserted "exactly two files" and told you to disbelieve
> the others. `audio.md` governs the `tone` primitive (which composes in a layer and
> appears 25× in `examples/`); `studio.md` governs the MCP surface.

> **The one-way import rule, enforced by a test.** `studio/` may import `src/`; `src/` may
> NEVER import `studio/` or `electron`. `tests/unit/studio-enforcement.test.ts` fails the
> build if it is violated. It is a hard architectural constraint on any engine change.

### 2.1 Reference blueprints (GitHub repositories) — steal architecture, adapt to the spec

| Repo | Blueprint it provides | What to steal | What NOT to steal |
|------|----------------------|---------------|-------------------|
| `mofirojean/ts-ascii-engine` | Image/video→ASCII conversion in pure TS (zero-dependency, typed arrays, minimal GC, 30+ FPS) | Char-map structures (`characters: string[][]`, `colors: CharColor[][]` as per-cell matrices), charset presets (`█▓▒░`, `@%#*+=-:.`), hot-path techniques: typed arrays and minimal garbage collection | Its conversion pipeline (luminance→char) and its HTML output — it is NOT a terminal renderer and does NOT do diffing/ANSI: that work is done by our `diff.ts`/`render.ts` |

**RENDER implementation directive** (activate verbatim in M12–M13):

> "Design a virtual terminal buffer in Node.js using a two-dimensional array of
> characters. Implement a 'diffing' system (comparing the previous frame with the current
> one) to send to the console only the characters that changed via ANSI escapes,
> emulating the optimization of text graphics engines."

### 2.2 Reference blueprints (GitHub repositories) — engine and TUIs

| Repo | Blueprint it provides | What to steal | What NOT to steal |
|------|----------------------|---------------|-------------------|
| `sindresorhus/ansi-escapes` | The reference for ANSI sequences in Node | The EXACT sequence table (cursor, SGR, alt screen) as a checklist for `util/ansi.ts` | Depending on the package: our sequences live in `util/ansi.ts` (0 deps) |
| `chjj/blessed` / `neo-blessed` | The most complete TUI framework in JS | `Screen`/`Element` virtual buffer management and its high-speed cell diffing | Its widget API — we have our own primitives |
| `zarstensen/AsciiRenderer` (Asciir) | C++ terminal renderer/game engine (ANSII, 565 commits) | Real double buffering, "only modified tiles are printed", FPS limiting via minimum dt (`setMinDT`), title/window control | Its threading (native C++) |
| `Thraka/SadConsole` | ASCII .NET/C# engine (1.4k⭐, in production) | Character tile maps, font sets, entity management, "gold" layer handling | MonoGame/SFML pipeline |
| `spencergoldade/AskeeDS` | Declarative design system (YAML) for text games | Declarative render specs, tokens (colors/borders/typography), golden snapshot files as a visual testing strategy | Its YAML/Python — our DSL is QBSK |
| `renpenguin/gemini-py` | Python 2D ASCII engine | Direct (x, y) coords → grid blocks mapping, multiline sprites | ⚠️ **DEPRECATED for performance** (ported to Rust `gemini-engine`): study the design, not the runtime |
| `ondras/rot.js` | JS roguelike toolkit (2.7k⭐) | Per-cell loops, tilemaps, FOV, robust keyboard events | Its render system (canvas/DOM) |

## 3. File structure — verified against the real tree

```
src/engine/           # buffer.ts, canvas.ts, cell.ts, color.ts, depth.ts, diff.ts,
                      # fov.ts, input.ts, keys.ts, loop.ts, particles.ts, path.ts,
                      # ramp.ts, render.ts, shade.ts, sprite.ts, tileset.ts   (17 files)
src/choreo/           # scene.ts, coord.ts, easing.ts, tween.ts, timeline.ts,
                      # frames.ts, project.ts   (7 files)
src/audio/            # device.ts, tone.ts
src/ecs/              # the ECS foundation (4 files)
src/tools/            # pngDecode.ts, spriteGen.ts
src/util/             # ansi.ts, random.ts, suggest.ts
src/cli/main.ts       # raw mode, resize, the alt-screen lifecycle, stdout
tests/golden/         # 26 byte-for-byte outputs
bench/                # baseline.md + per-milestone .md + 11 standalone .mjs benchmarks
examples/res/         # .qba sprites (ball, hero, walk) and ~70 .qbdata files
```

⚠️ Corrections against earlier versions of this skill, all verified:
- `color.ts` is in **`src/engine/`**, not `src/util/`.
- **`input.ts`, `tween.ts`, `easing.ts` and `timeline.ts` ALL EXIST and are shipped**
  (M17/M18/M19 closed and reviewed). This skill used to list them as "do not exist yet;
  do not assume they are there", which would send an agent to re-implement four
  golden-tested modules.
- **`terminal.ts` is the only one that does not exist** — and it is not coming (§1).
- The `.qba` files live in `examples/res/`, not a root-level `res/`.

## 4. CELL and CANVAS model — technical checklist

- `Cell { char: str(1), fg: int, bg: int, attrs: int }` — note the field is **`char`**,
  not `ch`. fg/bg as **packed int** `0xRRGGBB` (or `-1` = default) and attrs as a
  **bitmask** `1=Bold, 2=Underline, 4=Reverse`. Primitive comparison is the cheapest
  possible diffing. Comparison is the free function **`eqCell(a, b)`** in `cell.ts`,
  not a method — allocation-free and inline-friendly. (NOT `Set<Attr>`: it would kill
  the hot path.)
- `Canvas { width, height, cells: Cell[] }` (flat 1D array `y * width + x`, not 2D).
- `clear()` WITHOUT allocations: `cells.fill(templateCell)` with a single template instance.
- Primitives WITH mandatory clipping against bounds: `setCell, fill, rect, border,
  line(x1,y1,x2,y2), text, blit(src, dx, dy)`.
- `Color` (`src/engine/color.ts`): the 16 ANSI names packed as `0xRRGGBB`, **plus the
  `#rrggbb` literal**, both resolved by `resolveColor`. `color fg: "#ff7f00"` works, and so
  does `plot`.
  ⚠️ This entry said `color fg: "#ff0000"` was `unknown color` and deferred truecolor to
  "M13+", while the line right after it admitted that `render.ts` had been emitting
  `38;2;r;g;b` all along. It was never deferred — the whole pipeline carried 24 bits and
  only the front door refused them. §15.16 opened it.
  There is still **no 256-colour palette and no three-argument constructor**, and that is a
  decision rather than a gap: both are second spellings of values `#rrggbb` already reaches.
- **DoD**: every primitive has a byte-for-byte golden file, including the clipping cases.

## 5. TERMINAL lifecycle (in `src/cli/main.ts`) — technical checklist

⚠️ This section used to describe `src/engine/terminal.ts`, a file that does not exist.
The behaviour below lives in `src/cli/main.ts`.

- **No capability detection exists.** No `TERM`, `COLORTERM`, `CI` or
  `ENABLE_VIRTUAL_TERMINAL_PROCESSING` probing anywhere in `src/`. On Windows, Node's
  libuv already activates virtual-terminal processing on Windows 10+ — do NOT write ANSI
  sequences to "activate" it (it does not work; there is no public Node API for
  SetConsoleMode). If capability detection is ever added, it is a new feature with a spec,
  not an existing behaviour to preserve.
- Raw mode: no echo, no canonical mode, non-blocking read from the loop. Restore state in
  try/finally + process exit hooks. Never leave the terminal broken.
- Sequences are centralized in `util/ansi.ts`: `cursorTo`, `RESET`, `sgr` (used by
  `render.ts`) and `hideCursor`/`showCursor` (used by `main.ts`). ⚠️ `altScreen`,
  `exitAltScreen`, `clearScreen` and `home` are **defined but have zero consumers** —
  they are available, not part of the working protocol.
- Resize: `SIGWINCH` (posix) / console events (win) → enqueue `on resize(w, h)`.
- **DoD**: `qbsk run` displays and RESTORES the screen correctly in Windows Terminal,
  cmd and bash. Test manually on each platform.

## 6. DOUBLE BUFFER + DIFFING — technical checklist

- `buffer.ts`: `beginFrame()`, `setCell()`, `paintCanvas()`, `swap()`, `reset()` (resize).
  ⚠️ There is **no `endFrame()`** — earlier drafts listed one and omitted the two methods
  that actually fill the buffer (`setCell`, `paintCanvas`). Keep
  `dirtyLines: Set<number>` — only the touched lines are re-scanned.
- `diff.ts`: per dirty line, compare `front[i].eq(back[i])`; produce runs of changed
  cells. Per run: either rewrite the whole line or jump to the first change
  (`\x1b[r;cH` + run) — choose by cost heuristic (shorter text).
- Optimization: an unchanged frame → 0 bytes emitted (verify with a test).
- `render.ts`: group consecutive runs with the SAME SGR → a single escape + text.
  Never emit redundant SGRs in contiguous runs.
- **DoD**: benchmark recorded in `bench/`: 120×40 with 5% of cells changing → < 2 ms.
  Any performance regression = red PR.

## 7. FRAME LOOP — technical checklist

- `loop.ts`: FIXED timestep with accumulator (logic) + render interpolation (visual).
  The rate is a **constructor option**, not a setter: `new GameLoop({fps, frames?, now?},
  handlers)` sets `timestep = 1 / fps`. ⚠️ There is **no `setFrameRate()`** — earlier
  drafts named one. The rate comes from `--fps` or the scene's `fps:` parameter.
- Pacing by real clock, never blind `sleep`.
- Metrics on every frame: ms per phase (script, composition, diff, emission), cells
  emitted, instant fps and p99. `qbsk profile scene.qbsk --frames 300` prints them.
- **DoD**: 60 FPS animation without flicker in Windows Terminal; data published in `bench/`.

## 8. INPUT — technical checklist

- `input.ts`: parses normal keys + arrows and escapes (`\x1b[` sequences), converts them
  to canonical names (`"arrow-left"`, `"space"`, `"a"`...).
- **Chunk accumulation buffer**: `chunk.toString()` can SPLIT an escape sequence in half
  (an arrow `\x1b[A` can arrive in two chunks). Accumulate partial bytes until the
  sequence is complete; if none matches, discard them.
- Event queue with a max size of **256** and a drop-oldest policy: expensive frames NEVER
  freeze input. (The constant is `QUEUE_LIMIT` in `src/engine/keys.ts`. It is named here
  because an unchosen "max size N" was itself flagged as a spec trap when M19 closed.)
- **DoD**: keyboard-controlled scene; verify the buffer never overflows.

## 9. SCENES, LAYERS and Z-INDEX — technical checklist

- `scene.ts`: `Scene → Layer[] → Primitive[]` (tree). Bottom→top composition; on a tie
  the top layer wins (higher z); `visible: bool` per layer and per primitive.
- Dynamic z: reordering layers at runtime must reflect on the next frame.
- Any primitive outside the canvas is discarded in composition (never indexed out of
  range — also protects against `sprite at (x,y)` with negative x/y).
- **Two composition-cost rules, both learned the expensive way (an earlier release):**
  - **Cache whole layers, never single primitives** (§9.1). A layer the analyzer proves
    stable is captured as touched-cell runs and replayed; a per-primitive cache would add
    a lookup to every primitive in the hot path it exists to remove. The classifier is
    conservative by construction — a wrongly-static layer draws a stale picture with no
    error, which is the §14 silent-failure shape. `qbsk check --layers <file>` prints the
    verdict and its reason per layer.
  - **A bulk operation is one primitive, not N** (§11.12). `put MAP at (0,0) mask: seen`
    mounts as a single `cells` op carrying the glyphs the mask showed. Emitting N `text`
    ops instead would move the loop from the interpreter into the compositor rather than
    removing it. Unmasked positions are *absent* from the op, not painted with a space —
    that transparency is what separates it from `blit`, which paints every character
    including spaces and would wrongly erase the layer below.
- **Subcell resolution (§11.14)**: a cell is ~1 wide x 2 tall, so halving it vertically
  makes each subpixel **square** — that is the visual win, and the reason `plot(canvas,
  (x, y), colour)` runs y over `2h`. A circle drawn with one radius in that grid comes out
  round, spanning twice as many cells across as down; drawn per cell it needs the x radius
  doubled by hand. One cell holds two independently coloured pixels via `▀` (fg = top,
  bg = bottom); `braille(canvas, (x, y))` reaches 2 x 4 dots per cell by giving colour up.
  ⚠️ **Quadrants (`▘▝▖▗▚▞▙▟`) are deliberately absent, and not by oversight.** In a
  half-block system a cell has four states and all four have a glyph, so there is nothing
  to fall back from. A 2x2 split is a different trade — twice the horizontal resolution,
  and the square pixel given up, since a quarter of a 1x2 cell is 0.5 x 1. Do not add them
  as a "fallback".
  ⚠️ **The font contract is documented, never detected.** These glyphs need a Unicode
  font; Windows Terminal + Cascadia has them, `cmd.exe` with a raster font does not. No
  capability detection exists in this engine and none is to be added — the box-drawing
  characters have shipped under the same contract since the first golden.
- **Orientation glyphs (§11.16)**: a ramp says how MUCH ink a cell holds; it cannot say
  which way it runs. `stroke_glyph(dx, dy)` returns `─ │ ╱ ╲` from an **aspect-corrected**
  angle — `atan2(dy * cellAspect, dx)` — with `|cos| > 0.87` horizontal, `< 0.32`
  vertical, else the quadrant picks the diagonal. Screen y grows DOWNWARD, so
  right-and-down is `╲`. `line ... style: stroke` uses it; absent style keeps the `*`.
  ⚠️ **`cellAspect` defaults to 2.0 and that is an assumption, not a fact.** It is the
  cell's height over its width. `studio/renderer/fonts.ts` has the real number per font,
  read out of the font file: Unifont and Iosevka are 0.5 em (so 2.0), JetBrains Mono and
  IBM Plex Mono are 0.6 em (so 1.667). The two disagree for slopes `dy/dx` between 0.283
  and 0.340 — inside that band the same geometry draws `─` under one font and `╲` under
  another. `src/` cannot read the registry (the arrow is `studio/ → src/`), so the real
  ratio is passed IN — **Studio does pass it now**: `cellAspectFor(chPerEm)` in
  `studio/renderer/fit.ts` travels with `run` and `live`. Those advance-width figures are
  not the whole cell, either: Studio's line height is 1.15 em, so its real shapes are
  **2.30 and 1.92** and the 2.0 default is nearest to Unifont rather than exact for it. A non-positive or non-finite aspect throws rather than clamping:
  zero flattens every stroke, negative mirrors every diagonal, and both look deliberate
  while being wrong. It matters most in `edgeGlyph`, where a converter bakes the answer
  into an asset that no later setting can fix.
- **Cinematic vocabulary (§11.18)**: `examples/lib/cinematic.qbsk` is a QBSK LIBRARY,
  not natives, and that is the design — `border` boxes, `put` writes, `timeline_*`
  schedules, `animate` moves; only the composition was missing. Reach for a native here
  only when a scene MEASURES the library as too slow. Wrapping was the one real gap and
  it stayed in QBSK: a word longer than the line overflows rather than being cut, blank
  input returns ONE empty line (zero collapses a box to its border and reads as a render
  fault), and width < 1 returns the string whole instead of looping forever.
  `examples/cell_block.qbsk` is the demo where F1 and F2 meet — a converted photograph
  as the set, dialogue and entrances on top, **1.072 ms/frame** with the box active.
  ⚠️ A scene SEEDS its own first frame: the scene block composes once before any tick
  (§7.7), so a cinematic starting blank pins an empty box as its golden.
  ⚠️ `text` and `at` are reserved and cannot be parameter names, as is `world`. All
  three were hit by accident, not by looking for them.
- **Image to grid (§11.17)**: `src/tools/imageToGrid.ts` + `bench/image-to-grid.mjs`
  convert a render into a glyph asset. Three things it took a spike to learn, all
  measured: **(a)** the input must be art from BEFORE any ASCII styling — the first
  reference image was itself a glyph grid at 8px pitch, and sampling that at another
  pitch destroys the structure; **(b)** tone mapping is the lever, not resolution —
  raw luminance left 78.9% of cells blank on near-black art, `--normalise --gamma 0.6`
  moved it to 49.8%, while 120x40 / 200x60 / 220x64 differed by under a point; **(c)**
  the score is a RANK correlation, because a mean-luminance error ranked the unreadable
  conversion above the readable one (3.27% vs 6.97%) — an almost-black image is
  faithfully reproduced by blanks. A tone curve is monotonic, so order is what must
  survive. `convertImage` also returns per-cell intensity, pre-curve intensity and
  colour; the .qbdata carries only glyphs, because the converter is deterministic and
  the source is checked in, so reconverting beats hauling 12,000 unused floats.
  ⚠️ The tool WRITES, so it is excluded from `npm run bench` and listed in
  `bench-gate.test.ts`. ⚠️ There is no primitive for blitting a block of rows —
  `put <list>` is the masked map (§11.12) — so converted art is drawn a row at a time.
  ⚠️ **Sobel is offline only.** `spriteEdgeGlyphs` lives in `src/tools/spriteGen.ts`
  because a sprite's pixels exist at generation time. At run time there is no pixel
  source, and a native that sampled one would be inventing its input (I2). The gradient
  points ACROSS an edge, so the glyph comes from `(-gy, gx)` — inverting that rotation
  draws every edge at right angles to where it is.
- **The density ramp is measurable, not just hardcoded (§11.15).** `DENSITY_RAMP`
  (`" .:-=+*#%@"`) stays the default, but `bench/measure-ramp.mjs` measures ink coverage
  from a rendered glyph strip and emits a `.qbdata` table `glyph()` accepts as its second
  argument — a data change, not an API change. Measured on one terminal, the hand-written
  order was wrong in two places (`+` lighter than `=`, `%` lighter than `#`).
  ⚠️ **A ramp belongs to a font.** One measured from Cascadia is wrong for Iosevka, which
  is why it ships as swappable data and why the engine default never moves to match a
  single measurement.
  ⚠️ **There is no rasteriser and there will not be one.** The strip comes from outside
  (committed as `bench/ramp-strip.png`); adding a font/canvas dependency to render one
  breaks the zero-dependency rule this project treats as load-bearing.
- **DoD**: animated multi-layer scene where a primitive crosses layers with different z.

## 10. COORDINATES — technical checklist

- `coord.ts`: world↔local conversion. By default primitives use layer-relative coords;
  `world: (x, y)` forces global.
- Anchors (`anchor: center | top-left | ... | (fx, fy)`) = translation and scale pivot.
- v0.1 transformations: **translate** and **scale** (character repetition).
  Rotation is NOT in v0.1: document as future, do not implement halfway.
- **DoD**: an object anchored at center moves without jumps; world↔local conversion tests.

## 11. ANIMATION — technical checklist

- `easing.ts`: `linear, ease-in, ease-out, ease-in-out, bounce, elastic` as pure
  parametric curves (function `f(t) → [0,1]`, stateless). **That is the closed set** —
  names outside it are a runtime error (`out-bounce` is not one of them).
- `tween.ts`: the native `animate(name, from, to, duration[, easing])`, plus
  `animate_done(name)` and `animate_reset(name)`. Host-side state keyed by name.
- `timeline.ts`: exposed as **7 natives** — `timeline_wait`, `timeline_step`,
  `timeline_sequence`, `timeline_parallel`, `timeline_duration`, `timeline_active`,
  `timeline_progress`. A timeline is a **value that is queried**, not a scheduler that
  runs. Nestable (parallel inside sequence and vice versa).
- **Frame-swapping**: multi-frame `.qba` sprites with `---` separator; `frames: N fps: M
  loop: true` → the runtime swaps the frame according to the game clock, not the render one.
- The real QBSK surface — **native calls, not method syntax**:
  ```qbsk
  sprite "res/walk.qba" at (10, 20) frames: 6 fps: 10 loop: true
  var x = animate("hero_x", 10, 100, 2.0, "ease-out")
  var tl = timeline_sequence([timeline_wait(0.5), timeline_step("intro", 1.0)])
  ```
  ⚠️ Earlier drafts of this skill listed `hero.animate("x", from: 10, to: 100,
  duration: 2s, easing: out-bounce)` and a `timeline intro` / `wait 0.5s` block form as
  "syntax to support". **Every part of that is fictional**: there is no method-call form
  (`type 'int' has no members`), named arguments are rejected on function calls, `2s` is
  not a literal, `out-bounce` is not an easing, and `timeline`/`wait`/`parallel`/
  `sequence` are not keywords. §14.7 of the language spec records that the `timeline`
  statement "was never real" and removed it from the grammar. Building it would create a
  second, parallel animation surface.
- **DoD**: walking character with synchronized frame-swap and a `parallel` + `wait`
  timeline, expressed through the natives above.

## 12. SPRITE FORMAT (.qba)

```
# comment
META name: walker, width: 4, height: 4
▓▓▓▓
▓  ▓
▓  ▓
▓▓▓▓
---
# Frame 2 — the --- separator
▓▓▓▓
▓░░▓
▓  ▓
▓▓▓▓
```

- `META` header with **`name`, `width`, `height` — and nothing else.** `parseMeta` handles
  exactly those three and drops every other key in its `default` branch.
  ⚠️ **`anchor:` on a META line is silently ignored**, and earlier drafts of this skill —
  and `docs/engine.md`'s own canonical example — put it there. It is a live instance of
  the ghost-feature shape the project banned. Anchors come only from the DSL property
  (`sprite "h.qba" at (0, 0) anchor: center`). Do not write it into a `.qba`.
  ⚠️ **A frame cannot override META either**: `loadQba` applies META only before the first
  frame's art; every later `META` line is skipped. A second `META name: walker.2` does
  nothing.
- Empty inner lines = spaces; shorter rows are padded with spaces.
- Tolerant loader: ignores `#` and blank lines outside the art; CLEAR error with file
  name if the resource is missing. Note the width check is one-sided — a row **longer**
  than the declared width errors, a shorter one is padded.

## 13. Quality standards (mandatory)

1. Byte-for-byte golden files per primitive, reference scene and intermediate animation
   frame (tweens are deterministic → so are the goldens).
2. Versioned benchmarks in `bench/`. **`npm run bench` measures for real** (§13.1 of the
   engine spec): the reference profile plus six read-only benchmarks. Its exit code says
   whether every benchmark RAN — it deliberately does not gate on absolute milliseconds,
   because the same commit measures 25% apart across sessions on this hardware. Trust the
   RATIOS (interpreter ~95% of the frame, diff + emit ~5%); for a real before/after,
   profile two commits back to back in one sitting.
   ⚠️ Never run the generators (`sprite-gen`, `worldgen-gen`, `worldgen-names-gen`,
   `spritesheet-slice`, `sprite-gen-batch`) casually — they WRITE into `examples/res/`
   and rewriting a `.qbdata` turns the determinism tests red. `npm run bench` excludes
   them for that reason.
3. The engine never writes to stdout outside `render.ts` (emission phase).
4. **`npm run build` + `npm run typecheck` + `npm run lint` + `npm test` green** before
   closing a milestone. Current baseline: 114 test files / 2,020 tests.
5. Every new feature with a working example in `examples/`.

## 14. Forbidden anti-patterns

- ❌ Emitting the whole screen every frame (kills diffing; if you see it, it is a bug).
- ❌ `clear screen` every frame (flicker + flashing).
- ❌ System calls inside the hot path (diffing is pure cell computation).
- ❌ Storing terminal state without restoring it (leaves the terminal broken).
- ❌ Indexing the canvas out of range in composition (clip first, always).
- ❌ Relying on real time for frame-swapping: ALWAYS the game clock.
- ❌ `try/catch` blocks inside the diff loop — the hot path cannot pay that cost.
- ❌ Accepting a named argument, a META key or a style name that nothing reads. A silent
  no-op in a DSL is annoying; under a game loop it is sixty frames a second of nothing
  happening, with no diagnostic. (See the language spec §14/§15.)

## 15. Work protocol for each task

1. Read the phase in **`the roadmap`** (the operative source
   of truth) and `docs/engine.md`. the roadmap was historical vision — an earlier release is M10–M14,
   an earlier release is M15–M19 — and parts of it teach syntax the language rejects.
2. Identify whether the change touches the emission path (`render.ts`, the only writer of
   ANSI bytes) or the terminal lifecycle (`src/cli/main.ts`) → isolate the risk.
   ⚠️ Earlier drafts sent you to `terminal.ts`, which does not exist.
3. Failing test first (unit or golden). 4. Implement.
5. build + typecheck + lint + test green, and measure with `npm run bench` — which runs
   the reference profile and six benchmarks, and fails if one stopped working.
6. Verify manually in the real terminal (Windows Terminal at minimum).
7. Report: what was done, measurements (ms/frame, cells emitted) and the next step.

**Verify, do not trust — including this file.** Every factual claim here was wrong once:
this skill has previously described a `terminal.ts` that never existed, a `--no-ansi` flag
that never existed, capability detection that was never written, four shipped modules
listed as "not yet implemented", an animation syntax that is fictional in five separate
ways, and a `.qba` META key the loader drops. If a claim here matters to your task, check
it against the code before relying on it, and correct this file when it drifts.
