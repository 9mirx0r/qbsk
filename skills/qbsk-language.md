---
name: qbsk-language
description: Skill for the design and implementation of the QBSK programming language (lexer, parser, AST, interpreter, natives, CLI, REPL). Use it ALWAYS when the task involves the QBSK language: grammar, tokens, keywords, declarative scene syntax, parsing errors, semantics, evaluation, variables, functions, closures, loops, "use" modules, or the qbsk run/repl/lex/parse/check CLI. Do not use it for the ASCII engine (use qbsk-engine) nor for example scene code outside the language context.
---

# QBSK — Language Designer & Toolchain

You are the senior architect of the **QBSK** programming language and the builder of its
toolchain (lexer → parser → interpreter → CLI). QBSK is an original, indentation-based
language with a declarative DSL for ASCII art, designed to be more intuitive than Python.

## How big this is

`src/` is **18,073 lines across 57 files**, plus about 20,900 in `tests/` and 5,300 in
`studio/`. Do not read it all: start from `git log` and the file the task names, and verify
by running rather than by reading. An `npm test` costs ten lines of output and proves more
than two thousand lines read.

## 1. Mission and non-negotiable principles

1. **Layout-first**: spatial position is a first-class citizen (`at (x, y)`,
   `from → to`, `anchor`). No pixel math.
2. **Zero boilerplate**: no mandatory imports, no `if __name__ == "__main__"`, no
   `def main()`. Running a script = running the script.
3. **Everything is nameable**: scenes, layers, sprites, timelines — everything with a
   name and explicit z-index.
4. **Errors that teach**: every error (syntax, parse, runtime) carries line/column, a
   highlighted snippet of the source code and a message in plain language (optionally a
   suggestion).
5. **Clarity over sugar**: a single way to do things. Before adding any keyword, ask
   yourself: can this not be expressed with what already exists? If it can, it is not added.
6. **Composability**: the scene DSL is a subset of the full language, not a separate
   dialect.
7. **Spec before code**: any syntax or semantics change is documented in `docs/language.md`
   BEFORE touching the lexer or the parser.

## 2. Mandatory references BEFORE coding

- **`the roadmap`** → the operative source of truth for
  which phase we are in and what closes it. Each phase carries explicit closing criteria.
  Read this first.
- `docs/language.md` → the formal specification (EBNF, keywords, types, precedence,
  indentation rules, error model, and §14/§15, the design rules for new constructs).
  It exists and is ~1600 lines.
- ⚠️ An earlier draft of this skill sent you to a roadmap file that is not in this
  repository. It was development planning, and **parts of it taught syntax the language
  rejects** (a `timeline` block statement, named args on calls, `2s` duration literals,
  a `.qsc` format that does not exist). Read it for intent, never as a syntax reference.
- The declarative scene syntax lives in `docs/language.md` (DSL section).
  ⚠️ **`docs/canvas-dsl.md` does not exist** — this skill used to cite it and that was
  false. Do not look for it or create it: the DSL spec is inside `docs/language.md`.
- `docs/` holds **four** specs: `language.md`, `engine.md`, `audio.md` (the `tone`
  primitive) and `studio.md` (the MCP surface). The last two are normative too.
- `examples/*.qbsk` → the examples are the executable source of truth for the syntax.
  The formal extension is `.qbsk`; there are 30 top-level examples (36 with `lib/` and
  `mods/`).

### 2.1 Reference blueprints (GitHub repositories) — steal architecture, adapt to the spec

Before implementing any module, study the corresponding repo and adapt ITS architecture
to the QBSK spec. Never copy code blindly: every piece must meet the spec (mandatory
spans, QBSK keywords, separate int/float, errors with snippet).

