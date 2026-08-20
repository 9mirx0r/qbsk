# QBSK Studio — Spec (docs/studio.md)

> **Status:** v0.2 — the window and the embedded MCP server. I redirected the project
> here on 2026-08-06: QBSK stops being a terminal CLI and becomes an application with its
> own window — an environment where the language lives, runs and is seen. Every Studio
> implementation complies with this spec.

---

## 1. What Studio is

QBSK Studio is the desktop application that hosts the QBSK language and its ASCII engine
inside a window. It is not a second language and not a second engine: it is a host. The
language core (`src/`) stays exactly as it is — pure TypeScript, zero runtime
dependencies, testable headless — and the window is a new, optional top layer.

Owner decisions that are not re-litigated:

| Question | Decision |
|---|---|
| Window technology | **Electron** — accepted knowing it ends the zero-dependency property |
| "Everything in our language" | **Staged hybrid** — host in TypeScript now, migrate pieces to QBSK as the language freezes; migration candidates marked from day one |
| AI control surface | **Full control** — write, execute and see: eval, project files, read the grid, inspect state, control the loop (an earlier release, MCP) |

## 2. The architectural rule — the one-way dependency arrow (non-negotiable)

> **`src/` must never import Electron, and must never import from `studio/`.**
> **The dependency arrow points one way only: `studio/` → `src/`.**

Electron is confined to the new top layer. Consequences that make this concrete:

- `npm test` keeps running the core tests headless, **without launching a window**.
- If Electron is ever dropped for Tauri, a browser or something else, `src/` is untouched.
- `src/` continues to compile standalone: `tsc -p tsconfig.build.json` does not know
  Electron exists.
- Rule #4 of the project rules extends to the studio: the studio never pollutes the language
  and the language never learns about the studio.

An automated enforcement test guards this (criterion 4): see §7.

## 3. Process model

```
Electron main process
  studio/main/index.ts    window lifecycle — the ONLY file that imports "electron"
                          besides the preload
  studio/main/host.ts     PURE host: loads QBSK files, runs scenes, holds the
                          double buffer + diff. Imports ONLY ../../src.

Electron renderer process
  studio/renderer/        index.html + styles.css (static chrome)
  studio/renderer/paint.ts        pure DOM painter: DiffLine[] -> DOM cells
  studio/renderer/renderer.ts     bootstraps the window, owns the loop glue
  studio/bridge/preload.ts        contextBridge -> window.api (RPC to main)

MCP server (an earlier release — §11)
  studio/mcp/             the embedded MCP server: pure host logic, no electron
                          import. Shares the interpreter state with the main
                          process, so what the agent runs is what the window draws.
```

- **Main process**: owns the interpreter state. `index.ts` creates the `BrowserWindow`
  and registers IPC handlers; the handlers delegate all QBSK work to `host.ts`.
- **Renderer process**: pure DOM. It never imports `src/` and never runs QBSK. It asks
  the main process for a frame and paints what it gets.
- **Bridge**: `preload.ts` exposes a minimal `window.api` via `contextBridge`. The
  window runs with `contextIsolation: true` and `nodeIntegration: false`. The renderer
  has no Node access.
- `host.ts` and `paint.ts` must not import Electron so they stay unit-testable headless.

## 4. How a QBSK scene reaches the screen

Exactly the existing pipeline, with the ANSI emitter swapped for a DOM painter:

```
.qbsk file
   |  readFileSync (host.ts)
   v
parse()  -- errors -> formatQbskError -> shown in the window (span + fragment)
   v
new SceneProgram(ast, { baseDir, runtime: { gameTime } })  // top level runs ONCE
   |  program.step(dt) -> Canvas { width, height, cells }   // per frame: events + re-compose
   v
Canvas { width, height, cells: Cell[] }
   v
ScreenBuffer(width, height) + paintCanvas(canvas)                     // double buffer
   v
computeDiff(front, back, width, dirtyLines)   // src/engine/diff.ts -- REUSED, not reimplemented
   v
DiffLine[] { y, changed, rewrite, row?, runs: CellRun[] { x, cells } }
   v
DOM painter: for each line, if rewrite -> rewrite the whole row; else patch each run.
```

The `Cell { char, fg, bg, attrs }` grid is painted into a monospace grid:

| Cell field | DOM mapping |
|---|---|
| `char` | cell text node (single character, `white-space: pre`) |
| `fg` `0xRRGGBB` or `-1` | CSS `color: rgb(r,g,b)`; `-1` -> default text colour |
| `bg` `0xRRGGBB` or `-1` | CSS `background-color`; `-1` -> transparent |
| `attrs` bitmask `1/2/4` | bold / underline / reverse |

The terminal (ANSI) and the window (DOM) are **two emitters over one diff** — this is
roadmap item C1 pulled forward. The diffing heuristic in `bench/baseline.md` is the same
code in both; it is not duplicated.

### 4.1 Tiles (C1) — a third mapping, applied after the diff

A tileset is an optional presentation layer (spec `docs/engine.md` §15). When one is
active, the DOM painter gains one more mapping on top of the table above:

| Cell field | DOM mapping (tiled) |
|---|---|
| `char` | stays in the cell text node — the grid remains the truth |
| `fg` / `bg` | made transparent — the tile image owns the pixel |
| tile | `background-image: url(dataUrl)`, sized to the cell |

**The window learns a tileset exists from a setting, not from the scene.** A QBSK
program never mentions tiles; the owner picks a `.qbdata` tileset in the settings
dialog (like the font), and the main process loads it once and ships a
`Record<glyph, dataUrl>` to the renderer over `studio:tiles`. Nothing in the
language, the CLI, `qbsk_read_window`, the mirror or the goldens ever sees a tile.

**The lookup rides the diff** (measured in `bench/tiles.md`, 0.0013 ms/frame vs
0.0528 ms/frame full-grid): `paint.ts` consults the tile map only for the cells
`computeDiff` reported, in the same loop that already patches them. The decision is a
pure function, `tileForCell(cell, tiles)`, so it is headless-testable.

**Failure degrades, never crashes.** A tileset that fails to load — missing file,
shape violation, duplicate glyph, missing image — leaves the window painting
characters exactly as before, with the failure reported in the MCP activity log.
`QBSK_STUDIO_NO_TILES=1` forces characters regardless, the same shape as
`QBSK_STUDIO_SMOKE`.

**CSP:** the tile data URLs are `data:` URLs, so `index.html` gains
`img-src 'self' data:` in the Content-Security-Policy. Nothing else changes — no
network origin is ever added.

### 4.2 The GPU painter (an earlier release)

Two painters, one interface. `renderer.ts` calls `grid.paint(res.diff)` and has no
opinion about how the pixels arrive; `choosePainter` decides at startup and hides the
loser's host element.

**The choice is GL first, DOM as fallback — never an error.** `createGlDevice` returns
`null` when WebGL is unavailable rather than throwing, because a machine without a GPU
path is a machine, not a failure. F3's own measurement is what makes that acceptable: the
DOM painter costs 0.80 ms on a 450-cell diff, which is most frames, and only becomes
unusable when everything changes at once.

**Two data textures and an atlas, one draw call.** One texel per cell in each of two
RGBA textures:

| | `.rgb` | `.a` |
|---|---|---|
| `uFg` | foreground colour | glyph slot, low 8 bits |
| `uBg` | background colour | slot high bits, then the bold and underline flags |

**The slot is split across BOTH alphas**, and that is the detail an implementation gets
wrong for free. The atlas holds 1024 glyphs and braille alone is 256 (§11.15), so a slot
kept in one byte wraps at 256 to 0 and draws a space — silently, and on exactly the
scenes that use the most glyphs. `gl-pack.test.ts` reassembles the two halves and
compares against the slot the atlas gave; `gl-shader.test.ts` holds the same arithmetic
on the shader side.

**Slots are assigned on first use.** QBSK's glyph vocabulary is open — a `.qbdata` holds
anything, `braille()` generates 256, tiles bring more — so a fixed character list is a
list that is wrong as soon as an author types something not on it. Slot 0 is claimed for
the space before anything else can take it, because zeroed textures read as slot 0 and a
grid would otherwise come up tiled with whatever character was seen first. Overflow falls
back to the space and is reported in `overflowedChars`: silence would be §14's shape —
the wrong glyph, no error, and a defect reaching the author as "sometimes a character is
missing".