| Repo | Blueprint it provides | What to steal | What NOT to steal |
|------|----------------------|---------------|-------------------|
| `AugustinSorel/ts-interpreter` | Complete interpreter from scratch in TypeScript (OOP, classes, functions, built-ins, loops) | Lexer/Parser class structure, Pratt-style precedence tables, Environments system (chained scopes), AST typing in TypeScript | Its syntax (it is another language), its error model without spans, its lack of indentation |
| `RonaldDijks/writing-an-interpreter-in-typescript` | Monkey (Thorsten Ball) translated to modern TypeScript (has REPL and tests) | Exact line/column positions in lexical and syntax errors (our basis for the Rust-style model), Pratt parser, complete REPL | Its generic types (`Null`, `Integer`...) — we use tagged `QValue` |
| `spencergoldade/AskeeDS` | Declarative design system (YAML) for TUIs: 56 components, tokens, themes, golden snapshots | VALIDATES our approach: screens declared as data (components + props + render specs), not as manual string-building | Its YAML format (we use QBSK as the DSL), its Python renderer |

**LEXER implementation directive** (activate verbatim in M2):

> "Act based on the `ts-interpreter` architecture. Implement a lexer in TypeScript that
> uses a numeric indentation stack to emit INDENT and DEDENT tokens, normalizing spaces
> and skipping comments without breaking line offsets."

## 3. File structure — the language half

You own these. `src/` has **11** directories in total; the rest belong to the engine
(`engine/`, `choreo/`, `audio/`, `ecs/`, `tools/`) and are read-only from here:

```
src/lexer/            # token.ts, lexer.ts
src/parser/           # ast.ts, parser.ts, qbdata.ts
src/interp/           # value.ts, env.ts, interpreter.ts, natives.ts, error.ts,
                      #   sceneMount.ts, saveState.ts, saveStore.ts
src/analyze/          # analyzer.ts  (what `qbsk check` enforces)
src/cli/              # main.ts, args.ts
src/util/             # suggest.ts (levenshtein/closest), random.ts, ansi.ts
tests/unit/           # organized by FEATURE/PHASE, not mirrored per module
tests/golden/         # 26 byte-for-byte outputs (frames and audio buffers; no AST goldens)
```

`src/analyze/analyzer.ts` powers `qbsk check`: undefined names, const reassignment,
arity, module member typos, unknown key names, dead state directives, and Levenshtein
suggestions. Its own doctrine — **never report a problem that cannot be observed by
running the program** — is binding: a checker that flags working code teaches the author
to ignore it.

## 4. LEXER module — technical checklist

- `Token { type, value, span }` where `span` is `{file, start, end}` and each position is
  `{line, col, offset}`. There is no `kind` and no `lexeme` field — lexeme text is
  recovered with `tokenLexeme()` in `parser.ts`. Token types: identifiers, literals
  (`int`, `float`, `str` with escapes `\n \t \\ \"` — **there is no `\u` escape**),
  keywords (table), operators, punctuation, `EOF`, `INDENT`, `DEDENT`.
- **Indentation**: per line, count spaces; stack of levels → emit `INDENT`/`DEDENT`.
  Tab inside a block = friendly error with location (never ambiguous).
- Comments `//` and `/* */`; blank lines ignored (but line/column counting keeps them).
- Supports `: ` on the same line (e.g. `on key "x": var a = 1`) → the parser expands it
  into a single-statement block.
- A single unknown character → `QbskSyntaxError` with exact position and snippet.
- **Canvas blocks (Skill A — multiline literals)**: the lexer must treat `"""` as RAW
  SPATIAL DATA: the inner content (line breaks, spaces, characters) is a grid literal
  without emitting internal INDENT/DEDENT tokens, and without interpreting keywords
  inside. It is the piece that makes embedded ASCII art possible:
  ```qbsk
  scene MyIntro:
      canvas player_sprite at (10, 5):
          """
           O
          /|\
          / \
          """
  ```
- **DoD**: `qbsk lex demo.qbsk` prints the stream; the lexer suite currently holds 57
  cases (numbers, strings, nested indentation, errors) — a floor to hold, not a target.

## 5. PARSER module — technical checklist

- `ast.ts`: the `Stmt` union has **32 variants** and `Expr` has **13**. Read
  `src/parser/ast.ts` (the unions are at the top of the file) rather than any list written
  here — a stale node list makes an agent collide with an existing name or miss the
  `printStmt` obligation. The shape by family:
  - **Language statements**: `VarDecl, ConstDecl, FuncDecl, Assign, If, Match, ForRange,
    ForList, While, Break, Continue, Return, TryStmt, ExprStmt, UseStmt, Block`
  - **Declarative DSL statements** — half the AST, and the thing this project *is*:
    `SceneDecl, LayerDecl, EventDecl, CanvasDecl, FillStmt, PutStmt, TextStmt, BoxStmt,
    BorderStmt, LineStmt, SpriteStmt, ToneStmt, ShadeStmt, ColorStmt, ZStmt, VisibleStmt`
  - **Recovery**: `ErrorStmt` / `ErrorExpr` — the parser reports and continues (§8)
  - **Expressions**: `BinOp, Unary, Call, Lit, Ident, ListLit, DictLit, Tuple, Member,
    Index, InterpolatedStr, Lambda`
  - **Shared**: `NamedArg { name, value, span }` and `Param { name, typeAnnot, span }` —
    every primitive and declaration depends on these two.

  ⚠️ There is **no `AnimateCall` node** and no `AnchorCall`. `animate` is a native called
  through an ordinary `Call`. An earlier version of this skill listed `AnimateCall`, plus
  `List`/`Dict` under the wrong names (they are `ListLit`/`DictLit`).
- **Statements**: recursive descent. **Expressions**: Pratt parser with an explicit,
  commented precedence table (extending it must be trivial).
- Nodes carry `span { start, end, line, col }` ALWAYS (the error model requires it).
- Error recovery: report multiple errors per pass (mark the node as error and continue),
  do not abort on the first one.
- **DoD**: `qbsk parse demo.qbsk` prints the AST. ⚠️ There are **no AST goldens** in
  `tests/golden/` (all 19 are rendered frames or audio buffers); AST coverage is inline
  assertions in `parser.test.ts` and `ast-printer.test.ts`. Per §14.8, if the parser
  stores a field the printer must show it — otherwise no test can see it.

## 6. INTERPRETER module — technical checklist

- `value.ts`: `QValue` has **18 variants**: `null, bool, int, float, str, list, dict,
  tuple, func, native, scene, layer, event, sprite, primitive, canvas, rng, module`.
  ALWAYS distinguishes `int` from `float` (the coordinate DSL depends on it) — and note
  `tuple` is what the coordinate DSL is actually built on (`{type:"tuple"; x; y}`).
- `env.ts`: chained environments; closures capture the definition environment; `var` is
  block-scoped; redefinition in the same scope = error (more intuitive than Python).
  ⚠️ **`let` is not a QBSK keyword** — the declaration keywords are `var` and `const`
  only. An earlier version of this skill wrote "let/var"; writing `let` ships broken code.
- `interpreter.ts`: evaluator by visitation. EXPLICIT type coercion with readable errors:
  `error("cannot add 'str' and 'int' (line 7)")` — never a dry TypeError.
- Operators: arithmetic, comparison, `and/or/not` (short-circuit), concat `+`,
  repetition `*` (**strings only** — `[1, 2] * 3` is `cannot multiply 'list' by 'int'`),
  bitwise `& | ^ << >>` (ints only, L4), range `0..10` exclusive in `for`.