**Reverse is resolved at pack time; bold and underline are not.** Swapping two colours is
exact and free before upload, and a branch in a fragment shader is neither. Bold and
underline change how a glyph is drawn rather than which one, so they travel as flags and
the shader thickens or underlines. A real bold weight would be a second atlas, which is a
second rasterisation of everything for one attribute.

**What is tested and what is not.** Slot assignment, byte packing and grid logic are
ordinary modules with ordinary tests — that is where a GPU painter is wrong or right, and
mocking `gl` would only assert the shape of the mock. The device is thin by design: every
method is a direct GL call with no decision in it, and a decision reaching that file is a
decision that escaped its tests. The shader cannot be compiled headlessly, so what is held
instead is the one failure that costs nothing to make: a uniform renamed on one side of
the boundary. `getUniformLocation` returns null for a name the shader does not declare,
WebGL treats a write to a null location as a silent no-op, and the effect stops working
with no error anywhere — so the uniform list and the shader source are compared
directly.

**CRT.** Curvature, scanlines, phosphor bloom, chromatic aberration and vignette, in the
same pass as the composition because a second pass would need a framebuffer and this needs
none. All five share one `r2`, so the edge effects agree about where the edge is.
`CRT_DEFAULT` is mild on purpose — a CRT, not a broken monitor, and
every effect at full strength makes an ASCII game unreadable, which is a failure even when
it is authentic. `CRT_OFF` exists for screenshot comparison and for readers who cannot
look at the other one.

**The cell size follows the fit.** `applyFit` recomputes the font size on every resize
and hands the painter the pixel size of a cell, derived from the same two numbers the DOM
path uses: the font's own width ratio and the `.cell` line-height. The first wiring
hard-coded 8×16, which renders correctly at exactly one font size and stretches at every
other — invisible to a test that never resizes, and the first thing an author sees.
`setCellSize` is optional on the interface because `DomGrid` genuinely does not need it:
CSS scales its spans from one font-size on the container, and a texture has nothing to
inherit from.

**The font picker's cell shape reaches the engine.** A cell is `chPerEm` em wide and 1.15
em tall, so `cellAspectFor(chPerEm)` in `fit.ts` is the shape the engine draws diagonals
in (`docs/engine.md` §11.16), and it travels with `run` and `live` to `SceneProgram`.
Derived from the same two numbers `applyFit` hands the GPU painter, so the drawn ANGLE and
the drawn PIXELS cannot disagree — two expressions of one fact drift, and this one would
drift invisibly, as a diagonal that is subtly wrong rather than as an error.

Changing the font while a program is LIVE does not restart it: the program was built with
the old cell shape and keeps it, because restarting would throw away whatever state the
scene had reached. The window says so instead of leaving it to be noticed — a silent
"nothing happened" is how a working control reads as broken.

**Choosing the look.** Engine settings → *Screen* offers three presets: `CRT`,
`CRT, soft` and `Off — exact grid`, stored under `qbsk.studio.crt` and read **before** the
painter is built, so a reader who turned it off does not get one frame of the default on
every start. Changing it is five `uniform1f` writes and a redraw — the atlas and both data
textures stay, because rebuilding the device to change a look would drop them and stutter
a running scene.

`CRT, soft` is **derived**, `scaleCrt(CRT_DEFAULT, 0.45)`, and not a third table typed out
by hand: a middle setting written by hand drifts from the default the moment the default
is tuned, and that drift is invisible — the screen still looks like a CRT, just not like
half of this one.

On the DOM painter the control is **disabled and says why**. The CRT is a shader and
`DomGrid` has no shader, so `setCrt` is optional on the `Painter` interface exactly as
`setCellSize` is. Accepting the choice and dropping it would be worse than not offering
it: the reader who most needs *off* is the one who would come away believing they had
turned it off.

This closes the loose end F3 shipped with — the settings existed and were wired to
nothing, which made `CRT_OFF`, an accessibility affordance, reachable only by editing the
source.

## 5. Frame loop

The window runs the same loop contract as the CLI (`--ansi --loop`): the AST is parsed
once and evaluated with a **persistent interpreter** — the top level runs once, and per
frame the event handlers run and the scene re-composes from the live environment (spec
language.md §7.7, engine.md §7). `host.ts` keeps a `ScreenBuffer` and answers
`requestFrame()` with the current `DiffLine[]`; the renderer applies it and the status
bar shows the per-frame `ms/frame` split (script/compose/diff/emit) so a performance
regression is visible the day it happens.

## 6. Build and dependency model

- **Electron is declared only in Studio's dependency surface** — a dedicated
  `studio/package.json` (`devDependencies: electron`). The root `package.json` must
  never list it: the root package is `private` and its packaging tests pin the exact
  dependency set (`tests/unit/packaging.test.ts`).
- Studio has its own `studio/tsconfig.json`: `include: ["main", "bridge", "renderer",
  "shared", "../src"]`, `rootDir: ".."`, `outDir: "../dist-studio"`. This keeps relative
  imports intact after emit: `dist-studio/studio/main/host.js` imports `../../src/...`
  -> `dist-studio/src/...` (the same output the root build produces). Recompiling
  `src/` in the studio build is harmless: it produces identical output. The doubled
  `studio/` segment is the rootDir at work, not a bug — both trees are preserved.
- Renderer static assets (`index.html`, `styles.css`) are copied to
  `dist-studio/studio/renderer/` by a small script in the studio build.
- The Electron main entry is `dist-studio/studio/main/index.js`; the window
  `loadFile`s `dist-studio/studio/renderer/index.html`. `studio/package.json` points
  `main` at `../dist-studio/studio/main/index.js` — Electron resolves `main` relative to
  the package.json directory, so the `../` is load-bearing. A guard in
  `tests/unit/studio-enforcement.test.ts` asserts that path resolves to a real file
  after a build; this failure is invisible to tsc, eslint and the host tests, and only
  appears when a human launches the app — the worst place to find it.
- Root scripts stay untouched except lint gaining the pure Studio files.

## 7. Headless test strategy

Criterion 4 and criterion 5 must be verifiable **without launching a window**:

1. **Enforcement test** (`tests/unit/studio-enforcement.test.ts`): scans every `.ts`
   file under `src/` and fails if any imports `"electron"` or any specifier that
   resolves under `studio/`. Also asserts the root `package.json` has no Electron
   dependency, that `tsconfig.build.json` compiles only `src/`, and that
   `studio/package.json` `"main"` resolves to a real file under `dist-studio/` after a
   build. The rule is worthless if nothing checks it.
2. **Host test** (`tests/unit/studio-host.test.ts`): imports `studio/main/host.ts`
   directly (pure — no Electron) and runs `examples/hello.qbsk`; asserts the produced
   grid equals the CLI's golden byte-for-byte. Because both paths derive from the same
   `composeScene` canvas and the same `computeDiff`, the equivalence is structural:
   same `renderText()`, same diff run count, and each cell maps to the same colour
   values the ANSI emitter would use.
3. The 455 core tests stay green headless.

On top of the headless proof, a **window smoke check** closes the loop on the real
Electron stack. `npm run smoke` in `studio/` launches the app with `QBSK_STUDIO_SMOKE=1`;
the renderer paints the default scene and reports its grid back over IPC
(`studio:smoke`), the main process prints `QBSK_STUDIO_SMOKE=<json>` and quits, and a
20s watchdog aborts with a failure if the renderer never reports. The reported `text`
must equal `tests/golden/hello.qbsk.out` — the same byte-for-byte bar as the headless
host test, now through the real window. The report is a no-op unless the env var is
set; renderer console messages are forwarded to the main stdout in smoke mode so a
failure explains itself.

---

## 8. The window — approved visual reference (owner-approved 2026-08-06)

Implement against this, not from imagination.

**Style:** 90s beveled chrome (Windows 98 vocabulary) in a dark navy marine palette,
with modern hover transitions so it reads as a 2026 product, not a museum piece. Hard
corners throughout — **no `border-radius` anywhere on the app chrome**.