- `natives.ts` (host↔QBSK bridge). **84 natives are registered.** Verify the live list
  rather than trusting any written copy of it, including this one:

  ```bash
  node -e "const{createNatives}=require('./dist/interp/natives.js');console.log(createNatives({print:()=>{}},{}).names().sort().join(' '))"
  ```

  ⚠️ **Grepping `native("...")` finds only 69 of the 77.** Eight are registered through
  factory helpers (`min`/`max`, `round`/`floor`/`ceil`, `sin`/`cos`/`tan` — `natives.ts`
  ~1271-1318). A cross-check that greps alone will report false "missing native" findings.

  By group, as of this writing:
  - **Core**: `print, len, type, str, int, float, bool, clock, gameTime, args, exit`
  - **Canvas natives**: `canvas, fill, box, put, line`
  - **String**: `upper, lower, trim, split, join, replace, contains, starts_with, ends_with`
  - **List/dict**: `push, pop, sort, reverse, map, filter, reduce, slice, keys, values, has, find, without`
  - **Math**: `abs, sqrt, min, max, round, floor, ceil, sin, cos, tan, atan2, pi, random`
  - **Seeded RNG (L4)**: `rng, roll_float, roll_int` — the deterministic source; `random`
    is the only non-deterministic one and never appears in a golden
  - **Persistence (L1)**: `save_state, load_state, list_saves`
  - **Animation (M17/M18)**: `animate, animate_done, animate_reset`,
    `timeline_wait, timeline_step, timeline_sequence, timeline_parallel,
    timeline_duration, timeline_active, timeline_progress`
  - **Sim/ECS/engine bridge**: `turn, advance, spawn, path, sight, host, particle,
    project, glyph, lit`

  Each native declares its QBSK signature and throws `QbskRuntimeError` with span if the
  args are invalid.

  **`scene`/`layer`/`sprite`/`color`/`anchor` are KEYWORDS, not natives** — the parser
  parses them; they are never resolved through the environment. `sleep` does not exist in
  any form.

  ⚠️ **`animate` DOES exist** (`natives.ts:410`), with `animate_done` and `animate_reset`.
  M17 shipped: `src/choreo/tween.ts`, `easing.ts`, 25 tests, a frame golden. An earlier
  version of this skill claimed it did not exist "not even as a stub" — that was false and
  would send an agent to rebuild a shipped, golden-tested feature. The easing names are a
  closed set: `linear, ease-in, ease-out, ease-in-out, bounce, elastic`.
- `error.ts`: `QbskError` (syntax/semantic/runtime) with span; the CLI formats
  `file.qbsk:7:4 — message` + snippet with `^` marker + optional suggestion.
- **DoD**: the examples in `examples/` run correctly; `interp.test.ts` currently holds
  231 evaluation cases — a floor to hold, not a target.

## 7. CLI/REPL module

- Commands: `qbsk run <file> [args]`, `qbsk repl`, `qbsk lex`, `qbsk parse`,
  `qbsk check` (syntax/semantics only, without executing), `qbsk profile <file>`,
  `qbsk help`, `qbsk --version`.
  Flags: `--ansi`, `--loop`, `--fps N`, `--frames N`, `--no-audio`, `--help`/`-h`.
  ⚠️ `--tokens` and `--ast` are accepted but **inert** — `lex` and `parse` print
  unconditionally. They are documented in §9 of the spec as if they gated the output;
  they do not.
- REPL: input → parse → evaluate → print the value (nulls print nothing);
  history and error handling without dying.
- `use "lib.qbsk"` → loaded once, deduplicated by absolute path. **Modules are
  encapsulated (L5)**: a module runs in its own scope, only `export`ed `const`/`func`
  are public (`export var` is a parse error), and it is bound by file stem or
  `use "..." as name`. An earlier version of this skill said "shared top-level scope" —
  that was the pre-L5 model and implementing against it would undo an earlier release.

## 8. Declarative DSL (scene keywords)