**Palette (exact hex):**

| Role | Hex |
|---|---|
| window face | `#16334f` |
| panel face | `#1b3a5c` |
| deep / inset background | `#061420` |
| bevel light | `#4a7ba7` and `#5c8db8` |
| bevel dark | `#04101c` |
| text | `#d6e4f0` |
| dim text | `#a8c4dc` |
| line numbers / labels | `#5b7a99` |
| syntax: keywords | `#f0a500` |
| syntax: names / identifiers | `#7fd4ff` |
| syntax: strings | `#c8e6a0` |
| syntax: numbers | `#e8a0c0` |
| syntax: named args | `#9ecb7a` |
| canvas dots | `#3f5f7a` |
| canvas drawn content | cyan `#7fd4ff` and amber `#f0a500` |
| status ok / green | `#9ecb7a` |

**The bevel rule — the detail most implementations get wrong:**

- *Raised* (buttons, toolbar, status chips): `border-color: light light dark dark`
  (top/left light, bottom/right dark).
- *Sunken* (editor, canvas, inspector, any content pane): the reverse —
  `border-color: dark light light dark`.
- Buttons on `:active` flip to sunken **and** `translate(1px, 1px)`.

**Gradients** — period-correct, Windows 98 title bars really were gradients:

- Title bar: `linear-gradient(90deg, #0a2740, #1e5182 60%, #2a6ba8)`.
- Toolbar and status bar: subtle `linear-gradient(180deg, #1f4569, #16334f)`.
- Panel captions: `linear-gradient(180deg, #1a4066, #0f2a44)`.
- Content panes stay **flat** — a gradient there competes with the ASCII grid.

**Transitions:** 100–120 ms ease on toolbar button background/colour and on inspector
row hover. That is the entire "feels 2026" delta.

**Layout, top to bottom:**

1. Title bar
2. Menu bar (File, Edit, Run, View, Scene, Help)
3. Icon toolbar
4. Row of `[editor | inspector]` (flex ratio 1.15 / 0.85)
5. Canvas, full width
6. MCP activity log
7. Status bar

- The inspector sits beside the **editor**, not the canvas: the canvas needs full width
  or the grid wraps.
- The inspector shows name, value and **type**, using QBSK's own first-class types
  (`40 int`, `3 list`, `4 dict`, `layer z0`, `scene`) — it displays things a Python
  inspector cannot.
- The status bar carries ln/col, fps **and ms/frame** (from `bench/baseline.md`) —
  keeping frame cost permanently visible is what makes a performance regression obvious
  the day it happens — plus an MCP connection indicator (an earlier release).
- The **MCP activity panel is the most important element on screen**, not decoration:
  it is the visible proof the agent is working inside. Without it the user cannot follow
  what the agent did.

**Icons — deliberate decision, do not "improve" it:** do NOT download 90s or pixel icon
sets from the internet. That reintroduces exactly the licensing trap avoided by rejecting
`cs16.css` — assets of uncertain origin inside a *proprietary* product. Use Tabler
outline glyphs at 16px inside beveled buttons; the retro effect comes from the bevel, not
the icon stroke. Toolbar set: file, folder, save | play, stop, next | checkbox, stack-2,
camera, with 2px beveled separators between groups. If real pixel art is wanted later,
draw the 16×16 grids ourselves so they are wholly owned.

## 9. Staged hybrid — bootstrapping candidates

Studio's own chrome — panels, menus, status bar — is a natural first target to rewrite
in QBSK later, since it is ASCII UI drawn by the very engine Studio hosts. Build it in
TypeScript now; keep each chrome component small and isolated enough to swap.

## 10. Non-goals for an earlier release

- Tweens, timelines, terminal raw mode and input are an earlier release; the window does not
  reimplement them.
- The terminal backend keeps working. The ANSI emitter is not deleted: it is emitter 1,
  the DOM painter is emitter 2.

---

## 11. The MCP surface (an earlier release — embedded MCP server)

> This section is the Criterion 1 spec of an earlier release. It was written **before** any MCP
> code existed. Every MCP tool and resource below is part of the contract; an
> implementation may add tools/resources but not remove or change these shapes.
>
> Two rules in `06-active-language-phases.md` §an earlier release are non-negotiable and are
> restated here so a future contributor cannot undo them by accident:
>
> **The two-layer documentation rule.** An AI reads *every tool description on every
> session, always*. So the manual is split: **tool descriptions** stay short and precise
> (what it does, what it takes, what it returns, how it fails — a few lines each,
> billed every session) and the **long manual lives in MCP resources**, fetched on
> demand (full `docs/language.md`, every example, the complete native reference, the
> scene DSL guide). The two layers never merge.
>
> **The manual is generated, never hand-written.** A hand-written AI manual drifts from
> the code, and the agent believes it. The project has produced that bug three
> documented times (`animate`, `sprinkle`, the brace-escape example); a hand-written
> MCP manual would be the fourth and the worst. So the reference content derives from
> the source of truth: native signatures/arities from `src/interp/natives.ts`, runnable
> snippets from `examples/` and the test suite — snippets that are *executed*, so a lie
> in the manual turns a test red — and language semantics from `docs/language.md`.

### 11.1 Process model and placement

The MCP server lives in `studio/mcp/` and is **pure** — it imports only Node builtins
and `../src` (never `"electron"`), so it stays unit-testable headless like `host.ts`.
At runtime it runs as a **standalone Node process**: the stdio entry
(`studio/mcp/stdio.ts`, launched with `npm run mcp` from `studio/`, or by an MCP
client passing `--root <projectRoot>`) boots the interpreter, the double buffer and
the resource manual in that process and serves them over stdin/stdout. It opens no
window and needs none. The one-way dependency rule (§2) extends to it: `src/` never
imports `studio/mcp/`.

The server is **stateless as a process and stateful as a session**:

| Concern | Owner |
|---|---|
| Protocol framing | `studio/mcp/stdio.ts` — read stdin, write stdout |
| Session state (project root, loaded program, live environment, loop) | `studio/mcp/session.ts` (`McpSessionHost`), fed by `McpServer` |
| The actual QBSK interpreter + double buffer + diff | `src/` via `SceneProgram` and the same `host.ts` helpers the window uses |

`McpServer` takes a host object that owns the `SceneProgram` + `ScreenBuffer`. In the
stdio process the host is a `McpSessionHost` (session.ts); in headless tests the test
supplies an in-process host. Sharing one interpreter between the agent and a live
window (embedding the server in the Electron main process) is a possible later step,
but today the agent's process and the window are separate — each owns its own state,
so a runaway agent cannot corrupt the human's window.

### 11.2 Transport — stdio only

The server speaks JSON-RPC 2.0 over **stdin/stdout, one JSON object per line** (newline
delimited). It opens **no socket and binds no port** — the agent runs on the same
machine, so a network transport buys nothing and adds the entire attack surface. The
protocol channel is never polluted:

- Tool results and errors are carried **in-band as JSON** — never on stdout.
- `qbsk_eval`'s `print` output is captured and returned inside the tool result. The
  stdout stream belongs to the protocol alone.

If a network transport is ever added it **binds to `127.0.0.1` only, never `0.0.0.0`**.

**Threat model, recorded in writing:** a tool that evaluates arbitrary QBSK is
precisely what an attacker would want. `qbsk_eval` can read files through `use` and
`sprite` imports (module resolution follows `baseDir`/relative paths), so it is *not*
a sandbox. The mitigations are: (1) stdio-only transport — no remote reachability;
(2) `qbsk_open`/`qbsk_save` resolve and reject any path that escapes the project root;
(3) the decision to expose eval over a network, if ever made, is deliberate, recorded
here, and carries the localhost-only binding as a hard constraint.

### 11.3 Wire protocol (JSON-RPC 2.0, newline-delimited)

The server implements a minimal, standard subset. Requests without an `id` are
notifications (no response). Unknown methods fail with JSON-RPC `-32601 Method not
found`. Every request and every response is a single line ending in `\n`.

| Method | Direction | Purpose |
|---|---|---|
| `initialize` | client → server | handshake: client declares its name; server replies `protocolVersion`, server name, tool/resource capabilities |
| `notifications/initialized` | client → server | client ready; the server may then handle `tools/*` and `resources/*` |
| `tools/list` | client → server | returns the tool catalogue (names + short descriptions + argument schemas) |
| `tools/call` | client → server | invokes a tool; `params: { name, arguments }` |
| `resources/list` | client → server | returns the resource catalogue (URIs + descriptions) |
| `resources/read` | client → server | returns the resource body for a URI |

Responses are `{ "jsonrpc": "2.0", "id": <echoed>, "result": ... }`. A protocol-level
failure is `{ "jsonrpc": "2.0", "id": <echoed>, "error": { "code", "message" } }`.
**A QBSK error (parse, analyze, runtime) is not a protocol error**: it is delivered
in-band in the tool result, shaped as §11.5 — so the agent can read the span, the
`^^^` fragment and the suggestion and correct itself.

### 11.4 The tool surface

The canonical tool set, the reason each exists, its arguments, its return shape and its
failure modes. `qbsk_check` and `qbsk_read_screen` are **not optional** — they are the
two that turn this from a remote keyboard into an autonomous loop.

| Tool | Reason | Arguments | Result | Failure |
|---|---|---|---|---|
| `qbsk_check` | validate before running (an earlier release analyzer) | `source: string`, `file?: string` (default `check.qbsk`) | `{ problems: QbskErrorShape[] }` — empty = clean | never fails at protocol level; problems are the result |
| `qbsk_eval` | run code in the live environment | `source: string` | `{ value: JsonValue, type: string, print: string[], error: QbskErrorShape \| null, canvas?: GridSnapshot }` | structured error (§11.5) |
| `qbsk_read_screen` | close the loop — see the grid | none | `{ grid: GridSnapshot }` | `{ error: QbskErrorShape }` if no scene has produced a frame |
| `qbsk_inspect` | read a live variable's value + type (feeds the inspector panel) | `name: string` | `{ name, value: JsonValue, type: string, binding: "var"\|"const"\|"native" }` | structured error if the name is not a live binding |
| `qbsk_list_vars` | enumerate what `qbsk_inspect` can read | none | `{ names: string[] }` | — |
| `qbsk_open` | read a project file | `path: string` (relative to project root) | `{ path, source: string }` | structured error: missing file or path escapes root |
| `qbsk_save` | write a project file | `path: string`, `source: string` | `{ path, bytes: number }` | structured error: path escapes root |
| `qbsk_loop` | start / stop / step the frame loop | `command: "start"\|"stop"\|"step"\|"status"`, `dt?: number` (step only, default `1/60`) | for `step`: the resulting `GridSnapshot` + frame metrics; for the rest: `{ running: boolean, frames: number, error: QbskErrorShape \| null }` | structured error |
| `qbsk_key` | press a key on the loaded program (an earlier release) | `key: string` (canonical name), `steps?: number` (default 1), `dt?: number` (default `1/60`) | `{ key, delivered: boolean, handled: boolean, frames, turn, grid, print }` | structured error: no program loaded, or an unknown key name with a suggestion |
| `qbsk_trace` | read the session log — what happened and why (an earlier release) | `limit?: number` (default 50), `since?: number` (sequence cursor) | `{ entries: TraceEntry[], next: number, dropped: number }` | never fails: an empty session is an empty list |
| `qbsk_load` | run a project file as the program (an earlier release) | `path: string` (relative to project root), `check?: boolean` (default true) | `{ path, lines, problems, grid, print }` | structured error: missing file, path escapes root, analyzer problems, or a load-time QBSK error |

**Tool descriptions stay at this length.** The long explanations live in resources
(§11.6), not here.

**Semantics that pin the shapes:**

- `qbsk_check` runs `parse()` then `analyzeProgram()` — the exact an earlier release pipeline —
  and reports every problem with its span; it **never executes** anything.
- `qbsk_eval` evaluates `source` against the **live top-level environment** of the
  loaded program (persistent interpreter, an earlier release): reads see live values, `print`
  is captured, and the scene re-composes so the agent can see the result. It does not
  re-run the top level. If the source declares a name already defined in the live
  environment, the existing binding wins — the snippet must not clobber program state.
- `qbsk_inspect` and `qbsk_list_vars` read the live top-level `Env` only — never
  transient call frames.
- `qbsk_open`/`qbsk_save` resolve the path against the **project root** and reject any
  resolved path outside it (path traversal is a structured error, not a protocol one).
  The project root is the session's working directory (default: the workspace root);
  module/sprite resolution inside QBSK stays relative to the including file, exactly as
  the interpreter does today.
- The loop: one `step` advances `gameTime` by `dt` (default fixed `1/60`) and runs one
  frame — `on start` once, `on tick`, queued keys/resizes, scene re-composition
  (`docs/language.md` §7.7). `start` arms the loop for the host to drive; `stop`
  disarms it and keeps the interpreter state. `status` reports the current state
  without side effects.
- `qbsk_eval` and `qbsk_loop step` may return a **`GridSnapshot`** (§11.5) so the agent
  can see the grid without a separate `qbsk_read_screen` call; `qbsk_read_screen`
  remains the always-available read of the current painted state.

### 11.5 The error model — nothing is flattened

The single biggest automation multiplier in this phase: an `qbsk_eval` that returns
`"error"` forces the agent to stop and ask the human what happened; one that returns the
span, the `^^^` fragment and the suggestion lets the agent **correct itself and
continue**. So QBSK errors cross the boundary **structurally**:

```
QbskErrorShape {
  kind: "syntax" | "semantic" | "runtime",
  message: string,
  file: string,
  start: { line, col, offset },   // 1-based line/col
  end:   { line, col, offset },
  source: string,                 // the offending source line
  fragment: string,               // the `^^^` caret line, as formatQbskError builds it
  suggestion?: string             // analyzer hint when present (e.g. "did you mean 'x'?")
}
```

Every tool returns errors in this shape; no tool flattens them to a bare string. The
`fragment` field carries exactly what the terminal and the window show today
(`formatQbskError` in `src/interp/error.ts`).

**`GridSnapshot`** is the shape that lets the agent see pixels:

```
GridSnapshot {
  width: number, height: number,
  rows: string[],        // renderText() rows, as painted
  cells: number,         // changed cells in the last diff
  ms: { script, compose, diff, emit }   // frame split (bench/baseline.md)
}
```

### 11.6 The resource surface (the generated manual)

Resources are the long manual, fetched on demand. They are **generated from the source
of truth**, never hand-written:

| URI | Content | Generated from |
|---|---|---|
| `qbsk://manual` | the full agent-facing reference — grammar, semantics, natives, DSL, examples — the resource an agent should read first | `docs/language.md` + the generators below |
| `qbsk://natives` | every native function: name, arity, argument types, return, the exact runtime error it raises on a type mismatch | **`src/interp/natives.ts`** — signatures and arities are introspected, not retyped |
| `qbsk://scene-dsl` | the declarative scene syntax (`scene`/`layer`/primitives, DSL inert names) | `docs/language.md` §7 + executed examples |
| `qbsk://language` | the current `docs/language.md`, verbatim | the file itself |
| `qbsk://examples` | index of every example | the `examples/` directory |
| `qbsk://examples/<stem>` | one example: its source **and its actual output** | the `.qbsk` file + `runQbsk` executed at generation time |

**The lie-detector:** every snippet embedded in the manual is executed when the manual
is generated, and the generated output is compared against the snippet's documented
output by a test. A snippet that no longer produces what the manual claims turns a test
red — this is how the `animate`/`sprinkle`/brace-escape class of bug cannot recur. The
generator runs from a committed script (`studio/mcp/generate-manual.ts`) and its
artifacts are regenerated (and re-verified) by the test suite on every run.

### 11.7 Headless test strategy (an earlier release)

Criterion 5 is an end-to-end proof with no human in the middle:

1. A client connects to a spawned stdio server (`studio/mcp/stdio.ts` as a child
   process, or `McpServer` with an in-memory transport).
2. It reads `qbsk://manual` (or a subset resource) to learn a piece of the language it
   did not know.
3. It writes a QBSK scene with `qbsk_save`, runs `qbsk_check` on it, **fixes what the
   analyzer reports**, evaluates it, reads the grid back with `qbsk_read_screen` and
   confirms what was drawn — with nobody copying anything between windows.