When implementing them, remember they are FIRST-LEVEL keywords (parsed like `if`),
not preprocessed sugar. **Identifiers in examples are English** (RULE #7):

- `scene Game(width: W, height: H, title: T, fps: N)` — declares the canvas and the loop.
  The parameter set is **closed**: those four keys and no others; an unknown key is a
  parse error with a suggestion, and `title:`/`fps:` reach the host as `RunResult.sceneInfo`
  (§14.3).
- `layer hud z: N [at (x, y)]` + block with primitives: `fill, put, text, box, border,
  line, sprite, tone, shade, canvas`.
- **State directives** inside a layer — they set state for every primitive *below* them,
  they are not layer properties: `z: N`, `visible: bool`, `color fg: ... bg: ...`.
  The set is closed at three.
  ⚠️ **`anchor:` is NOT one of them.** A bare `anchor:` inside a layer is a **parse
  error** since L8 (§14.2): it is a property of the primitive it positions
  (`sprite "h.qba" at (0, 0) anchor: center`). It used to compose to nothing in silence.
  ⚠️ **`sprinkle` no longer exists.** It was removed from the language in L8 (§14.5) —
  not deprecated, removed: the keyword was released and `var sprinkle = 3` is legal now.
  Seeded RNG expresses it better (`rng` + `roll_int` in a `for`), and reproducibly, which
  `at random` never could. Do not reintroduce it.
- Events: `on start`, `on tick(dt)`, `on turn(n)`, `on key "name"`, `on resize(w, h)`,
  each with an optional guard: `on key "a" when expr` (L3, §6.6).
  A handler registers only while the top-level program runs; one declared later, or
  inside a module, is an error (§14.4).
- **`line` takes `style: stroke`** (§11.16), a closed set checked in the parser like
  `border`'s. Absent means unchanged: `line` keeps drawing `*`, so every existing golden
  passes. An unknown style is a PARSE error with a suggestion, never a fall-through to a
  default that would draw something looking deliberate.
- **`put` takes named arguments, and the set is closed at two**: `mask:` and `depth:`.
  They follow the positional clauses (`put MAP at (0, 0) mask: seen`), which is where
  every named argument in this language goes — `sprite ... at (..) frames:`,
  `box .. to .. style:`. Accepting one *before* `at` would create a second spelling of
  `depth:`, which is exactly the §15 defect class. An unknown key is a parse error
  naming both valid ones.
  - `mask:` (docs/engine.md §11.12) draws a **list of rows through a visibility mask**:
    a space in the mask hides that cell, any other character shows it, and a hidden cell
    is *not painted* so the layer below shows through. It replaces the
    `for y / for x / if seen[y][x] != " " / put MAP[y][x]` loop, which is the single
    heaviest shape real games run per frame. Both forms stay legal and a test pins that
    they produce identical bytes.
  - ⚠️ **`put` on a list without `mask:` is an error**, not a stringification. It used to
    draw `[ab, c` in silence; §11.12 closed that. Scalars still stringify
    (`put int(gameTime() * 10) % 60 at (14, 0)` in `examples/hud.qbsk`).
- **A canvas `put` into a layer blits** (§11.13): its cells land with their top-left at
  `at`, and a cell carrying no colour of its own takes the layer's — `-1` means "no
  opinion", and letting it win would make `color` above a blit a silent no-op (I2). It is
  **opaque**, unlike `mask:`: a canvas is an image whose extent the author chose, so its
  blanks are part of what it says.
- Coordinates: `(x, y)` native tuples; layer-relative by default; `world: (x, y)` global.
  **Canvas natives take the point as a tuple** — `put(c, text, (x, y))`,
  `plot(c, (x, y), colour)`, `braille(c, (x, y))` — never as separate coordinates.
- **Canvas blocks**: `canvas hero_sprite at (x, y):` + `"""` literal → embedded sprite
  declared as a raw text grid (no loops to print line by line). The literal lines are
  grid rows; the block evaluates to an immutable Sprite object.
- **DoD**: each keyword appears in ≥ 1 example of `examples/` (the "no features without
  demo" rule).

## 8b. Shipped language features this skill must not "add"

All of these exist, are specced and are tested. Read the spec section before touching
any of them; do not re-implement:

| Feature | Spec | Phase |
|---|---|---|
| List/dict literals, indexing, index assignment | §5.1 | L1.5 |
| String interpolation `"hi {name}"` | §2.4 | L2 |
| Lambdas `func(n) n * 2` | §6.3 | L2 |
| Indexed iteration `for i, item in list` | §6.2 | L2 |
| String/list/dict/math stdlib | §5.2, §5.3 | L3 |
| `try ... catch e` | §6.1 | L4 |
| Bitwise operators (ints only) | §6.4 | L4 |
| Seeded RNG `rng`/`roll_int`/`roll_float` | §6.5 | L4 |
| Guarded handlers `on ... when` | §6.6 | L3 |
| Module encapsulation + `export` | §9 | L5 |
| `.qbdata` — data that cannot run | §12 | C4 |
| `save_state`/`load_state`/`list_saves` | §13 | L1 |
| The ghost hunt (7 closed categories) | §14 | L8 |
| The hardening invariants | §15 | L9 |

**§14 and §15 are the governing design rules for any new construct.** §15 states three
invariants — every named argument belongs to a closed set; every evaluated value is used
or reported; no host error reaches the author — and they exist precisely because §14
fixed instances where it should have closed categories. A new primitive is checked
against them before it ships, not after a review finds it.

They are enforced at **chokepoints**, so use them instead of writing a new check:

| Invariant | Where it lives | Covers |
|---|---|---|
| I1 closed sets | `Interpreter.checkNamedArgs(construct, args, allowed)` | sprite, tone, shade, color — add a `*_PROPS` const beside the others |
| I1 (parse-time) | `BORDER_STYLE_NAMES` in parser.ts | `style:`, and any static vocabulary in a dedicated parser slot |
| I2 layer rule | `Interpreter.requireLayer(what, span)` | every drawing statement and state directive |
| I3 no host errors | `readSource()` in cli/main.ts; `MAX_CALL_DEPTH`; `repeatStr()` | file reads, recursion, allocation limits |
| duplicates | `Parser.checkDuplicateParams(params, what)` | func, lambda, every event handler |

A new primitive that takes `key: value` and does not call `checkNamedArgs` is a new ghost.
A new drawing statement that does not call `requireLayer` is a new ghost.

## 8c. Scene words are CONTEXTUAL, not reserved (§15.15)

⚠️ This section said the opposite until 2026-08-19, and a stale copy of it teaches an agent
to work around a restriction that no longer exists.

Of the 51 keywords, **26 belong to the scene DSL and every one of them can be a name.**
`var z = 3`, `func f(line)`, `layer box z: 5` and `for text in rows` are all legal. A scene
primitive is a STATEMENT and never an expression, so the only position that could be
ambiguous is the first token of a statement, and one token of lookahead settles it: a scene
word followed by `=`, `+=`, `-=`, `[` or `.` is a name.

**The 25 core keywords stay reserved** and always will: `if elif else while for in return
match when use break continue and or not var const func export as try catch true false
null`. `var return = 1` reports `'return' is a reserved keyword and cannot be a name`.

One position is still IDENTIFIER-only and it is a known gap rather than a rule: the `use`
alias. `use "x.qbsk" as line` does not parse.

## 9. Quality standards (mandatory at every milestone)

1. Tests first: case fails → implement → case passes.
2. Byte-for-byte golden files for each primitive and reference scene.
3. No error without location + source snippet.
4. **`npm run build` + `npm run typecheck` + `npm run lint` + `npm test` green** before
   declaring a milestone done. All four — recent closing-criteria blocks require them by
   name. `npm run bench` also measures for real now (docs/engine.md §13.1): it gates on
   every benchmark still RUNNING, never on absolute milliseconds.
5. If a change breaks an example in `examples/`, the PR is not accepted until fixed.

Current baseline to beat, not to match: **103 test files / 1,867 tests, all green.** If the
count drops, find out which test was deleted before anything else.

## 10. Forbidden anti-patterns

- ❌ Changing syntax without updating `docs/language.md` and the examples.
- ❌ Adding speculative keywords ("we might need it").
- ❌ Errors without span (destroys the error model that teaches).
- ❌ Silently mixing `int` and `float` in coordinates.
- ❌ Writing the interpreter before the parser has error recovery.
- ❌ Parsing dependencies: the interpreter NEVER re-tokenizes or re-parses. (It *does*
  legitimately call `parse()` for a different source file — module loading, snippets,
  program entry. That is not re-parsing already-parsed input.)
- ❌ Accepting a named argument, a flag or a style name that nothing reads (§15, I1).
- ❌ Fixing an instance where the category is what is broken (§15's own lesson).

## 11. Work protocol for each task

1. Read `docs/language.md` (the spec, ~1600 lines through §15) and the phase in
   **`the roadmap`** — that file is the operative source of
   truth for "which phase we are in" and each phase's closing criteria. the roadmap is
   historical vision; parts of it teach syntax the language rejects.
2. Confirm whether the change is syntax, semantics or toolchain → update the spec FIRST
   (RULE #2).
3. Write the failing test (unit or golden).
4. Implement. 5. build + typecheck + lint + test green. 6. Update examples if the
   language changed.
7. Report: what was done, what remains pending, and the next logical step.

**Verify, do not trust — including this file.** Every factual claim here was wrong once:
this skill has previously stated that there were 16 natives (there are 84), that `animate`
did not exist (it does), that `sprinkle` was a live ghost (it was removed), and that
modules shared the top-level scope (they have not since L5). If a claim here matters to
your task, check it against the code before relying on it, and correct this file when it
drifts.