4. The same test asserts a deliberately-broken program returns a **structured** error
   whose span, fragment and suggestion are present (criterion 4), and that a
   hand-written manual could not fake the executed snippet outputs (criterion 3).

Unit tests cover each tool's shape and failure mode headless, using the core test
harness — no Electron window is launched by any of them.

---

## 12. The session mirror (an earlier release — one live session)

### 12.1 The problem

§11.1 states that the MCP server runs as a **standalone Node process** and boots the
interpreter, the double buffer and the manual *in that process*. The window
(`main/host.ts`) boots its own. So before this section there were **two independent QBSK
sessions**: an agent's `qbsk_eval` ran where the window could not see it, and showing a
new scene meant closing Studio, editing `DEFAULT_SCENE`, rebuilding and relaunching.

**Merging the two processes is excluded.** an earlier release established that a lazy
`import("electron")` to embed the server in the main process **hangs Electron's main
process**. This section connects two processes; it never merges them.

### 12.2 The mirror channel — one way, by construction

The MCP session **writes** a frame journal. The window **reads** it. There is no path in
the other direction.

```
  agent  ──stdio (control)──▶  MCP session  ──journal file (observation)──▶  window
                                    │                                          │
                              owns the QBSK session                   read-only mirror
```

| Concern | Owner |
|---|---|
| Control: evaluate, save, drive the loop | stdio, **one client**, unchanged from §11 |
| Observation: what got painted | the journal, append-only, readable by anyone |

**Why this preserves the §11.2 threat model.** The control surface is still a single
stdio client with no socket. The journal carries *only frame data* — grid dimensions and
changed cells. Nothing an observer writes can reach the session, because the session
never reads the journal. An attacker who obtains the journal learns what was drawn and
gains no ability to run anything. That is the whole reason observation was not
implemented as a second RPC channel.

### 12.3 The journal format

Path: `<projectRoot>/.qbsk-studio/session.ndjson` (git-ignored). One JSON object per
line, append-only, truncated when a session loads a new program.

| Record | Meaning |
|---|---|
| `{"t":"reset","seq":N,"width":W,"height":H}` | new program or size change — the reader clears its grid |
| `{"t":"frame","seq":N,"diff":[DiffLine]}` | one painted frame, **as a diff** |
| `{"t":"end","seq":N}` | the session ended; the reader stops trusting its last frame |

`diff` is the very `DiffLine[]` produced by `src/engine/diff.ts` — the same value the
ANSI emitter and the DOM painter already consume. **Full grids are never sent per
frame**: sending the whole screen would discard the diffing the second-backend design is
built on. A full repaint only happens implicitly, after a `reset`, when every cell is
changed anyway.

### 12.4 The window side

`main/index.ts` watches the journal, reads only the bytes appended since its last read,
and forwards each record to the renderer over the existing preload bridge as
`studio:mirror`. The renderer applies `reset` with `DomGrid.reset(w, h)` and `frame` with
`DomGrid.paint(diff)` — the same two calls it already uses for a local run, so mirroring
introduces no second painting path.

If the journal disappears or ends, the window reports it in the status bar rather than
freezing on a stale frame.

Who writes the `end` record: the stdio transport itself (`studio/mcp/stdio.ts`), when the
client disconnects — stdin closing, or the process exiting by any path. The session host
has no way to know its client is gone, so this is the one place a session can end. The
window's poll loop also treats a *vanished* journal (deleted, not just truncated — a
truncation is a new `reset`) as an end, reported once, so neither the graceful goodbye
nor the silent disappearance leaves a stale "live · frame N" on the status bar.

### 12.5 What stays true

- `src/` still imports neither Electron nor `studio/` — the journal writer lives in
  `studio/mcp/`, and the enforcement test still guards it.
- The suite still runs headless: the journal is a file, so its tests need no window.
- `npm run smoke` is unaffected; the local-run path is untouched.

---

## 13. Play mode (an earlier release)

### 13.1 What it is

Studio normally shows editor, inspector, MCP log and status around a small grid. Play
mode hides all of it and scales the canvas to fill the window — the equivalent of
pressing F5 in an editor to *just watch the thing run*.

| | |
|---|---|
| Enter | **F5**, or the Play button in the toolbar |
| Leave | **Escape** (or F5 again) — the previous layout is restored exactly |
| Applies to | a local run **and** a live mirror session (§12), so an agent's work can be watched full screen |

### 13.2 The rule that matters: scale the font, never the grid

Play mode changes **one** thing: the font size of `.dom-grid`. It never changes the
number of rows or columns, never re-wraps, never re-lays-out cells.

That is deliberate. If scaling touched the grid it would become a *second* rendering
path, and a scaled frame could drift from an unscaled one — the exact class of bug the
byte-for-byte goldens exist to catch. Because only the font size changes, a frame read
back in play mode is **byte-identical** to the same frame windowed, and `grid.renderText()`
is unaffected.

### 13.3 Sizing

`studio/renderer/fit.ts` is pure arithmetic, separated from the DOM so it is unit-tested
headless. It is the only part of play mode that can be *wrong*: hiding chrome is
structural, but a bad fit either overflows the window or wastes half of it.

A cell is `1ch` wide and `1.15em` tall (`.cell` in `styles.css`). For the monospace stack
Studio uses, `1ch ≈ 0.6em`. So the largest font that fits is:

```
byWidth  = availWidth  / (cols * 0.6)
byHeight = availHeight / (rows * 1.15)
px       = clamp(floor(min(byWidth, byHeight)), 6, 64)
```

Taking the **minimum** of the two is what guarantees the whole scene is visible: fitting
width alone would clip the bottom of a tall canvas. The result is clamped so a degenerate
scene (1×1, or a window dragged to nothing) cannot produce an unusable or absurd size.

Play mode recomputes on window resize and whenever the scene's dimensions change — a
mirror `reset` record (§12.3) carries new `width`/`height`, so the fit follows the agent's
scene automatically.

---

## 14. The engine console (an earlier release)

A console inside the window that talks to the **live engine**: evaluate QBSK against the
running program, inspect and change scene variables while the animation plays, hot-reload
a scene without closing anything. Quake's console, or Godot's remote debugger.

Two owner decisions on 2026-08-07 shape everything below, and both took the harder option:
the console points at **the running program, not the repository**, and it is drawn **by
QBSK itself, not by CSS**.

### 14.1 Why not a shell over the repository

A terminal for editing QBSK's own TypeScript from inside QBSK would be worse than the
tooling that already exists — no git, no test runner, no diff to review before a change
lands — and it would widen a surface §11.2 already treats as remote code execution. The
console reaches the **running program**; it never reaches the compiler on disk. Authoring
content is `qbsk_save`'s job (§11), and that already exists.

### 14.2 What it must not become

§12.2's security property is an asymmetry: **an observer of the agent's session cannot
write into that session.** `MirrorReader` has no write path, and
`tests/unit/studio-mirror.test.ts` asserts its surface by allowlist so that *adding* a
capability fails on purpose.

The console does not weaken that, and must not be allowed to:

```
  agent  ──stdio──▶  MCP session  ──journal──▶  window  ◀──keys──  you
                          │                        │
                    agent's program          LOCAL program
                                          (the console's own)
```

- The console drives a **local** `SceneProgram` owned by the Electron main process.
- It gets **no path into the MCP session's program**. The window keeps mirroring the agent
  read-only.
- A renderer→main channel for local keys is new, but it is **not** the channel §12.2
  forbids. The forbidden one is observer→session; this one is you→your own program. The
  two are easy to conflate and must not be.

### 14.3 The console is a QBSK scene

`shade scanline` already exists (`docs/engine.md` §11.6), so the CRT look is **generated,
not imitated**: scanlines, phosphor glow, a blinking cursor, text revealed as if typed.

This is deliberate dogfooding. The engine's most-used surface being written in the engine
is the strongest available test of whether the language is actually pleasant to build
with — and every weakness it exposes is a weakness real users would have hit anyway. When
the console is awkward to write, the language is wrong, and that is information worth
paying for.

It also means the console inherits everything the engine already does: layers, `z`,
tweens, timelines, shades, the differential renderer that emits nothing when nothing
changed.

### 14.4 What the window has to gain first

`StudioFrameHost` (`studio/main/host.ts`) is **complete and never instantiated** — it
parses once, holds a `SceneProgram`, steps it, double-buffers, diffs, and returns a
`StudioFrame`. Its only referrer is a unit test. The frame engine exists; the window is
missing an owner, a clock and a channel.

| Missing | Consequence today |
|---|---|
| A persistent program in main | `studio:run` builds one and discards it, so a keystroke has nowhere to land |
| A clock | Nothing calls `step()`, and queued keys only dispatch inside `step()` |
| A renderer→main channel | The bridge has four `invoke` wrappers and one `on`; no `send` at all |

**The clock belongs to the main process.** Main owns the program and drives it on a timer;
the renderer stays a pure painter fed by the existing one-way `StudioFrame` flow. Putting
the clock in the renderer would split ownership of the program across a process boundary
for no gain.

### 14.5 Key routing

Electron emits `ArrowLeft`. The language, the tests and every example say `arrow-left`.
The canonical table therefore lives in `src/` — the one-way rule (§3) forbids `src/`
importing from `studio/`, and the terminal backend (an earlier release) needs the same table.

- **An unknown key name is a static error.** Today `on key "qwerty"` parses, analyzes and
  runs clean, and simply never fires — the `sprinkle` failure shape, and exactly what
  an earlier release exists to stop.
- **F5 and Escape stay with play mode** (§13). A scene cannot steal them, because a user
  who cannot leave full screen has lost the window. The console gets its own toggle and
  its own dismissal, and the collision is resolved here rather than in a conditional
  buried in the renderer.

### 14.6 The host→program data path

Command output has to enter the console program's state, and a QBSK program cannot reach
out to fetch it. So the host hands data **in**, the same shape as `gameTime()` reading
from `runtime`: the program asks, the host has already put it there.

Designed as a **general capability, not a console-shaped hole** — a host can give a
program data; a program can never call out of the sandbox. That keeps the determinism
guarantee intact (`docs/language.md` §7.7): a frame is still a pure function of the live
state, and the same data with the same clock still produces byte-identical frames.

### 14.7 The stream

§12 already gives the window a read-only view of the agent's frames. The console extends
it to carry **what the agent did**, not only what got painted — every action in order, as
it lands.

**Stated honestly, including in the UI:** an AI does not type. It makes tool calls. What
the window shows is a faithful replay of those actions, revealed as typing. That is
worth building and worth being accurate about; overselling it as a camera on a keyboard
would be a lie the first curious user catches.

### 14.8 The key that opens it

**F1 by default, rebindable in engine settings, and there is a toolbar button.**

The traditional choice is the backtick, as every console since Quake. It was wrong here
and the owner found it within a minute: **on a Spanish keyboard the backtick is a dead
key.** It waits for a vowel to compose `à` and never reports itself as a `keydown`, so
the traditional binding is not merely awkward for a large part of the world — it is
unreachable. A key that does not exist on your layout is not a way in.

- **F1** is one press on every layout and is never a dead key. `keyFromDom` drops the
  function keys (§14.5), so binding it costs a scene nothing.
- **A button as well**, because a binding that fails leaves no way in at all. The icon is
  a terminal prompt, deliberately not another play triangle — two buttons with the same
  glyph already cost this project a bug report once.
- **`Escape` and `F5` cannot be bound.** They leave play mode and the settings dialog;
  taking them away would strand a user in full screen with no way out.
- **A modifier alone cannot be bound** — it would fire on the way to every shortcut.

---

## 15. The window snapshot (an earlier release)

The session mirror (§12) runs one way: the MCP session writes frames, the window reads
them. **This is the opposite direction** — the window publishes what it is showing, so an
agent can see the person's screen: their live scene, their console, whatever they opened.

Without it an agent is blind to everything it did not draw itself. It can drive its own
session and read its own output, and has no idea whether the window in front of the
person shows a running scene, an error, or a frame frozen twenty seconds ago.

### 15.1 Why this does not weaken §12.2

§12.2 protects exactly one property: **an observer of the agent's session must not be
able to write into that session.** It is about control flowing backwards into a running
program.

```
  §12   MCP session ──journal──▶ window     (observation, agent → person)
  §15   window ──snapshot──▶ MCP session    (observation, person → agent)
```

The two channels are **opposite in direction and identical in kind**. This one carries a
grid of characters, a label for what is on screen, and the path of a PNG. There is no
record shape that runs anything, `readWindowSnapshot` is a function with no write path,
and a test asserts `WindowMirror`'s surface by allowlist so that adding a capability
fails on purpose — the same discipline `MirrorReader` is held to.

The snapshot is also **validated rather than trusted**: the file is on disk and anything
could have written it, so malformed content reads as "no window", never as a crash.

### 15.2 `qbsk_read_window`

Returns the grid, its size, what the window is showing (`scene`, `console` or `static`),
the path of the PNG, and **how many milliseconds old the snapshot is**.

The age is not decoration. A window that has been closed leaves its last frame on disk,
and a reader that cannot tell live from stale would confidently describe a screen nobody
is looking at. It is the difference between "here is the screen" and "here is a screen
from four minutes ago".

| | |
|---|---|
| `qbsk_read_screen` | what **this session** painted |
| `qbsk_read_window` | what the **person** is looking at |

**Tiles never change what this returns** (engine.md §15): the snapshot reads the cell
`textContent`, which stays the character even when a tile image is painted over it, so
an agent driving the window keeps reading the character grid whether or not a tileset
is active.

**The tool list is locked** by a `toEqual` assertion over its exact names, so adding one
is a decision rather than a side effect. This is the record of that decision, made at the
owner's request on 2026-08-07.

### 15.3 Both a grid and a picture

The grid is the primary, and for an ASCII application it *is* the screen: every cell
exactly, diffable, assertable against a golden. A PNG cannot be any of those things.

The PNG exists for what the grid cannot carry — the font, the colours, the phosphor glow,
whether the layout is actually right. It is captured **only when the grid changed**,
because the engine's whole rendering model is "emit nothing when nothing changed" and
capturing an identical window thirty times a second would be the one place in this
codebase that ignored its own rule.

Neither is written under `QBSK_STUDIO_SMOKE`: a run that compares bytes has no business
writing snapshots or capturing pages.

### 14.9 Debugging a simulation

Once a program has entities and turns (`docs/engine.md` §12), the console gains two
commands and one correction. All three came from driving the console against
`examples/turns.qbsk` and reading what it actually answered.

```
> entities goblins
id   x   y  hp
 1  38   7   3
 2  44   9   3
 3  31  11   3
> sim
turn 2
> get turn
turn is a built-in function — call it: turn()
```

- **`entities <name>` lays them out as a table.** `get goblins` answers with a wrapped
  blob of JSON, which is correct and useless: the question a person is actually asking is
  *where is everyone*, and that is a column of rows. Columns size to their widest cell so
  an outlier is visible without reading, and a component missing from one entity prints as
  a dash rather than a gap — a hole in a table reads as a bug in the table.
- **A name that is not a list of entities is `null`, not an empty table.** "There are
  none" and "that is not entities" are different answers and must not look alike.
- **`sim` reports the turn**, which nothing else can: `turn()` is callable from an
  evaluation but the count is not a variable.
- **`get turn` teaches instead of answering literally.** It used to print
  `turn : native = <native turn>`. Someone typing that means the turn *number*; the console
  knows which one they meant, so it says how to get it — the same instinct as the
  analyzer's key-name suggestions.

**This is the payoff for entities living in QBSK.** They are ordinary dicts in the live
environment, so all of this reads and writes them with no bridge and nothing to keep in
step. `playerX = 44` moves the character while the game runs. A native entity store would
have needed every one of these commands written twice.

---

## 16. Playing and watching (an earlier release — `qbsk_key` and `qbsk_trace`)

### 16.1 The problem

§11 built a loop an agent can drive: write, check, evaluate, read the grid. It stops one
step short of the thing the project exists for. `examples/turns.qbsk` is the program that
proves QBSK makes **games** rather than animations, and its whole design is that *nothing
happens until you act*. An agent could load it, inspect it and read its grid — and could
never press a key. It could watch a world that would not move for it.

The capability was never missing. `SceneProgram.pressKey` (`src/interp/interpreter.ts`)
has existed since the input milestone; `src/cli/main.ts` calls it for `--keys`, and
`studio/main/host.ts` calls it for the window. Only the MCP host never did. The engine
could be played by a terminal and by a person, and not by the agent the whole surface was
built for.

The second gap is worse because it is silent. Every tool answers *what* it returned and
none answers *what happened*. When a key produces no visible change there is no way to
tell "no handler for that key" from "the handler ran and the move was blocked by a wall"
from "the handler threw". Those are three different bugs with one appearance: nothing.

### 16.2 `qbsk_key` — the world moves when the agent acts

```
qbsk_key { key: "arrow-right", steps?: 1, dt?: 1/60 }
  → { key, delivered, handled, frames, turn, grid, print }
```

- **Canonical names only** (`src/engine/keys.ts`): `"arrow-left"`, `"space"`, `"a"`, `"."`.
  A name that is not canonical is a **structured error carrying a suggestion**, produced by
  the same `suggestKey` the analyzer uses — an agent that typed `"left"` is told to try
  `"arrow-left"` instead of watching nothing happen. This is §11.5's contract applied to
  input: an error that teaches beats a silent no-op.
- **`delivered` vs `handled` are separate answers, and that is the point.** `delivered`
  says the key entered the queue; `handled` says a matching `on key` handler ran. A key
  with no handler is `delivered: true, handled: false` — legal, not an error, and now
  visible. Collapsing them into one boolean would recreate the exact ambiguity §16.1
  describes.
- **The press is followed by frames.** A key queued and never stepped does nothing: the
  queue drains on the next `step` (`§7.7`). So `qbsk_key` presses *and* advances `steps`
  frames, returning the grid after them. The default of 1 is what a turn-based game needs;
  an animated reaction needs several, which is why the count is a parameter and not a
  constant.
- **`turn` is reported because it is the question being asked.** In a turn-based program
  the observable effect of a key is that the simulation clock moved. A free action leaves
  it unchanged — `examples/turns.qbsk` presses `i` for exactly this reason — so the number
  is how an agent distinguishes "my key did nothing" from "my key was a free action".
- `print` carries anything the handlers printed, so `print()` remains a debugging tool from
  inside the language rather than output the agent cannot see.

**Not a new capability, a new door.** `qbsk_key` calls the same `pressKey` and the same
`step` as the CLI and the window. There is no second input path to keep in step, and no
behaviour reachable by the agent that a player could not also produce.

### 16.3 `qbsk_trace` — the log an agent can actually read

The session already writes a journal (§12): `reset`, `frame`, `action`, `end`, appended as
NDJSON for the window to mirror. It is a **frame** channel — diffs and tool names — and it
is write-only from the session's side. It cannot answer "why", and by §12.2's design the
session must never read it back.

`qbsk_trace` is therefore a **separate, in-memory ring** the session both writes and reads.
It does not touch the journal, so §12.2's one-way property is preserved exactly.

```
TraceEntry {
  seq: number,            // monotonic, never reused — the cursor for `since`
  at: number,             // ms since session start, not wall clock: comparable across runs
  kind: "tool" | "load" | "frame" | "key" | "turn" | "print" | "error",
  detail: string,         // one line, already human-readable
  data?: JsonValue        // the structured payload when there is one
}
```

- **`detail` is a sentence, not a field dump.** The consumer is a model reading a list, so
  `key 'arrow-right' → handled, turn 3 → 4` costs one read; `{"key":"arrow-right",...}`
  costs a parse and a reconstruction. `data` keeps the machine-readable form for when it
  is actually needed.
- **`at` is relative to session start.** Two runs of the same sequence produce comparable
  traces, which is what makes a trace usable as evidence rather than an anecdote.
- **A ring, capped, dropping the oldest, reporting `dropped`.** An unbounded log inside a
  60 fps loop is a memory leak with a nice name. Dropping silently would be worse than
  dropping: an agent reasoning over a truncated history without knowing it is truncated
  draws confident wrong conclusions. The count is returned so the gap is a fact, not a
  surprise — the same reasoning as the input queue's drop-oldest policy
  (`docs/engine.md` §8.2) and as `readWindow`'s `ageMs`.
- **`since` makes it a stream.** `next` is the cursor to pass to the following call, so
  polling costs only what happened since — the same offset discipline the window mirror
  uses to watch the journal.
- **Errors are recorded, not just returned.** A runtime error that kills a frame appears in
  the trace with its span, so the failure is still legible after the tool call that
  produced it is out of context.

### 16.4 What this closes

With these two, the agent's loop is the player's loop:

```
qbsk_eval (load) → qbsk_key → qbsk_read_screen → qbsk_trace → qbsk_key → …
     write            act          observe          explain        correct
```

Every step of that was reachable before except *act* and *explain*, which are the two that
make the difference between operating an editor and playing a game.

---

## 17. Running a file (an earlier release — `qbsk_load`)

### 17.1 The problem

Loading a program that exists on disk took two calls and a detour. `qbsk_open` returned the
source, and the agent handed that source straight back through `qbsk_eval` — the file's
entire text making a round trip through the agent purely to arrive where it started. For
`examples/turns.qbsk` that is 192 lines paid twice, on a surface where context is the
scarcest resource there is.

Worse, it was easy to get subtly wrong. `qbsk_eval` loads only when **no** program is live
and evaluates a snippet otherwise (§11.4). So the same call means "run this program" or
"run this fragment against the running program" depending on state the agent has to
remember. Re-loading a file after an edit meant `qbsk_loop reload`, which re-runs whatever
source was loaded *last* — not the file as it is on disk now.

None of that was a missing capability. `open` + `eval` + `reload` could express it. It was
a surface that made the common thing awkward and the correct thing conditional.

### 17.2 The tool

```
qbsk_load { path: "examples/turns.qbsk", check?: true }
  → { path, lines, problems, grid, print }
```

- **The file is read by the host, not by the agent.** The source never crosses the wire. The
  result carries `lines` so the agent knows what was loaded without receiving it.
- **`path` resolves against the project root and rejects escapes**, exactly as
  `qbsk_open`/`qbsk_save` do (§11.4). One resolution rule for every path-taking tool; a
  traversal attempt is a structured error, never a protocol one.
- **It always loads fresh.** Unlike `qbsk_eval`, the meaning does not depend on session
  state: `qbsk_load` discards the current program and runs the file's top level. Calling it
  twice is a reload from disk, which is what an agent wants after `qbsk_save`.
- **`check: true` by default, and this is the important default.** The file is analyzed
  before it is run, and analyzer problems come back as `problems[]` **without loading
  anything**. An agent that runs an unchecked file gets a runtime error at frame 1 with no
  idea the analyzer could have told it at line 7 — `qbsk_check` exists precisely so that
  does not happen, and a load that skips it wastes the pipeline the project already built.
  `check: false` is available for deliberately probing a program the analyzer rejects.
- **One frame is composed after loading**, so `grid` shows what the program draws at rest.
  A load that returns no grid is a program that declares no scene — legal, and visible.

### 17.3 What it does not do

It does not replace `qbsk_eval`. Evaluating a fragment against a live program is a
different act with a different meaning, and merging them is what made the old surface
ambiguous. After this section:

| Intent | Tool |
|---|---|
| run a file as the program | `qbsk_load` |
| poke at the program that is running | `qbsk_eval` |
| re-run the source already loaded | `qbsk_loop reload` |
| read a file without running it | `qbsk_open` |

Each answers one question, and none of them changes meaning based on state the caller has
to track.

## 18. The error, on the line that caused it

### 18.1 The problem

A failed run put one line in the MCP activity strip: the pane furthest from the code, in
the smallest type, below the canvas. The message itself was complete — span, fragment,
and since §15.20 the call trace — and it was in the last place anyone was looking.
The editor is a plain `<textarea>` with no gutter, so the line number in that message had
to be counted out by hand.

Worse, the Run button did not report at all. There are THREE ways a run can fail, and they
were not equally served:

| Path | Where it failed | What the author saw |
|---|---|---|
| Static eval | `runStaticScene` | one line in the MCP log |
| Live start | `StudioFrameHost` constructor | one line in the MCP log |
| Live frame | `host.next()` returning null | **nothing at all** |

The third is the one the Run button uses after the first frame. A scene that died mid-frame
left the canvas frozen on its last good frame, the log empty and the editor unmarked, which
reads as the Studio having lost interest rather than as a program with a bug in it.

### 18.2 What it does now

A gutter of line numbers sits beside the editor. When a run fails, every line of the
error's span is marked in it, and a strip appears **under the editor, inside the pane the
author is looking at**, saying the line, the column and the message. Clicking the strip
puts the caret on the error.

All three paths above reach it. The live-frame path needed a channel of its own
(`studio:liveError`), because the failure was previously discarded rather than reported.

### 18.3 What is worth knowing

**The position travels as numbers, not as text.** `SceneRun`, `LiveStart` and
`LiveFailure` all carry an `ErrorMark` — line, column and character offsets —
beside the rendered message. The alternative was a regular expression over a formatted
error inside the renderer, which works until the message format changes and then silently
marks nothing.

**`studio/shared/marks.ts` has no DOM in it.** Every decision — how many rows the
gutter needs, which of them are bad, what the strip says, where the caret goes — is a
function from data to data, and is tested without a browser. That is the same reason
`studio/renderer/fatal.ts` is built that way.

**The gutter is a sibling of the textarea, not a part of it.** A `<textarea>` cannot style
a range, so the numbers cannot live inside it, and the two are kept in step by matching
`font-size`, `line-height`, `font-family` and top padding exactly, plus a scroll handler.
A test asserts those four match, because a line-height off by a hair looks right in a
ten-line file and is a full line out at line 200 — no amount of looking at a short file
finds it.

**The mark is a background, not a character.** A marker glyph in the gutter would push that
one line`s digits a column to the right.

**Every write to the editor goes through `setEditorSource`.** Assigning to `editor.value`
fires no `input` event, and the gutter listens for one. Both existing writes bypassed it:
the gutter was empty at boot and showed the previous file's numbers after opening a new
one. Fixing the two sites would have left the third to be written later, so there is one
door and a test that says so.

**The gutter is MAINTAINED, not rebuilt.** Rebuilding every row on every `input` measured
**32.19 ms per keystroke on a 3,000-line file** in the real window — two dropped frames
per character typed — and it was rebuilding to produce the same numbers, because typing
inside a line changes none of them. Only pressing Enter or deleting a newline changes the
count, and that adds or removes one row at the END. Maintaining it instead: **0.71 ms**,
45× faster. The marked range is tracked separately from the row count for the same
reason: it only changes when a run fails.

**The first edit after a failure drops the mark and keeps the message.** A `<textarea>`
cannot move a mark with the text under it, so a mark left in place points at whichever
line happens to carry that number now. Deleting the failing line and adding two elsewhere
brought the red line back on unrelated code — found by shrinking and growing a document
in the real window and reading the DOM back. The strip stays, because "line 3, col 11: ..."
is still a true statement about the last run and it is what the author is reading while
typing the fix.

**The selection is clamped.** The offsets come from a run and the author can type before
clicking the strip. Unclamped, a document that got shorter throws inside the DOM —
which is the fatal overlay appearing because someone pressed backspace.

### 18.4 What it does not do

No syntax highlighting, no squiggly underline under the span, and no second error. A
`<textarea>` can do none of the first two without becoming a different editor, and QBSK
reports one error at a time by design.

## 19. The Inspector shows what the program is holding

### 19.1 The problem

The Inspector pane shipped with the first version of the Studio, and its contents were the
sentence **"Populated in Phase 12 (qbsk_inspect)."** — a promise, in the window, where a
feature should be. Anti-pattern 1 in its purest form: it renders, it costs a pane of screen
space, and it does nothing.

What makes it worse is that the machinery was already there. `StudioFrameHost.varNames()`
and `.inspect(name)` have existed since the engine console was built, and `vars` and `get`
have used them all along — **from the console, typed by hand, one name at a time.** Nothing
called them from the window that has a pane reserved for exactly that.

### 19.2 What it does now

While a scene runs, the pane lists every name the live program holds: the name, its QBSK
type, and the value as QBSK prints it. It refreshes as the scene runs, so a counter counts
in the pane.

### 19.3 What is worth knowing

**Pulled, not pushed.** A frame is sent thirty times a second and the pane is read by a
person. Refreshing per frame would put the whole variable set across the IPC boundary
thirty times a second for a pane nobody is watching that closely, so the renderer asks,
four times a second at most.

**Clipped in the MAIN process.** A list of ten thousand cells is a legitimate QBSK value
and `qbskStr` renders all of it. Clipping in the renderer would mean the whole string
crossing the boundary before anyone decided it was too long to read.

**Values first, functions last, and functions dimmed rather than hidden.** A program of
any size declares more functions than variables and they do not change while it runs, so
sorted together they push the handful of numbers that DO change off the bottom of the
pane — which is the one thing the pane is for. They are still shown, because a pane that
silently omitted half the names would be lying about what the program holds.

**Two different nothings.** "No program is running — press Run" and "the program is
running and holds no names" are not the same message. Saying "no variables" to someone who
has not pressed Run sends them looking for a bug in their code.

**The pane shows at most 200 rows, and says how many it left out.** Measured with a
program holding 1,201 top-level names: **12.7 ms per refresh and an 85 KB IPC message,
four times a second** — enough to drop a frame of a running scene every quarter second.
Capped: **2.8 ms and 14.7 KB**. Nobody reads 1,201 rows; a pane that showed 200 of them
without saying so would be lying about what the program holds.

**Rows are built with `textContent`.** Every string in this pane was made up by the program
being inspected, and this is the one pane whose entire job is showing them.

### 19.4 What it does not do

It does not let you EDIT a value, expand a list, or set a watch. Editing means writing into
a running interpreter from outside it, which is a much larger decision than a read-only
pane, and `get`/`set` in the engine console is the place that argument belongs.

## 20. The files you actually work on

### 20.1 The problem

Opening a scene meant a modal file dialog, starting at `examples/`, every single time. So
returning to the file you were editing five minutes ago cost a dialog, a folder walk and a
double click — for a file the Studio had just had open. The folder button in the toolbar
was wired to nothing at all.

### 20.2 What it does now

The folder button drops a list of the files opened recently, most recent first, and one
click opens one. The list survives closing the Studio.

### 20.3 What is worth knowing

**The list lives beside the app's own settings, not in the repository.** It is about this
machine and this person. A file in the working tree would follow the project into a commit
and tell whoever cloned it which folders somebody else keeps their scenes in.

**One file is one entry however it was spelled.** Compared case-sensitively and
separator-sensitively, `C:\x\a.qbsk` and `c:/x/a.qbsk` are two rows for one file, and on
Windows both spellings arrive depending on how the file was opened.

**Files that have gone are filtered out when the list is read, and checked AGAIN when a
row is clicked.** The list is read once when the menu opens, and a file can be renamed
while the menu is on screen — and an unguarded `readFileSync` in a handler is an unhandled
rejection in the renderer, which is the fatal overlay for a missing file.

**A corrupt list costs the list, not the launch.** Missing, unreadable or not JSON all
return an empty list. A recent-files list is not worth an error dialog and is certainly
not worth failing to start over.

**Opening goes through one function.** The dialog path and the menu path both call
`loadScene`, so a scene opened either way stops the live program, replaces the source
through `setEditorSource` (§18), updates the status bar and runs — rather than two paths
that drift apart at the third thing one of them remembers to do.

**The menu is a child of the toolbar.** It is positioned with `top: 100%`, which means
"under the toolbar" only because the toolbar is its offset parent. The first version was a
sibling and landed at the top of the window, over the title bar — found by opening it and
measuring, not by reading it.

### 20.4 What it does not do

There is no file TREE, and no folder to browse. A tree needs a pane, and the window is
already dense; the value in this feature is getting back to the four files you are
actually editing, which a list of ten does completely. Nothing here writes files, renames
them or deletes them.
