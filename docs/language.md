# QBSK — Language Spec (docs/language.md)

> **Status:** v0.1 — this document is the specification. Any syntax change is made here
> corrected architecture decisions. Any syntax change is made in THIS document before
> touching the code ("Spec before code" principle).

---

## 1. Design principles (manifesto)

1. **Layout-first**: spatial position is a first-class citizen (`at (x, y)`,
   `from → to`, `anchor`). No pixel math for the user.
2. **Zero boilerplate**: a flat file starting with `scene` is already a runnable
   program. No `main()`, no system imports.
3. **Everything is nameable**: scenes, layers, sprites, timelines — explicit name + z-index.
4. **Errors that teach**: every error carries `file:line:column`, highlighted fragment
   and suggestion (Levenshtein for typos). Never raw TypeScript/Node stack traces.
5. **Clarity > sugar**: a single way to do things. A new keyword only if it cannot
   be expressed with what exists.
6. **State vs View**: the DSL declares the scene (immutable data); `on tick` mutates
   state; the engine redraws. No imperative rendering inside the declarative flow.
7. **Configuration immutability**: `width/height/fps` of the scene header are
   read-only at runtime.
8. **Compositionality**: the DSL is a subset of the full language, not a dialect.

## 2. Lexicon (lexer)

### 2.1 Tokens
`IDENTIFIER, INT, FLOAT, STRING, BOOLEAN, INDENT, DEDENT, EOF` + keywords + operators
(`+ - * / % == != < > <= >= = ( ) , : . .. ! & | += -=`).

Structure:
```ts
interface Span { start: {line, col, offset}, end: {line, col, offset}, file: string }
interface Token { type: TokenType, value: string | number | boolean, span: Span }
```
**Every token carries a span. Mandatory.**

### 2.2 Indentation
- Blocks by spaces: **4 spaces** standard level. Normalize CRLF → `\n` on read.
- **Tab = friendly error** with location (never cross-platform ambiguity).
- Level stack `[0]`: greater → `INDENT` (push); lesser → `DEDENT` per pop; a level
  that doesn't match → `IndentationError` with line/col.
- Empty lines and comments don't affect structure (but they count lines/cols).
- `statement: expr` on one line → the parser expands it into a single-statement block.

### 2.3 Comments
`// line` and `/* block */`. (NO `#` — decision made, will not be reversed.)

### 2.4 Strings
- `"..."` with escapes `\n \t \\ \"`.
- **Interpolation (L2)**: `"hello {name}, you have {age} years"` evaluates each `{expr}`
  and converts it to a string with `str()` (the same rule as `print`), concatenating the
  parts. The inner expression is any language expression (`{len(l)}`,
  `{a + b}`, `{d["key"]}`), it can contain nested strings (which can in turn
  interpolate) and literal dicts as a subexpression (`{f({"a": 1})}`). As the first
  expression of an interpolation a dict clashes with the `{{` escape (see below); to
  interpolate a dict directly, store it first in a variable: `var d = {"a": 1}`
  and use `{d}`. If the variable doesn't exist, the error is a
  `QbskRuntimeError` with span, the same as outside interpolation.
- **Interpolation is eager (an earlier release).** A `{expr}` is evaluated exactly where the
  string literal is written — there is no delayed template. A string that contains
  `{tag}` stored in a list or const for later substitution fails at the *build*
  site, with the same undefined-variable error as any other eager expression. Build
  the string where its values exist, or format through a `func` that is called with
  the value in scope:
  ```qbsk
  // Wrong — {tag} is evaluated here, before tag is defined:
  const script = [["J", "on your feet, {tag}."]]

  // Right — build the string where the value exists:
  var tag = "4077"
  const line = "on your feet, {tag}."

  // Or format through a func, called where tag is in scope:
  func greet(tag)
      return "on your feet, {tag}."
  ```
- **Literal brace escape** (symmetric): `{{` produces a literal `{` and `}}` produces a
  literal `}` (neither opens nor closes interpolation). A loose `}` inside the string is
  literal; interpolation closes at the `}` that balances its opening `{`.
  Example: `"percentage: {{{pct}}}"` → `percentage: {<pct>}`.
- Interpolation does NOT apply to canvas blocks `"""..."""` (those are raw spatial
  data).
- **Canvas blocks (Skill A) — multiline literals** with `"""`:
  the inner text is raw SPATIAL DATA (grid coordinates), no internal INDENT/DEDENT
  tokens; each literal line = a row of the canvas.
  ```qbsk
  scene MyIntro:
      canvas player_sprite at (10, 5):
          """
           O
          /|\
          / \
          """
  ```

### 2.5 Numbers
`int` and `float` are DISTINCT types (the coordinate DSL depends on it).
`12`, `3.5`, `.5`, `1e3`. Automatic int→float coercion only in mixed
arithmetic operations; never in coordinates without an informative error.

### 2.6 Keywords
```
scene layer sprite box border line text fill tone color anchor at from to z style
on tick key resize start
if elif else while for in return match use
break continue
and or not var const func
```
All keywords are **globally reserved**: none may be used as an identifier — a
variable, constant, function name, `use` alias, or a layer/scene/canvas name in
the scene DSL — anywhere in a program.

**Twenty-five of the fifty-one are reserved that way. The other twenty-six are the
scene DSL's, and they are CONTEXTUAL (§15.15): outside statement position every one
of them is an ordinary name.** `var z = 3`, `func f(line)`, `layer box z: 5` and
`for text in lines` are all legal, and the primitive of the same name still reads
as the primitive where the grammar is looking for one. What stays reserved is the
core language — `if, elif, else, while, for, in, return, match, when, use, break,
continue, and, or, not, var, const, func, export, as, try, catch, true, false,
null`.

The parser names the cause instead of the symptom in the name slots: `layer if z: 5`
reports `'if' is a reserved keyword and cannot be a layer name`, not a bare
`expected the layer name`.

`sprinkle` was a reserved keyword until L8 and is now an ordinary identifier: the
feature was removed once seeded RNG made it expressible in-language (§14.5). It is
the only name this language has ever given back.

## 3. Grammar (condensed EBNF)

```
program        := (statement | declaration)* EOF
statement      := varDecl | constDecl | exprStmt | if | while | for | return
                 | scene | layer | event | use
declaration    := funcDecl
scene          := "scene" IDENT "(" sceneParams ")" block
sceneParams    := "width" ":" INT "," "height" ":" INT
                 ["," "title" ":" STRING] ["," "fps" ":" INT]   // closed set, §14.3
layer          := "layer" IDENT "z" ":" INT block
primitive      := "fill" STRING
                 | "put" expr "at" tuple ["mask" ":" expr] ["depth" ":" number]
                 //   named args follow the positional clauses, as everywhere else
                 | "box" tuple "to" tuple ["style" ":" IDENT]
                 | "border" tuple "to" tuple ["style" ":" IDENT]
                 | "line" tuple "to" tuple | "text" STRING "at" tuple
                 | "sprite" STRING "at" tuple ["frames" ":" INT "fps" ":" INT "loop" ":" BOOL]
                 | "tone" number ["wave" ":" IDENT] ["duration" ":" number]
                 |   ["volume" ":" number] ["loop" ":" BOOL]
                 | "canvas" IDENT "at" tuple ":" multiLiteral
anchor         := "anchor" ":" ("top-left" | "top-center" | "top-right"
                 | "middle-left" | "center" | "middle-right"
                 | "bottom-left" | "bottom-center" | "bottom-right"
                 | tuple)                                      // 9 names, §7.3/§15.9
                                                               // primitive suffix only, §14.2
event          := "on" ("start" | "tick" "(" IDENT ":" "seconds" ")"
                 | "key" STRING | "resize" "(" IDENT "," IDENT ")")
                 ["when" expr] (":" stmt | block)                   // §6.6
tuple          := "(" expr "," expr ")"
lambda         := "func" "(" [IDENT ("," IDENT)*] ")" expr        // §6.3
for            := "for" IDENT ["," IDENT] "in" expr block          // §6.2
use            := "use" STRING
```

## 4. Operator precedence (Pratt, lowest to highest)

| Level | Operators |
|---|---|
| 1 | `..` (range, only valid as a `for` iterable) |
| 2 | `or` |
| 3 | `and` |
| 4 | `== != < > <= >=` |
| 5 | `\|` (bitwise or) |
| 6 | `^` (bitwise xor) |
| 7 | `&` (bitwise and) |
| 8 | `<< >>` (shifts) |
| 9 | `+ -` |
| 10 | `* / %` |
| 11 | unary `- not` |
| 12 | calls/indexes/members `() [] .` |

Bitwise sits between comparisons and arithmetic (Python's ordering, not C's). With
comparisons LOOSER than `&`, `x & 3 == 1` parses as `(x & 3) == 1` — what the person
meant. C makes `&` looser than `==`, which parses the same source as `x & (3 == 1)` and
has cost decades of bugs; that trap is exactly what this ordering avoids.

## 5. Types and values (runtime)

```ts
type QValue =
  | { type: 'null' } | { type: 'bool'; value: boolean }
  | { type: 'int'; value: number }      // ALWAYS an integer
  | { type: 'float'; value: number }    // ALWAYS with a decimal part
  | { type: 'str'; value: string }
  | { type: 'list'; items: QValue[] }
  | { type: 'dict'; map: Map<string, QValue> }
  | { type: 'tuple'; x: QValue; y: QValue }   // coordenadas de primera clase
  | { type: 'func'; name; params; body; closure }
  | { type: 'native'; fn: (args: QValue[], env) => QValue }
  | { type: 'sprite'; name; at; art }        // embedded canvas block (spec §7)
  | { type: 'canvas'; canvas: Canvas }       // engine canvas (native canvas(w, h))
  | { type: 'layer' | 'scene' | 'event' | 'primitive'; ... }  // DSL inerte
```

- **Canvas natives** (an earlier release): `canvas(w, h)` creates a canvas; `fill(c, ch)`,
  `box(c, from, to, ch)`, `put(c, text, at)`, `line(c, from, to, ch)` draw;
  `print(c)` emits the canvas as plain text (full-width lines, no ANSI).
  Coordinates are strict-int tuples `(x, y)`; `print(type(c))` → `canvas`.
- **Host data native**: `host(key: string)` — READS a value the host published under
  `key`, and returns it, or `null` when the host has nothing to say. Absent is `null`
  rather than an error on purpose: a scene must be able to draw before the host has
  published anything, the same way it composes once before the first tick. The host side
  is defined in `docs/studio.md` §14.6.
  ⚠️ This entry used to describe `host(key)` as *injecting* a keystroke into the program's
  input queue and returning a `bool` — semantics no registered native ever had (§15.9). A
  documented signature that matches no implementation is the same defect as an
  undocumented one, read from the other end.
- **Callable keywords**: the DSL keywords `canvas`, `fill`, `put`, `box`, `line`
  can be used as native functions in expression position when followed
  by `(` (e.g. `canvas(24, 9)`, `fill(c, "#")`). The declarative (statement) form stays
  intact; `line (0, 0) to (10, 10)` is DSL, `line(c, (0, 0), (10, 10), "-")` is a call.

- **Vector tuples**: `(10, 5) + (1, 0)` → `(11, 5)`; `*` by scalar; immutable.
- **STRICT and informative coercion**: `str + int` → error formatted with line/col,
  received types and a suggestion of explicit conversion (`str(val)`). JavaScript-style
  magic is forbidden.
- `int` and `float` are ALWAYS distinguished; comparing an int tuple with a float one
  with `==` is valid (compares numeric values), but the result of mixed
  arithmetic is `float`. The complete rule is §5.0.

### 5.0 int and float: the whole story (L12)

RULE #4 says the two are always distinguished, and they are — but "always distinguished"
was the only thing written down, and it is not the same as "you know what you will get".
This section states the rest, because every gap below was found by running the language
rather than by reading it, which means an author would have found it the same way.

**Arithmetic preserves int, except division.**

```qbsk
type(2 + 3)      // int
type(2 * 3)      // int
type(5 % 2)      // int
type(2 + 3.0)    // float — one float makes the result float
type(4 / 2)      // float — ALWAYS, even when it divides evenly
4 / 2            // 2.0, not 2
```

`/` is the one operator that never returns an int. That is deliberate: a division whose
type depends on whether the numbers happen to divide evenly would make `a / b` a
different type on different inputs, and the coordinate DSL — which demands ints — would
accept a program on Tuesday and reject it on Wednesday. One rule, one type. For an
integer result, convert explicitly: `int(7 / 2)` → `3`.

**`int()` truncates toward zero, it does not round.**

```qbsk
int(3.9)     // 3
int(-3.9)    // -3       (not -4)
round(3.9)   // 4        — this is the one that rounds
```

**Where an int is REQUIRED, a float is refused rather than truncated.** This is the
strictness the DSL depends on, and it is worth stating as a promise rather than leaving
it to be discovered:

```qbsk
canvas(4.0, 2)          // runtime: 'canvas' expects an int, got 'float'
put "x" at (1.5, 0)     // runtime: the position must be a tuple (x, y) with ints
```

A grid address has no meaning between cells. Silently truncating would put the glyph
somewhere the author did not write, which is the §14 failure shape in numeric clothing.

**Two documented exceptions**, both of which surprised the review that found them:

1. **`for` over a float range rounds inward, silently.** `for i in 0.5..3.5` iterates
   `1, 2` — the start is rounded up, the end down, and the loop variable is always an
   `int`. It is inward on purpose (every value the loop yields is inside the range the
   author wrote), but it is the one place a float is quietly accepted where an int is
   meant. Write integer bounds and the question never arises.

2. **Integers beyond 2^53 lose precision without a diagnostic.** `9007199254740993`
   prints `9007199254740992`. QBSK ints are IEEE-754 doubles, so the language inherits
   the host's exact-integer ceiling. There is no bigint type and none is planned: a
   grid engine's coordinates, turn counters and seeds all live far below that line. It is
   documented rather than fixed because a limit you know about is a constraint, and a
   limit you do not is a bug.

**Float equality is float equality.** `0.1 + 0.2 == 0.3` is `false`, exactly as in every
IEEE-754 language. `2 == 2.0` is `true` — comparison is by numeric value, so the int/float
distinction never makes two equal numbers compare unequal.

### 5.1 List and dict literals (L1.5)

- **List**: `[e1, e2, ...]` evaluates to `{type: "list"}`; `[]` is the empty list. The
  elements are full expressions and can nest: `[1, [2, 3], "a"]`. Inside
  `[ ]` indentation has no block meaning: a literal can span
  multiple lines (implicit continuation), with a trailing comma after each element and
  an optional final comma.
- **Dict**: `{"key": value, ...}` evaluates to `{type: "dict"}` (key-to-value Map);
  `{}` is the empty dict. Keys are written as a string (`"key"`) or as an
  identifier (`key`, normalized to a string). Values are full expressions
  and can be lists or other dicts. Like lists, they allow
  multiline continuation inside `{ }`.
- **Indexing** (precedence level 8, alongside calls and members `() .`):
  - `list[int]` — positional access; out-of-range index → runtime error with
    span (never a raw JS crash).
  - `dict["key"]` — key access; missing key → runtime error with span.
  - The index can be any expression: `list[len(list) - 1]`.
- **Index assignment (an earlier release):** `list[i] = v`, `dict["k"] = v`, and their `+=`/`-=`
  forms are valid assignment targets, alongside `list`/`dict` (a plain identifier) and
  `Member` (module access, still always an error — modules are immutable). This sits
  next to an earlier release's native-based mutation (`push`/`pop`/`keys`/etc.), not instead of it —
  both are legitimate ways to mutate a list/dict; index assignment fills the specific
  gap natives never covered: replacing one element of an existing list, and adding or
  overwriting one key of an existing dict, without rebuilding the whole value.
  - **List**: the index must be an `int` and **in-bounds** — same bounds check as
    reading (`list[0]`), same error (`index N out of range for a list of M elements`,
    span-carrying). Assignment never auto-extends a list; `push` is still how a list
    grows. `+=`/`-=` read the current element, combine, then write back — a
    still-out-of-range index errors the same way a read would.
  - **Dict**: the key must be a `str`. Unlike reading (`dict["k"]` errors on a missing
    key), **plain `=` on a missing key inserts it** — this is the only way to add a
    field to an existing dict without reconstructing the whole literal, so it has to
    create, not just overwrite. `+=`/`-=` still require the key to already exist (they
    read the current value first) and give the same `key 'K' does not exist in the
    dict` error a read would, since there is no current value to combine with.
  - Assigning into anything that is not a `list` or `dict` (an `int`, a `str`, …) is a
    type error with a span, matching every other operation in this language — never a
    raw JS crash.

### 5.2 Stdlib — String and Math natives (L3a)

All receive typed arguments and throw a `QbskRuntimeError` with span if the type does not
match (explicit coercion, never a raw JS throw).

**String** (all take `str` and return as indicated; they never mutate the input):

| QBSK signature | Returns | Semantics |
|---|---|---|
| `upper(s)` | `str` | uppercase copy |
| `lower(s)` | `str` | lowercase copy |
| `trim(s)` | `str` | no leading/trailing spaces or whitespace |
| `split(s, sep)` | `list[str]` | parts of `s` separated by `sep` (non-empty); `split("a,b", ",")` → `["a", "b"]` |
| `join(l, sep)` | `str` | concatenates the strings of `l` (a list of `str`) with `sep` in between |
| `replace(s, from, to)` | `str` | replaces ALL occurrences of `from` in `s` with `to` |
| `contains(s, sub)` | `bool` | `s` contains `sub` |
| `starts_with(s, pref)` | `bool` | `s` starts with `pref` |
| `ends_with(s, suf)` | `bool` | `s` ends with `suf` |

**Math**:

| QBSK signature | Returns | Semantics |
|---|---|---|
| `abs(n)` | `int`/`float` | absolute value, preserving the type of `n` |
| `min(a, b)` | `int`/`float` | the smaller of two numbers (float if either is) |
| `max(a, b)` | `int`/`float` | the larger of two numbers (float if either is) |
| `round(n)` | `int` | rounding to the nearest integer (`.5` rounds up) |
| `format(n, places)` | `str` | a number with a fixed number of decimals, ROUNDED — `format(0.0006, 3)` is `"0.001"`. 0 to 12 places; anything else reports (§15.19) |
| `floor(n)` | `int` | rounds down |
| `ceil(n)` | `int` | rounds up |
| `sqrt(n)` | `float` | square root; negative `n` → runtime error with span |
| `sin(a)` | `float` | sine of `a` in **radians** |
| `cos(a)` | `float` | cosine of `a` in **radians** |
| `tan(a)` | `float` | tangent of `a` in **radians** |
| `atan2(y, x)` | `float` | the angle of the vector `(x, y)`, in radians, `-π..π` — argument order is `y` first, as in every language that has it |
| `pi()` | `float` | π. A native rather than a constant, so it cannot be shadowed by accident and needs no keyword |
| `random()` | `float` | `Math.random()` in `[0, 1)` — **non-deterministic**; goldens and
  examples with expected output MUST NOT call it (L3a decision). For seeded, deterministic
  randomness use `rng(seed)`/`roll_float`/`roll_int` (§6.5, L4 — the variant this note
  promised). |

The trigonometric family works in **radians**, never degrees: a single unit means the
output of one call can feed the next without a conversion nobody remembers. They were
registered natives documented in no specification at all until §15.9 — RULE #2 in
reverse, code without spec, which is the same defect as a spec without code.

Typing rules: `min`/`max`/`abs` with a non-number → error; `min(1, "a")` → type
error. `split` with an empty `sep` → error. `join` over a list containing non-strings →
type error.

### 5.3 Stdlib — List and Dict natives (L3b)

Lists and dicts are by **reference**: the mutation natives (`push`, `sort`,
`reverse`) modify the list in place and return it (for chaining or reassigning).
`map`/`filter`/`slice` return NEW lists without touching the input.

**List** (first argument `list`; type error if not):

| QBSK signature | Returns | Semantics |
|---|---|---|
| `push(l, v)` | `list` | adds `v` at the end (mutates `l`) |
| `pop(l)` | the value | removes and returns the last element; empty list → error |
| `sort(l)` | `list` | sorts ascending (mutates `l`); list of numbers or of strings — mixed → error |
| `reverse(l)` | `list` | reverses the order (mutates `l`) |
| `map(l, fn)` | `list` | new list with `fn(el)` applied to each element |
| `filter(l, fn)` | `list` | elements where `fn(el)` is truthy |
| `reduce(l, fn, init)` | the value | accumulates left to right: `fn(acc, el)` |
| `slice(l, from, to?)` | `list` | sublist `[from, to)`; `to` optional (up to the end); out-of-range bounds are clamped |

`map`/`filter`/`reduce` take a **QBSK function** (or a native) as an argument —
first-class functions: `map(l, len)`, a named function defined with `func`, or an
anonymous lambda (L2, §6.3): `map(l, func(n) n * 2)`.

**Dict** (first argument `dict`; type error if not):

| QBSK signature | Returns | Semantics |
|---|---|---|
| `len(d)` | `int` | the number of entries in `d` (empty dict → `0`) |
| `keys(d)` | `list[str]` | the keys of `d` |
| `values(d)` | `list` | the values of `d` |
| `has(d, k)` | `bool` | whether the string key `k` exists (non-string key → error) |

## 6. Semantics

- **Scopes**: chained lexical environments (Map per scope); `var/const` block-scoped;
  redefinition in the same scope = error. Closures capture the definition environment.
- **Control**: `if/elif/else`, `match`, `for i in 0..10` (exclusive range),
  `for item in list`, `for i, item in list` (index + element, §6.2), `while`,
  `break`, `continue`, `return`.
- **Functions**: `func name(a: int, b): int` — the annotations are optional
  documentation; dynamic runtime.
- **Lambdas** (L2, §6.3): `func(n) n * 2` — an anonymous, single-expression
  function in expression position.
- **Calls are positional**: `f(a, b)` binds arguments by order. Named arguments
  (`f(a, x: 1)`) are a **parse-time** construct only — the interpreter rejects them
  because no callee (function or native) accepts them yet. Only the scene DSL
  (`docs/engine.md`) accepts named arguments. Supporting named arguments for natives
  is a real gap, deliberately deferred; see `docs/engine.md` §13.2.
- **Call argument lists span multiple lines (an earlier release):** `f(\n    a,\n    b,\n)` parses
  the same as `f(a, b)` — the same implicit continuation §5.1 gives `[ ]`/`{ }` literals
  now applies to a call's `( )` too, trailing comma included. Before an earlier release this was a
  real asymmetry (found writing `examples/lib/action_rules.qbsk`'s tests, an earlier release): list
  and dict literals tolerated multi-line layout, calls silently didn't. A **function
  declaration's** parameter list (`func f(\n    a,\n    b,\n)`) is a separate grammar
  path and was not part of this fix — no caller has hit that one yet.
- **Operators**: short-circuit `and/or`, concatenation `+`, repetition `*` (str/list,
  §6.7).

### 6.1 Error handling: `try ... catch e` (L4)

```qbsk
try:
    var n = int("abc")
catch e:
    print("failed: " + e["message"])
```

- `try:` runs its block; if it throws a `QbskRuntimeError`, control jumps to `catch e:` and the
  variable `e` is available **only inside** the catch block (block scope).
- `e` is a dict with the error and its original span:

  | key | type | value |
  |---|---:|---|
  | `message` | `str` | the error message |
  | `file` | `str` | the file where the error originated |
  | `line` | `int` | 1-based line of the origin span |
  | `col` | `int` | column of the origin span |

- If the `try` block completes without error, the `catch` block is skipped.
- `catch` is mandatory and always has a variable (`catch e:`); `catch:` without a variable
  is a parse error.
- **Only runtime errors are caught**. Control signals are not errors and propagate
  without being caught: `break`, `continue`, `return` and `exit()` inside `try`.
  Syntax errors are not caught either (they do not exist at runtime).
- An error thrown inside the `catch` block is not re-caught by the same `try`; nesting
  another `try` is required for that.
- **Uncaught** errors remain fatal and abort the program as always.

### 6.2 Indexed iteration: `for i, item in list` (L2)

```qbsk
for i, row in MAP
    for x, ch in row
        if ch == "#"
            put "#" at (x, i)
```

Two names before `in` bind the **index** (an `int`, starting at 0) and the **element**.
One name is the existing element-only loop, unchanged.

This exists because the manual pattern was EVERYWHERE — `examples/turns.qbsk` alone had
six `while i < len(xs)` / `i += 1` loops whose only purpose was carrying an index. A
loop whose body needs the position should not have to maintain the position by hand:
the counter is exactly the kind of bookkeeping a loop construct is for.

- Grammar: `for IDENT ["," IDENT] in expr block`. The comma form applies to **list**
  iteration only; using it with a range (`for i, x in 0..10`) is a parse error — a
  range's element IS its index, so the second name could only ever duplicate the first.
- Both names live in the per-iteration scope, exactly like the single-name form.
- The index counts iterations of the CURRENT loop; nesting keeps each loop's index its
  own, and `continue`/`break` behave as in the single-name form.
- On a string: not supported — iterate `split(s, "")` explicitly, as before. One
  iterable type per construct (clarity over sugar).

### 6.3 Lambdas: `func(params) expr` (L2)

```qbsk
var doubled = map(l, func(n) n * 2)
var alive   = filter(entities, func(e) e["hp"] > 0)
sort(xs, func(a, b) a["speed"] - b["speed"])
```

`func` in **expression position** with no name is a lambda: parameters in parentheses,
then ONE expression, whose value is the return value. It evaluates to an ordinary
function value — closures, arity checking and call errors are identical to a named
`func`'s, because it IS one (same runtime type, name `<lambda>` in errors).

Why now: `map`/`filter`/`reduce` have taken function arguments since L3b, but every
one-line helper had to be declared, named and moved to the top level first. The
friction was measured in real programs (turns.qbsk, worldgen) — a language that has
higher-order natives but no anonymous functions has half a feature.

Deliberate limits (clarity over sugar):

- **Single expression only.** No block bodies: a lambda that needs statements is a
  named `func` wanting to exist. `func(n): block` stays a parse error with that
  suggestion.
- **No type annotations** on lambda parameters — they are documentation, and a
  one-expression function documents itself.
- The body parses at assignment precedence: `func(n) n * 2 + 1` is `(n * 2) + 1`;
  a lambda inside a call's argument list ends where the argument would
  (`map(l, func(n) n * 2)` — the `)` closes the call, not the lambda).
- A lambda is an expression, so it can be stored, passed and returned:
  `var f = func(n) n + 1` is legal — and if that line grows a second one, the
  next reader should rename it into a `func`.

### 6.4 Bitwise operators (L4)

```qbsk
var flags = READ | WRITE          // or
var masked = value & 255          // and
var toggled = state ^ BLINK       // xor
var shifted = 1 << 4              // 16
var halved = n >> 1               // floor division by 2 for non-negatives
```

`| ^ & << >>` operate on **ints only** — both sides. A float on either side is a
runtime error with a span and the fix in the message (`use int(x) first`), because
"what are the bits of 2.5" has no answer a language should invent. `bool`s do not
coerce either: `true & 1` is an error, not `1`.

Semantics are **32-bit two's complement**, the JS engine's native path
(`(a & b) | 0`): results live in `[-2^31, 2^31)`. Shift counts are masked to
`0..31` (JS `<<`/`>>` semantics). `>>` is ARITHMETIC (sign-propagating); an unsigned
shift can be composed when needed (`(n >> k) & mask`), which is rarer than the signed
one in game code and not worth a fourth operator. This range is exactly what mulberry32
needs, and what every tile-flag, RNG and hash in the roguelike literature assumes.

There is no unary `~`: `x ^ -1`? No — **`-1 - x`**? Both work, but the honest answer
is `~` was left out until a real program writes `^ -1` twice. (Clarity over sugar: an
operator is added when its absence is a measured wart, not preemptively.)

### 6.5 Seeded randomness: `rng(seed)` (L4)

```qbsk
var roll = rng(seed)              // one generator, stated seed
var d20 = roll_int(roll, 1, 21)   // int in [1, 21)
var noise = roll_float(roll)      // float in [0, 1)
```

| native | signature | returns |
|---|---|---|
| `rng` | `rng(seed: int)` | an opaque generator value |
| `roll_float` | `roll_float(r)` | next `float` in `[0, 1)`, advancing `r` |
| `roll_int` | `roll_int(r, lo, hi)` | next `int` in `[lo, hi)`, advancing `r`; `lo >= hi` is an error |

The generator is **mulberry32 — the exact one the host already uses** for audio noise
and particles (`src/util/random.ts`): one PRNG in the whole project, one set of golden
expectations, zero drift. The same seed yields the same sequence on every platform,
which is what makes worldgen writable IN QBSK and testable byte-for-byte — the gap
an earlier release had to route around with host-side generator scripts (worldgen_test.qbsk's
header names it).

- The generator is a mutable value by design — like a list, it advances when rolled.
  Two `rng(7)`s are two independent generators at the same start; passing one around
  shares its stream.
- `random()` (§5.2) stays the only NON-deterministic source, untouched. `rng` is not
  a variant of it; it is the deterministic tool the spec promised in the L3a decision
  ("a separate seeded variant is added, without touching this one").
- With `&`/`^`/`>>` now in the language (§6.4), mulberry32 is also WRITABLE in pure
  QBSK — that is the acceptance test: a QBSK implementation whose output equals
  `rng(seed)`'s for the same seed. The native still exists because a game rolling
  thousands of times per turn should not pay tree-walker price for its RNG core.

### 6.6 Guarded handlers: `on ... when expr` (L3)

```qbsk
on key "enter" when screen == "menu"
    startGame()

on key "enter" when screen == "world"
    screen = "menu"

on tick(dt) when screen == "generating"
    stepGeneration()
```

`when expr` after any event header gates the handler: it runs only when the guard is
truthy at dispatch time. A handler with no `when` is unchanged — it always runs.

**Why this and not a screen/scene-stack construct.** The measured pain
(`examples/main_menu.qbsk`, four screens) was never the layers — a layer already has
its gate, `visible: screen == "jail"`, and it reads well. The pain was every handler
being a dispatch table: `on key "enter"` holding a four-branch `if screen == ...`, and
`on tick` holding the union of every screen's per-frame logic. A guard is the SAME
shape the layers already use, applied to the other half of the language. A stacked
scene manager would have been a speculative construct with exactly one consumer;
"can this not be expressed with what already exists?" said no keyword — `when` is a
gate, not a machine.

**Semantics — the one subtle rule.** All guards for an event delivery are evaluated
FIRST, then the eligible handlers run:

```qbsk
on key "enter" when screen == "menu"
    screen = "world"          // this runs...
on key "enter" when screen == "world"
    screen = "menu"           // ...and this does NOT run for the same press
```

Without that rule, the first handler's assignment re-routes the SAME keypress into the
second handler, and a menu that toggles two states becomes a menu that does nothing,
undebuggably. Guards see the state as it was WHEN THE EVENT FIRED; changing state in a
handler affects the next event, never the current one. (`on tick`, `on turn`,
`on resize` and `on start` follow the same rule per delivery.)

- The guard is an ordinary expression evaluated in the live top-level environment —
  anything visible there is usable (`when pack`, `when hp <= 0 and lives > 0`).
- A guard that throws is a runtime error with the guard's span, like any expression.
- Handlers for the same event keep their declaration order among those eligible.
- `hasKeyHandler` (docs/studio.md §16.2) keeps reporting the BINDING — a guarded-off
  handler is still bound; whether it ran is visible in the trace, which is that tool's
  job.

### 6.7 Sequence repetition, and one naming exception (L13)

`*` repeats a sequence by an int, in either operand order:

```qbsk
"ab" * 3        // "ababab"
3 * "ab"        // "ababab"
[1, 2] * 3      // [1, 2, 1, 2, 1, 2]
3 * [1, 2]      // [1, 2, 1, 2, 1, 2]
[1, 2] * 0      // []
```

The list case was **already promised by §6** and simply never implemented — the
interpreter answered `cannot multiply 'list' by 'int'`. That makes it an unkept promise
rather than a design asymmetry, which is a different kind of defect and a worse one: a
reader who trusts the spec writes code that does not run.

The rules are the sequence's, not the type's: a negative count is an error, a float count
is an error, and a repetition that would build something enormous reports instead of
exhausting memory (§15.4). The resulting list is a new list — mutating it does not touch
the original.

**`gameTime()` is the one native in camelCase**, among 85. It is deliberate and it stays:
the name comes from the engine's frame clock (`docs/engine.md` §7), not from the stdlib,
and it reads as one word for the same reason `SIGWINCH` does. Renaming it to `game_time`
would be a breaking change across 141 call sites for a purely cosmetic gain, and adding
`game_time` *alongside* it would give one concept two names — which §14.5 rejected when it
removed `sprinkle` rather than aliasing it, on the principle that there is a single way to
do things (§1). Documented as an exception is better than pretending it is a rule.

Two things that look like asymmetries and are not:

- **A bare `}` inside a string is literal** while `{` opens an interpolation. That is
  §2.4's stated rule, not an oversight: interpolation closes at the `}` balancing its
  `{`, so a loose one is unambiguous. `{{` and `}}` remain symmetric escapes.
- **`4 / 2` returning `2.0`** — §5.0, and deliberate.

## 7. Declarative canvas DSL

### 7.1 Side-effect-free evaluation
`scene`/`layer` do NOT execute side effects when evaluated: they build a tree of
immutable objects (`{type: "scene"}`, `{type: "layer"}`, primitives) that the engine
mounts before the loop. Zero mixing of imperative rendering in the declarative flow.

- `scene` validates `width` and `height` as `int` ≥ 1 and **defines its name** as
  a `const` in scope (printable, passable as a value).
- `layer` validates `z` as `int`; if there is no previous `scene` → runtime error.
- `layer`s are sibling statements of `scene` and are grouped into the active scene.
- The scene's text (plain-text rendering, no ANSI) is emitted at the end of
  execution: a flat file starting with `scene` already prints its composition
  (ascending z; the highest-z layer wins in each cell; `visible: false` is omitted).
- Supported `box`/`border` styles: `single`, `double`, `rounded`
  (default `single`).
- Current primitive support in composition: `fill`, `text`/`put`, `box`/`border`,
  `line` (default character `*`), embedded sprites (`blit`), and `tone` (audio only,
  paints no cells — see §7.9). `color` is a state directive (§7.5) and paints no cells
  of its own. A bare `anchor:` inside a layer is not a directive at all — it is a parse
  error, because a primitive property placed loosely used to compose to nothing in
  silence (§14.2).

### 7.1b Per-primitive z and visibility (M15)

- Inside a layer, two state directives (like `color`, per-state style)
  control the composition order and hiding of the following primitives:
  - `z: N` — z of the following primitives (default `0`; `N` must be `int`).
  - `visible: true|false` — hides (`false`) or shows (`true`) the following ones
    (default `true`).
- Composition inside the layer: bottom→top by ascending `z`; tie = declaration
  order (stable order). The layer with the highest `z` still wins between layers.
- Primitives with `visible: false` write no cells (neither in composition nor in diff).
- **Placement is everything — these are state directives, not layer-level guards
  (an earlier release).** Each one changes the state for **every primitive that follows it
  in the same layer**, from that point on, until the layer ends or another
  directive of the same kind overwrites it. Per-primitive in the sense that each
  primitive is composed with the state in force where it is declared — never a
  property of the layer as a whole. The gotcha is placement, not scope:
  - A directive never affects primitives written *above* it.
  - One written at the **end** of the layer, or overwritten by a later directive
    of the same kind before any primitive, reaches nothing — it is silently dead
    (`qbsk check` reports it; `qbsk run` stays unchanged).
  - To gate, style or reorder a group, write ONE directive before the group — it
    applies to every primitive below it. Rewriting the directive changes the
    condition for what follows. (`color` is the same state directive model, §7.5.)
  - Repeating the same directive before every primitive is always safe and is how
    genuinely per-primitive conditions are written (see §7.8).
- **Dynamic z at runtime**: `z:` and `visible:` accept expressions, re-evaluated
  each frame of the loop with `gameTime()` available — a sprite can "cross" layers
  or appear/disappear according to the game clock; the reordering is reflected the next
  frame (mounting is per-frame, see §7.6):
  ```qbsk
  layer meteor z: 2
      z: int(gameTime() * 2) % 2      // toggles: above the ball ↔ below the ball
      sprite "res/ball.qba" at (10, 4)
      visible: gameTime() < 3.0        // disappears at 3 seconds
      text "!" at (11, 4)
  ```
- `visible` has been a keyword since M15; `z` already was (layer z). The directives don't
  consume a cell: they only set state for the following primitives of the same layer.

### 7.2 Events
`on start` (once), `on tick(dt)` (dt in seconds, fixed engine timestep),
`on key "name"` (canonical names: `arrow-left/right/up/down`, `space`, `a`...),
`on resize(w, h)`. They are registered as listeners of the engine loop. The
dispatch model — what runs once vs per frame, error semantics, determinism —
is defined in §7.7.

### 7.2b Parentheses group, commas make tuples

`(a + b) * 4` groups. `(x, y)` is a tuple. **The comma is what makes a tuple**, which is
how every language that has both resolves the ambiguity.

Worth stating because it was not always true: `(` used to start a tuple unconditionally,
so parentheses could not override precedence anywhere in the language and `(a + b) * 4`
was a syntax error. No example had ever needed to group arithmetic, so nothing caught it
until the first real game logic was written — which hit it in its first ten lines.

### 7.2c Tuples read by index

`t[0]` is x and `t[1]` is y. A tuple still passes WHOLE into a coordinate slot, so both
of these work and mean different things:

```qbsk
var step = route[1]
put "g" at step              // the tuple, straight into `at`
if step[0] == playerX        // ... and its components, read out
```

Added by pathfinding (docs/engine.md §13): `path` answers with coordinates and there was
no way to read one. Returning lists instead would have worked, and indexing is strictly
better — a list would have lost the `at step` form.

### 7.3 Coordinates and anchors
- By default relative to the layer; the `world: (x, y)` suffix on `put`/`text`/`sprite`
  sets **global** canvas coordinates (ignores the layer offset, M16). Both forms live
  inside a layer — `world:` is a coordinate space, not a licence to draw outside one
  (§15.2):
  ```qbsk
  layer hud z: 9 at (0, 8)
      put "points: 3" at (1, 0)         // local → (1, 8) on the canvas
      put "TITLE" world: (10, 2)        // global: (10, 2) no matter what
  ```
- The layer can be offset with `layer name z: N at (x, y)` (integer offset,
  default `(0, 0)`): all its local primitives are composed at `at + local`.
- Anchors (9 points + fractional) = translation pivot (and future scale):
  `anchor: top-left | top-center | top-right | middle-left | center | middle-right |
  bottom-left | bottom-center | bottom-right | (fx, fy)`.
- The sprite is positioned by its anchor: `at (x, y) anchor: center` centers the sprite at
  (x, y); `(fx, fy)` is a fractional 0..1 offset over the art size.
- No manual offset math for the user.
- The world↔local conversion lives in `src/choreo/coord.ts` (engine); the DSL only
  declares `at`/`world:` and the engine resolves it (spec engine.md §10).

### 7.4 Sprites from file (.qba)
`sprite "res/hero.qba" at (x, y)` loads a sprite from a file in `.qba` format
(plain text; see `docs/engine.md` §12).

- The path is resolved against the script directory (same `baseDir` as `use`).
- Missing, empty, or invalid-art file → runtime error with span and file name:
  `cannot load sprite 'res/x.qba': file not found`.
- `scale: (fx, fy)` with ints ≥ 1 scales the sprite by character repetition
  (each character repeats fx times horizontally and fy times vertically).
- The loaded sprite evaluates to an immutable `{type: "sprite"}` value (like embedded
  `canvas` blocks) and is composed as a `blit` in its layer.
- Multi-frame (`---` in `.qba`) is parsed since M9 (frames available on the value),
  but animated frame-swapping is M18.

### 7.5 Layer color (style)
`color fg: cyan` (and/or `bg:`) inside a layer sets the foreground/background color of
the following primitives of that layer (per-state style; resets in each layer).

- Names: the 16 ANSI colors (`black`, `red`, `green`, `yellow`, `blue`, `magenta`,
  `cyan`, `white`) and their `bright-*` variants (e.g. `bright-yellow`).
- **Or a truecolor literal, `"#rrggbb"`** — six hexadecimal digits, case-insensitive:
  `color fg: "#ff7f00"`. See §15.16 for why this arrived late and why it was one line.
- `fg`/`bg` must be a color name or a `#rrggbb` literal; otherwise → runtime error with
  span. The message lists the names and the literal form, because an author who wrote
  `#ff7f0` needs told which of the two he missed.
- Like `z:`/`visible:` (§7.1b), `color` is a state directive for the primitives
  that follow it in the layer: it persists until the layer ends or another `color`
  overwrites the keys it sets (`color fg: green` after `color fg: red bg: blue`
  replaces the foreground but keeps the background). A `color` written at the end
  of the layer, or whose every key is overwritten before any primitive, reaches
  nothing — `qbsk check` reports it (an earlier release).
- Styles only affect ANSI emission (`qbsk run --ansi`); plain text ignores them
  (goldens intact).
- `qbsk run --ansi <file.qbsk>` renders the scene composed by the engine pipeline
  (double buffer → diffing → ANSI emitter) with real colors; without the flag, the
  output is plain text (current behavior).

### 7.6 Game clock and frame loop (M14)

- `gameTime()` — a native that returns game time in seconds (`float`), that is,
  the loop clock (fixed timestep), NEVER real time. Outside the loop it is `0.0`.
  (The name is not `tick()` because `tick` is the keyword of the `on tick(dt)` events.)
- Position expressions (e.g. a sprite's `at`) can derive from time:
  `sprite "res/ball.qba" at (int(gameTime() * 10) % 26 + 1, 4)` bounces with the clock.
- Loop CLI:
  - `qbsk run --ansi --loop <file.qbsk>` — mounts the scene per frame on the double
    buffer (diffing → ANSI emitter), without flicker; `--fps N` (default 20) and `--frames N`
    (default 120) bound the loop; when done it restores the terminal and shows metrics.
  - `qbsk profile <file.qbsk> --frames 300` — runs the loop without emitting ANSI and
    reports: mean/p99 fps, cells emitted/frame, bytes/frame and ms per phase
    (script/composition/diff/emission). Results are versioned in `bench/`.
- Animated sprite frame-swapping (multi-frame `.qba`) is left for M18; M14 only
  moves/derives state with `gameTime()`.

### 7.7 Persistent interpreter and event dispatch (an earlier release)

**The interpreter is created ONCE per program.** The top-level code runs ONCE at
startup; per frame only the event handlers run and the scene block re-composes from
the live environment. There is no second class of "magic" persistent variables:
`var x = 0` at the top level behaves as in any other language — it is initialized once,
never reset per frame.

**What runs once (startup):**
- Every top-level statement and declaration: `var`/`const`/`func`, `use`, and any
  top-level side effects (a `print` at the top level runs once, not per frame).
- The `scene` declaration is evaluated once (defining the scene name as a `const`),
  but its layers and primitives are **re-composed every frame** (below).

**What runs per frame (loop mode):**
1. `on start` handlers run once, before the first tick.
2. `on tick(dt)` handlers run, with `dt` bound to the fixed engine timestep (a
   `float`, e.g. `1/60`); the clock has already advanced, so `gameTime()` inside a
   tick is the current game time.
3. Queued `on key "name"` handlers run in FIFO order. Keys arrive through an explicit
   queue fed by the host (`pressKey`): the Studio binding is an earlier release and the terminal
   raw-mode binding is an earlier release. Both are built and call `pressKey` for real; this section
   states the contract a host must satisfy.
4. Queued `on resize(w, h)` handlers run.
5. The scene re-composes: the `scene` block and any top-level `layer` statements are
   re-evaluated from the live environment, so `at`, `z:`, `visible:` and `text`
   expressions observe variables mutated by the handlers. Mounting and composition are
   per-frame as in §7.6.

Event handlers may appear at the top level or inside `scene`/`layer` blocks. Each
dispatch runs in a fresh child scope: handler locals never leak between frames, while
assignments to outer variables persist (the assignment walks the lexical chain, so
`x += 1` mutates the top-level `x`).

**Loop mode vs one-shot `qbsk run`:** event handlers fire only in loop mode
(`--ansi --loop`, `qbsk profile`, and the Studio frame host). A plain `qbsk run <file>`
still executes the program once and composes the scene once, as before — with no frames
there is no tick to fire and no key to press.

**Mid-frame runtime errors (half-mutated state is never observed silently):** an
uncaught `QbskRuntimeError` in a handler or during re-composition aborts the frame and
the loop, reported with its span — exactly as an uncaught error aborts a one-shot run.
The program stops, so a later frame can never observe state mutated earlier in the
failing frame. To tolerate a failing frame, wrap the handler body in `try ... catch`
(§6.1); a caught error leaves state exactly as the handler code decides. `exit()` in a
handler ends the loop with the given code.

**Determinism (RULE #3):** the loop clock advances by the fixed timestep and
key/resize events arrive through explicit queues, so a given
`(input sequence, frame count)` always produces byte-identical frames. Frame goldens
are scripted through the queues; `random()` and `clock()` remain the only
non-deterministic sources and never appear in goldens (§5.2).

### 7.8 Three mistakes that will cost you (an earlier release — AI ergonomics)

None of these is a bug — the language does exactly what its grammar says. Each cost
a human author an iteration with the source open, which is why they are written
down here. An agent driving QBSK through MCP reads `qbsk://scene-dsl` (this whole
section) before writing a scene.

**(a) A scene word is a keyword only where the grammar is looking for one.**
`layer box z: 5` names a layer `box` and draws into it; `box (0, 0) to (4, 4)`
inside that layer is still the primitive. The rule is §15.15's: a scene primitive
is a STATEMENT and never an expression, so the only ambiguous position is the first
token of a statement, and one token of lookahead settles it — a scene word followed
by `=`, `+=`, `-=`, `[` or `.` is a name.

```qbsk
// Both readings, three tokens apart:
var z = 3
layer box z: 5
    put str(z) at (z, 0)
```

**This reversed in 2026-08-19.** Until then all fifty-one keywords were globally
reserved and `layer box z: 5` reported `'box' is a scene primitive and cannot be a
layer name`. The twenty-five core keywords still do report exactly that.

**(b) Interpolation is eager — a template is not a delayed string.**
`"on your feet, {tag}."` evaluates `{tag}` where the literal is written, so a
string stored for later substitution fails at the build site with an
undefined-variable error (§2.4). Build the string where the value exists, or format
through a `func` called with the value in scope.

```qbsk
// Wrong — {tag} is evaluated here, before tag is defined:
const script = [["J", "on your feet, {tag}."]]

// Right:
func line(tag)
    return "on your feet, {tag}."
// ...called later, where tag is in scope: put line(tag) ...
```

**(c) `visible:` / `color:` / `z:` are state directives, not layer-level guards.**
Each one applies to every primitive that follows it in the same layer until the
layer ends or another directive of the same kind overwrites it (§7.1b, §7.5). The
silent failure is placement: a directive written at the **end** of the layer, or
overwritten before any primitive, reaches nothing and does it silently — `qbsk
check` reports those dead directives. The multi-primitive form is ONE directive
before the group; genuinely per-primitive conditions are written by rewriting the
directive before each primitive.

```qbsk
layer breath z: 3
    visible: breathOn                        // gates everything below, until changed
    put "o" at (39, 18)
    put ".o." at (38, 17)
    visible: breathOn and breathY > 0.4      // overwrites: gates only what follows
    put ". : ." at (37, 16)

layer broken z: 4
    put "x" at (1, 1)
    visible: breathOn                        // dead — nothing follows; qbsk check reports it
```

### 7.9 Audio — the `tone` primitive (an earlier release)

`tone` declares a sound, the same way `put` declares a character. It paints no cells;
it composes into the frame's audio plan. Full spec: `docs/audio.md`.

```
tone <freq> [wave: <name>] [duration: <sec>] [volume: <n>] [loop: <bool>]
```

- `freq` positional and required (int or float > 0, Hz); `wave:` one of
  `sine, square, triangle, sawtooth, noise` (default `square`); `duration:` seconds,
  default `0.1`; `volume:` 0..1, default `0.5`; `loop:` bool, default `false`.
- `freq`/`duration` accept int or float, converted explicitly to float (physical
  quantities, not grid addresses — like `gameTime()` and `animate(...)`).
- Subject to the per-primitive state directives (§7.1b): `visible: false` hides it
  (no sound) like it hides a `put`; `z:`/`color:` are ignored for audio.
- **Trigger semantics (one-shot by default):** a `tone` plays when it first composes
  and does not retrigger while its parameters are unchanged — so an unconditional tone
  plays once at scene start, and gating it with `visible:` plays it exactly when it
  becomes visible (the dialogue-beep pattern). `loop: true` repeats. Changing a
  parameter restarts it. The start time lives host-side, beside the tweens.

## 8. Error model (Rust/Elm style)

```
file.qbsk:7:4 — runtime: variable 'heero' is not defined
  5 |   hero.x += 1
  6 |
  7 |   heero.x += 1
    |        ^^^^^ hint: did you mean 'hero'?
```

- Every error: exact span + fragment with line numbers + `^^^` underline.
- Levenshtein suggestions for variable/member typos (distance ≤ 2).
- Internal TypeScript/Node errors NEVER reach the QBSK user.
- Error recovery in the parser: it reports multiple errors per pass.

### 8.1 A suggestion belongs to the message, not to the tool (L10)

The example above is this section's oldest promise and it was only half kept: the
suggestion appeared in `qbsk check` and **not** in `qbsk run`, for the same typo.

```qbsk
var total = 10
print(str(totl + 1))
```
```
qbsk check → semantic: variable 'totl' is not defined — did you mean 'total'?
qbsk run   → runtime: variable 'totl' is not defined
```

That is the wrong way round. `check` is opt-in tooling; `run` is how the language is
actually met, so the better error lived on the path fewer people take. Of 80 runtime
error sites, exactly one offered a suggestion.

**The rule: wherever the language knows the set of valid names, the error offers the
nearest one.** It is not a feature of the analyzer that the interpreter happens to lack —
it is a property of the error model, and both tools read the same rule.

Where it applies, and what the sets are:

| Error | Candidate set |
|---|---|
| undefined variable | every name in scope, walking the environment chain, plus the natives |
| unknown member on a module | that module's exports |
| unknown named argument | the construct's closed set (§15.1) |
| unknown color, anchor, wave, shade, easing | the closed vocabulary itself |
| unknown key name in `on key` | the canonical key names |

Two rules keep a suggestion honest, and they matter as much as the suggestion:

1. **Distance ≤ 2, or nothing.** A hint that is not actually similar sends the author to
   fix working code, which costs more than no hint. `closest()` returns `null` and the
   message stays bare.
2. **Never suggest a name the author cannot use.** The candidate set is what is *in
   scope at that point*, not everything the program contains — proposing a variable from
   another function would be a lie with a helpful tone.

The runtime has an advantage the analyzer does not, and it is why this is not a copy of
the analyzer's logic: at the moment of failure the environment holds the names that
**actually exist**, not the ones a static pass believes exist. The suggestion is drawn
from there.

## 9. Modules and CLI

### Modules (L5: explicit exports and encapsulation)

- **Formal file extension: `.qbsk`** (since L1; previously `.qb`). All
  scripts, modules and example paths use `.qbsk`.
- Every file runs in its own scope: top-level `var`/`const`/`func` never leak
  into the importer. Only declarations marked `export` are public.
- `export` precedes a top-level `const` or `func` declaration and marks it
  public. Exported bindings are immutable, so `export var` is a parse error
  (use `export const` or a function instead). Everything else is private to
  the file. The entry script is a module too; its exports are simply unused
  unless it is imported.
- `use "res/otro.qbsk"` loads the file, runs its top-level statements once
  (module init side effects), caches the module by normalized absolute path
  (no duplicates or cycles) and binds it in the current scope **by file stem**:
  `use "res/otro.qbsk"` binds `otro`. `use "res/otro.qbsk" as m` binds it as
  `m`. Relative paths resolve from the including file's directory.
- The bound name is a module value: `otro.func()`, `otro.CONST`. Modules are
  immutable first-class values (`<module name>`); reading a non-exported member
  is a runtime error with a span. Importing the same module twice binds the
  same value (init runs once).
- Example:

  ```
  # lib.qbsk
  export const version = "1.0"
  export func double(n)
      return n * 2
  var secret = "private"          # not exported

  # main.qbsk
  use "lib.qbsk"
  print(lib.version)              # "1.0"
  print(lib.double(21))           # "42"
  # print(lib.secret)             # runtime error: no exported member 'secret'
  ```

### CLI

- `qbsk run <file.qbsk> [args]`, `qbsk repl`, `qbsk lex --tokens`,
  `qbsk parse --ast`, `qbsk profile --frames N`, `qbsk --version`.
- `qbsk check <file.qbsk>`: syntax + static analysis without executing. Besides syntax
  errors it reports, always with a span: reads/assignments of undefined names,
  reassignment of `const` and module bindings, wrong argument counts on calls to user
  functions resolvable in scope, and module member typos (missing `export`). It loads
  imported modules (by path, relative to the including file) to verify members and
  flag missing files. Suggestions (`did you mean 'x'?`) use Levenshtein distance ≤ 2.
  Exit code 0 = clean, 1 = problems. `qbsk run` is not affected: type and most value
  errors stay runtime-only.
- `qbsk check --layers <file.qbsk>` additionally prints the engine's conservative
  per-layer staticity report in source order. `static` means the analyzer proved the
  layer can be cached; `dynamic` includes the first reason it could not prove that, such
  as `reads var 'x'` or `calls gameTime`. This is a report, not an annotation: it adds no
  keyword and does not change program semantics.
- `qbsk run <file.qbsk> [args]`: the arguments are available via the native
  `args()` (a list of strings); `len(args())` counts them.
- `qbsk run --ansi --loop --fps 20 --frames 120 <file.qbsk>`: animated frame loop
  (see §7.6); `qbsk profile <file.qbsk> --frames 300`: loop metrics.
- `--no-audio` (any `run`/loop/profile form): disables the audio device — silence
  fallback (see `docs/audio.md` §6).
- REPL: evaluates and prints the value; `null` prints nothing; state (variables/functions)
  persists between lines.

### Installation (L7)

- **Published package:** the npm package `qbsk` ships the compiled CLI (`dist/`), the
  license and `package.json`. The binary is `qbsk`, defined in `bin.qbsk`, pointing at
  `dist/cli/main.js` with a `#!/usr/bin/env node` shebang so the global shim is runnable
  on Windows (`.cmd`) and Unix (exec bit).
- **Install globally:** `npm install -g qbsk` makes `qbsk run`, `qbsk check`, `qbsk repl`,
  `qbsk lex`, `qbsk parse` and `qbsk --version` available from any directory, without
  needing the repository.
- **Run without installing:** `npx qbsk <command>` uses the same published binary.
- **From source (this repository):** `npm run build` emits `dist/`, then
  `qbsk` is available as `node dist/cli/main.js` or via `npm link`.
- **Node version:** the package declares `engines.node`; the CLI runs on the LTS line
  (ESM, `node:` prefixed imports only).
- **What is published:** only `dist/`, `LICENSE` and `package.json` (`files` whitelist).
  Sources, tests, docs and examples stay in the repository and are not part of the
  installable artifact.

## 10. Architect decisions (adopted)

1. Zero initial configuration (no main, no system imports).
2. Strict 4-space indentation; tab = error.
3. Native `(x, y)` tuples with vector arithmetic.
4. Multiline `"""` literals for embedded sprites (canvas blocks).
5. Strict State vs View separation.
6. Default anchors (implicit: top-left; explicit: center, etc.).
7. Conversational error messages; never raw traces.
8. Mandatory double buffer in the engine (engine spec).
9. Scene configuration immutable at runtime.
10. Clean structures for future self-hosting (parser/interpreter rewritable in QBSK).
11. Modules are encapsulated; exports are explicit (`export`), immutable (`const`/`func`
    only, never `export var`) and bound by file stem or `use ... as` (L5).

## 11. Future

- Bytecode VM when tree-walking becomes a limit (not before an earlier release).
- Self-hosting: the goal is for QBSK to be written in QBSK.

---

## 12. `.qbdata` — a data file that cannot run

```qbdata
// bestiary.qbdata
shape creature
    kind: str
    glyph: str
    hp: int
    speed: int

GOBLIN = {"kind": "goblin", "glyph": "g", "hp": 3, "speed": 1}
OGRE   = {"kind": "ogre",   "glyph": "O", "hp": 12, "speed": 1}
```

```qbsk
use "bestiary.qbdata" as bestiary
var e = spawn(bestiary.GOBLIN)
```

### 12.1 Why this exists, since a module already worked

A `.qbsk` module with `export const` already serves data — that was verified before this
was designed. This format exists for two properties a module cannot have, and **not**
because QBSK needed a syntax for dicts.

**A typo is caught at its own line.** Without a shape:

```
spawn({"kind": "wisp", "glyph": "w", "hpp": 5})   // accepted
... three turns later ...                          // runtime: key 'hp' does not exist
```

The report points at whatever *read* `hp`, not at the file that misspelled it. With a
shape, the same mistake fails at load, naming the entry, the key and the suggestion.

**And it reaches inside a list**, because a list of dicts is not a value beside the
entries — it *is* the entries:

```
ALL = [{"kind": "wisp", "glyph": "w", "hp": 5},
       {"kind": "imp",  "glyph": "i", "hpp": 3}]   // reports: 'ALL[1]' ... 'hpp'
```

That is how a table of records is written whenever there are too many to name one by one:
a module's exports cannot be enumerated from QBSK, so seventy-three top-level names would
be unreachable as a set while one list is not. The entry is named by its **index**, since
"the shape does not match" on a seventy-three-row table sends the author to read all of
them (§8).

**An entry may span lines.** A literal continues while its brackets are open, so a table
is laid out as a table:

```
ALL = [
    // head
    {"id": "cranium", "label": "Cranium", "vital": true},
    {"id": "jaw",     "label": "Jaw",     "vital": false}
]
```

Comments and blank lines inside it are a person organising their data and are skipped. The
scan that finds the end of a literal **skips strings**, because `{"id": "a]b"}` closes
nothing and a bracket counter would end the entry in the middle of it. A literal that is
never closed reports at the line that **opened** it, since that is the line with the name
on it. Until 2026-08-19 an entry was one line, which made a 73-record table one line of
nine thousand characters — a format for human-authored tables that could not lay a table
out.

A list of **non-dicts** is still exempt — `SIZES = [1, 2, 3]` beside the records is fine.
That was always the point of the exemption, and until 2026-08-19 it was written so broadly
that it covered lists of dicts too, which left the promise above unkept in exactly the
shape a table takes. Found by the pressure test, writing the 73 anatomical regions of its the design document §3.1.

**A data file cannot execute.** A `.qbsk` module runs its top level when loaded, so
`use "bestiary.qbsk"` runs whatever is in the file. That is unremarkable for files a
person wrote and unacceptable for anything generated or downloaded — which this project
has already proposed for sprites. **A `.qbdata` file has no statements to run**, so
loading one is safe from any source.

That second property is the load-bearing one, and it is why the restrictions below are
not negotiable conveniences. A format that can be widened "just for this one case" has
the property only until someone is in a hurry.

### 12.2 The grammar, and what is forbidden

```
qbdata    := (shape | entry | comment)*
shape     := "shape" IDENT INDENT (IDENT ":" type)+ DEDENT
entry     := IDENT "=" literal
literal   := STRING | INT | FLOAT | BOOLEAN | NULL | list | dict | tuple
tuple     := "(" literal "," literal ")"
```

A tuple of literals is admitted (added in §13, for saves) because it keeps the
load-bearing property intact: `(3, 4)` cannot run any more than `[3, 4]` can. It was
excluded originally by accident of implementation — the literal walker had no case for
it — not by design. A tuple containing a call or a name is rejected like any other
expression.

Only literals. No calls, no operators, no identifiers as values, no string interpolation,
no `use`, no `func`, no statements of any kind. Each is a load error with a span rather
than a silently ignored line, because a restriction nobody is told about is a trap:

| written | reported |
|---|---|
| `HP = 3 + 4` | `.qbdata` holds literals only — `3 + 4` is an expression |
| `X = len(l)` | `.qbdata` cannot call functions |
| `A = B` | `.qbdata` cannot reference other entries |
| `N = "hi {x}"` | `.qbdata` cannot interpolate |
| `use "other"` | `.qbdata` cannot load anything |

### 12.3 Shapes

A shape names the keys an entry must have and their types (`str`, `int`, `float`,
`bool`, `list`, `dict`). Every entry in the file is checked against **the shape declared
above it**; a file with no shape is loaded unchecked, which is the old behaviour and the
reason nothing breaks by adding this format.

An entry that misses a key, adds an unknown one, or gets a type wrong fails at **its own
line**, and a near-miss key gets the suggestion — the same treatment `on key` names got:

```
bestiary.qbdata:9:1 — 'WISP' is missing 'hp'; did you mean 'hp' instead of 'hpp'?
```

### 12.4 What arrives in the program

**Ordinary QBSK values** — dicts, lists, strings, numbers. Not a new type.

That is deliberate: `spawn`, `find`, `without`, the console's `entities` table and every
list native already work on them, with nothing to keep in step. an earlier release measured dicts at
2000 entities per turn in under 5 ms, so there is no performance argument for a special
representation either.

## 13. Saving and loading state (L1 — persistence)

```qbsk
save_state("slot1", {"seed": seed, "turn": turn(), "hp": hp, "map": map})

var loaded = load_state("slot1")
if loaded != null
    hp = loaded["hp"]

var slots = list_saves()   // ["slot1", "slot2"] — sorted, possibly empty
```

Three natives. A program names a **slot**, hands over a **dict of state**, and gets the
same dict back later — across processes, across days.

### 13.1 The design decision — explicit state, not the environment

`save_state` takes a dict the program builds. It does NOT snapshot the live environment,
and that is the design, not a shortcut:

- **An environment is full of unserializable things** — closures over scopes, scenes,
  canvases, natives. Any rule for silently skipping them is a rule for losing data
  without a report.
- **A save file written implicitly is coupled to variable names.** Rename `hp` to
  `health` and every old save silently stops restoring it. A dict the program builds is
  a **contract**: the program decides what its state is, and the save format survives
  refactors the program's internals do not.
- **Restoring is assignment the program performs**, so a loaded value lands exactly
  where the program says — including into structures that did not exist when the save
  was written (version migration is an `if` on a `"version"` key, not an engine
  feature).

### 13.2 The format — a `.qbdata` file, and that is the security model

A slot is written as a `.qbdata` file (§12) with one entry per top-level key:

```qbdata
// saved by save_state("slot1", ...)
seed = 1337
turn = 42
hp = 7
map = ["####", "#..#", "####"]
```

`load_state` reads it with the same loader `use` has (§12), which is the point:

- **A save file cannot execute.** Players share saves; saves get edited, generated and
  downloaded. `.qbdata` was designed for exactly this threat (§12.1), so tampering with
  a save can corrupt *values*, never *behaviour*.
- **Round-trip agreement by construction.** The writer emits what the `.qbdata` grammar
  admits; the reader is the existing `loadQbdata`. There is no second parser to drift.
- **A save is readable and diffable** in any text editor, which is worth more to a
  person debugging "my save is broken" than any binary format's speed.

### 13.3 What may be saved

A value in the state dict must be **data**: `null`, `bool`, `int`, `float`, `str`,
tuple, and lists/dicts of the same, to any depth. Handing `save_state` a function, a
scene, a canvas, a sprite or any other live object is a **runtime error naming the
offending key and its type**:

```
save.qbsk:12:1 — 'slot1' cannot save key 'attack': a func is not data
```

Never a silent skip: a save that quietly dropped a key would be discovered three
sessions later by whatever read it back — the same failure mode shapes exist to
prevent (§12.3).

Top-level keys must be valid `.qbdata` entry names (`[A-Za-z_][A-Za-z0-9_]*`), because
they become entries. An invalid key is the same runtime error, naming the key.

### 13.4 The natives

| native | signature | returns | errors (span always) |
|---|---|---|---|
| `save_state` | `save_state(slot: str, state: dict)` | `null` | non-dict state; unserializable value (names the key); invalid slot name; host refuses the write |
| `load_state` | `load_state(slot: str)` | the dict, or `null` if the slot does not exist | a slot that exists but fails to parse or violates §12 (a corrupt save is an error, not a missing one) |
| `list_saves` | `list_saves()` | sorted list of slot names, `[]` when none | never errors — no storage means no saves |

`load_state` returning `null` for a missing slot (rather than erroring) is deliberate:
"no save yet" is the *normal* state of a fresh install, and the Continue-menu idiom is
an `if`:

```qbsk
var save = load_state("slot1")
if save == null
    // new game
```

A slot that exists but cannot be read is the opposite — an error with the loader's own
span and message, because a corrupt save silently treated as "no save" would erase a
player's game without a word.

**Slot names** match `[A-Za-z0-9_-]+` and never contain path separators or dots. A slot
is a NAME the program invents; where it lives is the host's business (§13.5). This is
the same boundary `host()` draws (§5.2): the program cannot reach the file system, it
can only name things.

### 13.5 The storage door — hosts decide where saves live

The natives do not touch the file system. They call a **storage interface the host
provides**, exactly as `print` goes through `HostIO`:

```ts
export interface SaveStore {
  read(slot: string): string | null;   // .qbdata text, or null if absent
  write(slot: string, text: string): void;
  list(): string[];
}
```

- **The CLI** (`qbsk run`) stores slots as `<script-dir>/saves/<slot>.qbdata`.
- **Tests** hand in an in-memory store, so persistence tests need no disk.
- **A host that provides no store** gets the honest error at the call site:
  `'save_state' has nowhere to save — this host provides no save storage`. Not a silent
  no-op: a program that believes it saved and did not is the worst outcome on this page.

This is the first door out of the sandbox, and it is shaped like the doors in
(`host()`, `HostIO.print`): the program names an intent, the host owns the mechanism,
and nothing about the file system — paths, existence, permissions — is expressible in
QBSK.

### 13.6 Determinism and the acceptance test

A save that stores `seed` and `turn` restores a deterministic game exactly: same state
dict + same inputs ⇒ byte-identical frames (§7.7 holds because nothing about loading is
clock-dependent). The acceptance test for this section is a round trip: run a
simulation, save, load into a **fresh interpreter**, and compare grids byte for byte.

### 13.7 What is deliberately absent

- **No autosave, no save-on-exit.** A program calls `save_state` when it means it.
- **No binary format.** Text `.qbdata` until a measured game save is too big or too
  slow, per the perf doctrine.
- **No `delete_save`.** Deleting is destructive, rare, and host-flavored; it waits for
  a real program that needs it.
- **No saving scenes, sprites, canvases.** Programs rebuild presentation from state —
  that is what declarative recomposition (§7.7) is FOR.

---

## 14. Silence is the only unacceptable failure (L8 — the ghost hunt)

A review of the whole surface found 13 features that parse but do not do what they read
like. They split cleanly in two, and the split is the whole point of this section:

- **The loud ones** — `sprinkle` raises `sprinkle is reserved for M18…`, a named argument
  in a call position raises, `..` outside a `for` raises. These are HONEST. The author
  writes something, is told it does not work, and moves on. Nothing is corrupted.
- **The silent ones** — a named argument reaching across a newline to eat the next line's
  state directive, an `anchor:` on a layer composing to nothing, a scene parameter that is
  read by no one. These change what runs, or fail to, and say NOTHING.

§7.8 already states this project's rule: *silence ≠ correct*. A loud gap costs a reader
one minute. A silent one costs the reader their trust in every line they did not write,
because nothing on screen distinguishes "I typed it wrong" from "the language ignored it".

**This section is therefore not about implementing what is missing. It is about deleting
silence.** Where a real feature is cheap and specified, it gets implemented (§14.3);
where it is not, the ghost is turned into an error that names itself (§14.1, §14.2,
§14.4); where it never existed, it leaves the spec (§14.5, §14.7). Every rule below has
one acceptance criterion in common: **after it, no program changes meaning without saying
so.**

### 14.1 A named argument belongs to the line it is written on

A named argument (`key: value`) binds to the construct on **its own line**. A key whose
token begins on a line after the construct's last token is NOT a named argument of that
construct — it is the next statement.

```qbsk
layer a z: 1
    tone 440
    z: 9                    // a STATE DIRECTIVE (§7.1b), not a property of tone
    put "LOW" at (0, 0)     // composed at z 9
```

Before this rule the `z: 9` was consumed as a property of `tone` — the `ZStmt` never
entered the AST, and every primitive below kept the previous `z`. **It changed what got
drawn based on nothing but the adjacency of two lines**, which is the most silent failure
in this document: the source reads correctly, the output is wrong, and no diagnostic
exists anywhere.

- The rule is positional, not per-primitive. `sprite`, `tone`, `shade` and `put` all obey
  it, and so does any primitive added later.
- Same-line named arguments are unaffected: `sprite "h.qba" at (0, 0) anchor: center`
  parses exactly as before. Only the reach across a newline is removed.
- A named argument a construct does not accept is an error that names the key:
  `'z:' is not a property of 'put' — put takes 'depth:'`. `put` accepts `depth:` only.
- This rule replaces the hand-written `=== "depth"` guard that protected `put` alone.
  Fixing the cause covers all four primitives; guarding one symptom covered one.

Note the interaction with §14.2: because `anchor:` on the line after a `sprite` is no
longer that sprite's property, it is parsed as a layer-level `anchor:` — and rejected.

### 14.2 `anchor:` is a primitive property, never a layer directive

`anchor:` is a property of a positioned primitive (§7.3). It is **not** a state directive
and there is no layer-level form:

```qbsk
layer a z: 1
    anchor: center          // ERROR — anchor: is not a layer directive
    put "H" at (0, 0)
```

The error is raised by the **parser**, not by `qbsk check`. This is deliberate and worth
recording, because the alternative was chosen against:

> The static analyzer's own doctrine is that it *"never reports a problem that cannot be
> observed by running the same program"*. A layer-level `anchor:` cannot be observed by
> running the program — that is precisely what made it a ghost. Reporting it only in
> `qbsk check` (which is opt-in) would leave `qbsk run` silently mis-composing. And unlike
> a dead `z:` (§7.1b), which is *contextually* useless but structurally legal, a
> layer-level `anchor:` is **never** valid in any context. Structural impossibility
> belongs in the parser.

- Message: `'anchor:' is not a layer directive — put it on the primitive it positions`.
- The working form is untouched: `sprite "h.qba" at (0, 0) anchor: center`.
- The state directives remain exactly the three of §7.1b/§7.5: `z:`, `visible:`, `color`.
  This is a closed set; a fourth is a language change, not a property placed loosely.

### 14.3 Scene parameters are a closed set, and all of them are read

`scene Name(width: W, height: H, title: T, fps: N)` has exactly four legal keys — the
same four the §3 grammar declares.

- An unknown key is an error naming it, with a Levenshtein suggestion when one is within
  distance 2: `unknown scene parameter 'tilte' — did you mean 'title'?`. Previously ANY
  key was accepted in silence, including in `examples/hello.qbsk`, the first example in
  the repository.
- `width` and `height` stay mandatory and stay `int` (§7.1).
- `title:` (`str`) and `fps:` (`int`) are **read**. They were specified in §3 and used in
  the examples while nothing in the implementation ever looked at them: a parameter that
  the grammar promises and the runtime discards is a lie told by the spec itself.
- A host reads them as scene metadata alongside the composed canvas. Absent parameters
  report as `null` — **never an invented default**. `fps: null` means "the program did not
  say", which is information; `fps: 60` invented by the runtime would be a fabrication,
  and the host already owns the frame rate (`--fps`, §7.6).
- Scene configuration remains immutable at runtime (§10, decision 9): these are read once
  at composition, not per frame.

### 14.4 A handler that can never fire is an error

Event handlers register while the top-level program runs, once (§7.7). Anything that
evaluates an `on ...` declaration outside that window produces a handler that is created,
is valid, and is then dropped — and pressing the key afterwards is indistinguishable from
not pressing it.

Two paths did this in silence, and both are now errors:

1. **After bootstrap.** A handler declared inside a function that is called from another
   handler (i.e. once the top-level pass has finished) can never be registered.
   `an 'on' handler declared here can never register — handlers register while the
   top-level program runs (§7.7)`.
2. **Inside a module.** The frame loop belongs to the entry program, so an `on ...` inside
   a `use`d file never registers. This is a real design decision (§7.7) and it stays —
   but it is now stated to the author instead of being applied behind their back:
   `an 'on' handler in a module never registers — the frame loop belongs to the entry
   program`.

Declaring a handler inside a function called *during* the top-level pass, or inside an
`if` branch, or inside a `layer` body, remains legal and registers normally. The rule is
about *when* evaluation happens, never about nesting depth.

Two cases where nothing registers and that is deliberately **not** an error:

- **A one-shot `qbsk run`.** §7.7 already states that a plain run composes one frame with
  no ticks and no keys. The same file legitimately declares handlers for loop mode and
  still composes correctly without one, so refusing it would reject a correct program for
  how it happens to be invoked. The distinction is *never* versus *not this time*: a
  module handler can never register under any invocation, a one-shot handler simply has
  no frames right now.
- **Per-frame re-composition.** The scene body is re-visited every frame (§7.6) and its
  handlers registered during bootstrap. The registration window exists precisely so they
  are not registered again — re-registering would stack duplicate handlers and every game
  would break on frame 2. The window stays; only its silence was removed.

### 14.5 `sprinkle` is removed from the language

`sprinkle "*" count: N at random` is gone: the keyword is released, `sprinkle` is an
ordinary identifier, and the old syntax fails at parse time.

The reason is §1's rule, not its 18 phases of reservation: **before adding a keyword, ask
whether it can be expressed with what already exists.** Since L4 it can, and better:

```qbsk
var r = rng(1234)
for i in 0..40
    put "✦" at (roll_int(r, 0, 39), roll_int(r, 0, 19))
```

Seeded, so the scatter is reproducible and golden-testable — which `at random` could never
have been, and this project asserts frames byte for byte (§7.7). A builtin whose
composition from existing primitives is *strictly better* than the builtin is not a
missing feature; it is a keyword owed back to the author.

Removal, not a permanent loud error, because the error was the honest part: the dishonest
part was occupying a name in a language that reserves keywords globally (§2.6) for a
feature whose replacement had already shipped.

### 14.6 A parameter list spans lines wherever an argument list does

Indentation inside `( )` carries no block meaning. Call arguments, list literals and dict
literals already honoured this; **declarations did not**, so a parameter list broken
across lines failed with `expected the parameter name` and up to six cascading errors —
one of which advised converting the lambda to a named `func`, which failed the same way.

These now all accept line breaks and an optional trailing comma:

```qbsk
func add(
    a,
    b,
)
    return a + b

var mul = func(
    a,
    b,
) a * b
```

The rule covers every parenthesised parameter list: `func` declarations, lambdas,
`on tick(...)`, `on turn(...)`, `on resize(...)` and `scene(...)`. Consistency here is not
cosmetic — a language where `f(\n a,\n b\n)` works but `func f(\n a,\n b\n)` does not is
teaching a distinction that does not exist.

### 14.7 What was never real

- **`timeline` as a statement.** The §3 grammar listed `| timeline` in the `statement`
  production and never defined that production. No token, AST node, parse function or
  interpreter case ever existed. The dangling reference is removed. Timelines are real but
  they are **values queried by natives** (`timeline_wait`, `timeline_sequence`, …,
  `docs/engine.md` §11) — never a block form. A grammar that promises a statement nobody
  wrote is the same lie as a parameter nobody reads (§14.3).

### 14.8 The AST printer must not hide what the parser read

`printAst` is how the parser is verified. Any field it omits is a field tests cannot see,
so an omission is not a cosmetic gap — it is a **blind spot in the instrument**.

`PutStmt` printed neither `depth` nor `world`, which made three structurally different
programs print identically:

```
put "X" at (0, 0)              (Put "X" at (0, 0))
put "X" at (0, 0) depth: 3     (Put "X" at (0, 0))      // depth invisible
put "X" world: (0, 0)          (Put "X" at (0, 0))      // world invisible, and a LIE:
                                                        // it prints "at" for a world coord
```

The rule: **if the parser stores it, the printer shows it.** A named argument or
positional modifier that survives into the AST is observable in the printed form, and
`world:` prints as `world:` — never as `at`. Same for `TextStmt`/`SpriteStmt` `world:` and
`LayerDecl` `at`.

This is the one item on the list that is not a language feature. It is included because
it is why several of the others survived so long: a test suite of 1268 green tests could
not see them.

---

## 15. Hardening: the borders of the language (L9)

§14 hunted the ghosts a review had already catalogued. An independent review run
immediately after it found that the *class* had not been eliminated — only its known
instances. Five more silent no-ops were alive in the scene DSL, and four paths let a raw
Node error reach the user, which RULE #4 forbids in one line.

That is the lesson this section records, and it is worth more than the fixes: **§14 fixed
instances where it should have closed categories.** A named-argument whitelist written for
`scene` and not for `sprite`, `tone`, `shade` and `color` was never a fix — it was one
example of a fix. This section closes the categories.

The three invariants below are the whole content. Everything after them is the specific
consequence of applying one of the three.

> **I1 — Every named argument belongs to a closed set.** A construct that accepts
> `key: value` accepts a *known* set of keys and reports any other, with a suggestion when
> one is near. No construct silently tolerates a key it does not read.
>
> **I2 — Every value a construct evaluates is either used or reported.** Nothing is
> computed and dropped. Nothing is accepted and ignored. If a program says something the
> language cannot honour, the language says so.
>
> **I3 — No host error reaches the author.** Every failure the author can trigger is a
> `QbskError` with a span and a source fragment — including the ones the host raises on
> our behalf (stack overflow, allocation limits, file system).

### 15.1 Named arguments are a closed set everywhere (I1)

Applies to `sprite`, `tone`, `shade`, `color`, `put`, `box`, `border` and any primitive
added later. An unknown key is a runtime error naming the key, the construct, and the keys
that construct accepts:

```qbsk
sprite "res/hero.qba" at (0, 0) bogus_key: 5
// runtime: 'bogus_key:' is not a property of 'sprite' (anchor, scale, frames, fps, loop)
```

- The keys per construct: `sprite` — `anchor`, `scale`, `frames`, `fps`, `loop`;
  `tone` — `wave`, `duration`, `volume`, `loop`; `shade` — `x`, `y`, `radius`, `tint`,
  `strength`, `speed`; `color` — `fg`, `bg`; `put` — `depth`; `box`/`border` — `style`.
- A near-miss gets the suggestion (§8): `'ancho:' is not a property of 'sprite' — did you
  mean 'anchor:'?`.
- A repeated key is an error too, rather than last-one-wins deciding silently.
- **`style:` values are validated against the closed set as well.**
  `box (0, 0) to (5, 3) style: fancy` used to fall back to `single` through a
  `?? "single"` default, so a typo drew a box that looked deliberate. The styles are
  `single`, `double`, `rounded` (§7.1), and anything else reports.

### 15.2 A primitive outside a layer is an error (I2)

A drawing primitive composes into a layer. Written at the top level, or directly in a
`scene` body, it evaluated fine and was then discarded — the program printed nothing, drew
nothing, and exited 0:

```qbsk
put "ghost" at (0, 0)       // ERROR: a primitive draws into a layer
print("done")               // this used to be the only visible output
```

The message names the fix: `'put' draws into a layer — put it inside a 'layer' block`.

**§7.3's `world:` example is corrected by this rule, not exempted from it.** That section
showed `put "TITLE" world: (10, 2)` at the top level to illustrate that `world:` ignores
the layer offset. The illustration was wrong: `world:` is a coordinate space, not a licence
to draw outside a layer. The example now writes the `put` inside a layer, where the offset
it is ignoring actually exists — which is also the only context in which the contrast means
anything.

### 15.3 A named argument's value is an expression (I2)

`sprite`'s property values were read as literal strings when they were bare identifiers, so
a variable was unusable and the error blamed the author for a type they had not written:

```qbsk
var count = 4
sprite "res/walk.qba" at (0, 0) frames: count
// was: runtime: 'frames' must be an int, got 'str'   ← count was read as "count"
```

Only `anchor:` and `tint:` take a bare word as a name (`anchor: center`, `tint: blue`), and
only because those are closed vocabularies rather than values. Every other named argument
evaluates its expression. The same bug had already been found and fixed for `shade` alone;
this states the rule so the next primitive inherits it.

### 15.4 Errors the host raises are still QBSK errors (I3)

Four paths let a Node error through. Each is now a spanned QBSK error:

| Trigger | Was | Now |
|---|---|---|
| `func f(a, a)` | `variable 'a' is already defined` with no span; a full stack trace inside an `on tick(a, a)` | a spanned error at the duplicate parameter |
| `"a" * 999999999` | `Invalid string length` | a spanned error naming the limit |
| unbounded recursion | `Maximum call stack size exceeded` | a spanned error at the call, naming the depth limit |
| `qbsk run missing.qbsk` | an `ENOENT` stack trace | `cannot read 'missing.qbsk': file not found` |

The recursion limit is a **language constant, not a JavaScript accident**: QBSK reports at
its own documented depth so the message is the same on every host, instead of wherever V8
happens to run out of frames.

### 15.5 A module cannot see the entry program (I2)

§9 states that a module runs in its own scope and that a top-level binding never leaks. It
leaked in one direction: the entry program's top level defined into the same environment
the natives live in, and a module's scope chained to that environment, so a module could
read the entry program's variables:

```qbsk
// entry.qbsk
var entry_secret = 99
use "mod.qbsk"
print(str(mod.peek()))      // printed 99

// mod.qbsk
export func peek()
    return entry_secret     // resolved, and should not have
```

A module now resolves names against the natives and its own scope only. A consequence
worth stating because it is the visible half of the same bug: the entry program's top level
is its own scope too, so `var len = 5` shadows the native instead of colliding with it.

### 15.6 `len` and indexing count the same thing (I2)

They did not, and the code claimed they did:

```qbsk
var s = "a💚b"
print(str(len(s)))    // 4
print(s[3])           // runtime: index 3 out of range for a string of 3 characters
```

`len` counted UTF-16 units, indexing counted code points, and `len(s) - 1` — the
last-index idiom — was broken for any text outside the BMP. **Both count code points.**
A character is what indexing returns, and `len` reports how many of those there are: any
other pairing makes the two disagree about what position 1 is, which is worse than either
answer alone.

### 15.7 The static analyzer's own doctrine, enforced (I2)

`analyzer.ts` states it never reports a problem that cannot be observed by running the
program. It broke that rule and its converse:

- **False positive**: `use "mod.qbsk" as m` inside a function runs correctly and
  `qbsk check` reported `variable 'm' is not defined`. A checker that flags working code
  teaches the author to ignore it, which costs more than having no checker.
- **False negatives**: `tone`/`shade` argument expressions and `put`'s `depth:` were never
  walked, so an undefined variable in them passed `check` and failed at runtime.

### 15.8 Smaller borders, same principle

- **`--fps -5`** was silently ignored and the loop ran at the default rate. A negative
  value now reports, like `--fps 0` already did: a flag that is accepted and discarded is
  the CLI's version of a ghost.
- **A UTF-8 BOM** made `print(1)` fail with `unexpected character '﻿'` — an error whose
  offending character is invisible, on files Windows editors produce by default. The BOM is
  consumed.
- **`INDENT`/`DEDENT` tokens printed as `'null'`** in parser messages
  (`unexpected expression: 'null'`). They report as `indentation` / `end of block`.
- **`1 % 0`** reported `division by zero`. It reports `modulo by zero`; the operator in a
  message is the one the author wrote.
- **Spans narrow to the offending part**, not the whole statement, wherever the AST already
  holds the narrower span — `sprite`'s path, `tone`'s frequency, `layer`'s `z`. §8 promises
  the error points at the mistake, and a whole-line underline points at the program.

### 15.9 What the spec owes the reader

Findings that were documentation defects, not code defects. They are listed because a spec
that describes a language nobody implemented is the same failure as code nobody specced:

- **`sin`, `cos`, `tan`, `atan2`, `pi` were registered natives documented nowhere.** RULE
  #2 in reverse: code without spec. They are specced in §5.2 with their radian convention.
- **`host()`** was described in this document with semantics that matched no registered
  native. It reads host data and returns a value or `null` (`docs/studio.md` §14.6).
- **Anchor names disagreed four ways**: the runtime accepts 10, the error message listed 9,
  §7.3 said 9, the §3 grammar said 5. There are **9 named anchors**; `middle-center` was an
  undocumented alias of `center` and is removed rather than blessed, because two names for
  one point is the "single way to do things" principle (§1) losing to an accident.
- **`.qba` META `anchor:`** appeared in `docs/engine.md`'s own canonical example and the
  loader dropped it silently. Either key is honoured or it leaves the example; it leaves.

### 15.10 Why a hardening phase exists at all

The engine work that follows this (input, raw mode, the game loop) builds on this
interpreter. Every defect above would have been inherited by it, and a silent no-op in a
DSL is annoying while a silent no-op under a game loop is unplayable — sixty frames a
second of nothing happening, with no diagnostic.

The measure of this phase is not the count of fixes. It is that **the three invariants are
stated**, so the next construct, the next native and the next host call are checked against
a rule instead of against whether anyone remembered.

### 15.14 Inside a bracket, a line break carries no meaning

QBSK is indentation-sensitive, so a newline ends a statement. Inside a bracket it should
not, and it did.

The comma-separated walker already skipped the lexer's spurious `INDENT`/`DEDENT`
**between** items, so a list could span lines — but not one item of it. A program could
therefore lay out a **list** across lines and never a **formula**:

```
var l = [1,
    2]          // always worked
var x = (1 +
    2)          // "unexpected expression: 'indentation'"
```

Found writing the design document §9.1's discontent function, where six weighted terms do not fit on one
line and putting them there is not an answer. All four bracket contexts failed identically
— grouping, call arguments, list elements and dict values — so it was one rule missing in
one place rather than four holes.

The depth is a **count and not a flag**: `(max(1,` … `2) + max(3,` … `4))` closes the inner
call while the outer group is still open, and a flag would re-enable line endings halfway
through. Outside every bracket the depth is zero and a newline still ends the statement,
which is the property this could most easily have taken with it — `if` bodies, `func`
bodies and the "indented under nothing" error are all pinned by
`tests/unit/line-continuation.test.ts`.

**The count lives in the lexer, and the first version of this fix put it in the parser.**
That is the whole of the difference and it is worth writing down, because the parser
version passed every test above and was still wrong. A parser that **skips** the layout
tokens skips the `INDENT` and then still receives its `DEDENT` — so when the expression
ends, one `DEDENT` too many arrives and closes whatever block the formula was written in:

```
func f(a)
    if a > 0
        var s = (1 +
            2)
    if a > 1        // "variable 'a' is not defined": the func body closed above
        return 9
```

The tests missed it for a day because none of them had a block left to close. At the top
level, and in a one-deep `func` body, the surplus `DEDENT` lands where nothing is open and
is silently harmless — which is why the four contexts all looked fixed. The lexer version
does not skip the pair, it **never emits it**, so the indent stack can never learn about a
level the parser is not tracking. Found by a simulation module, whose `score = (…)`
formulas sit two levels in.

⚠️ **A related behaviour that is older than this change and was a surprise when it was
found.** A continuation line at the SAME indentation has always worked, because the lexer
emits no `INDENT` for it and nothing else terminates a statement:

```
var a = 1
+ 2             // a is 3, and always was
```

So the gap was never "expressions cannot span lines" — it was that an **indented**
continuation could not, which is the one a person actually writes. The older behaviour is
now pinned by a test so a later change to the lexer cannot remove it silently.

### 15.13 Nine scene-DSL words are contextual, not reserved

> **Superseded by §15.15.** All twenty-six are contextual now. This section is kept because
> the reasoning it records — *why nine and not twenty-six* — was the honest answer at the
> time and was wrong for a reason worth naming.

**Twenty-six of the fifty-one keywords exist only for the scene DSL**, and every one of
them was unusable as a name — in a file that never draws, in a module that has no scene at
all. This is the one item in review that was a *preference* rather than a defect:
no program was wrong because of it. It had still cost something. `examples/lib/cinematic.qbsk`
needed a parameter called `at`, could not have one, renamed it to `enters` with a global
find-and-replace, and shipped six comments reading *"into lines of enters most `width`
characters"* and *"Which beat is speaking enters time `t`"* for a day and a half.

**Nine are now contextual:**

| | reachable only |
|---|---|
| `at` `from` `to` `style` `world` | after a drawing primitive has been recognised |
| `start` `tick` `key` `resize` | immediately after `on` |

Each of those positions is reached by an `expect` or `match` on the token TYPE, from inside
`parsePrimitive` or `parseEvent`. The keyword reading therefore still wins wherever the DSL
asks for it, and the name reading is available everywhere else — including in the same
statement:

```
var at = 3
put str(at) at (at, 0)     // a variable, the keyword, and the variable again
```

**`color`, `anchor`, `z` and `visible` stay reserved**, and the reason is the whole shape of
the decision. Each has its own arm in the statement dispatch, so `color = 1` inside a layer
would be genuinely ambiguous — and that ambiguity is where a grammar change earns its
regressions. Nine were freed because nine could be freed without one.

Widening what parses cannot break a program that already parsed, so this is not a break
under §17.1. What it does change is two error messages: `func step_toward(from, to)` used to
report *"'from' is a scene DSL keyword and cannot be a parameter name"* and now reports only
that the function has no body. A still-reserved word reports exactly as it did.

### 15.15 Every scene word is a name outside statement position

§15.13 freed nine of the twenty-six scene-DSL keywords and argued that the other seventeen
could not be freed, because `color`, `anchor`, `z` and `visible` each begin a statement and
`color = 1` inside a layer would be ambiguous. **The argument was sound and the premise was
false**: not one of the four uses `=`. They use a colon — `z: 3`, `visible: false`,
`color fg: "red"` — and `anchor:` is always an error. There was no ambiguity to protect.

The cost of finding out was three collisions in one phase, all on `line`, and one
asymmetry that says the whole thing in a line: **`var x` and `var y` compile, `var z` does
not**, in a project simulating bodies in space.

**The rule, and it is one rule rather than twenty-six exceptions.** A scene word is a
keyword only where the grammar is looking for one:

| position | reading |
|---|---|
| the first token of a statement | the primitive, unless the next token says otherwise |
| inside a primitive already recognised (`… at (x, y)`) | the keyword |
| anywhere else — as a value, an argument, a parameter, a field, a dict key | a **name** |

A scene primitive is a **statement** and never an expression, so `f(line)`, `x + line`,
`d["line"]` and `func f(line)` are not ambiguous in any grammar. Only the first token of a
statement is, and **one token of lookahead settles it**: a scene word followed by `=`, `+=`,
`-=`, `[`, `.` or a call's `(` is a name, because no primitive's syntax continues that way.

```
var z = 3
z += 1              // an assignment: `z` then `+=`
layer l z: 0        // the directive: `z` then `:`
    fill "."
    put str(z) at (z, 0)
```

**What stays refused.** `var if`, `var return`, `var func` — the twenty-five core keywords
are untouched. The DSL's own diagnostics are untouched too: `on whenever` is still not an
event, `anchor:` inside a layer still reports that it belongs on the primitive it positions,
and `color` with no key still asks for one.

**One shape is genuinely lost, and it is worth stating rather than discovering.** A bare
statement consisting only of a scene word — `line` alone on a line, evaluating a variable
and discarding it — reads as the primitive and reports as one. That statement does nothing
in any language and QBSK has never had a use for it.

Widening what parses cannot break a program that already parsed, so this is not a break
under §17.1.

### 15.16 Truecolor was already emitted and could not be written

`docs/language.md` said *"Truecolor `#rrggbb` is left for M13+"* from L4 until 2026-08-19.
It was not left for anything. **`sgrOf` has emitted 24-bit SGR since the renderer was
written** — `38;2;r;g;b`, unpacked out of a `0xRRGGBB` cell — and every stage of the
pipeline, the buffer, the diff and the WebGL painter, carries the full 24 bits. The only
thing that was missing was the front door: `resolveColor` took a name out of a table of
sixteen and returned `null` for everything else.

So the language could emit sixteen million colours and an author could name sixteen.

Found writing anatomical panel. the design document §2.2 specifies **nine** colours by hex value
and three of them have no ANSI name: orange `#FF7F00` for moderate functional compromise,
purple `#8B00FF` for exposed bone, and `#444444` for ischemic tissue — against
`bright-black`, which is `#7F7F7F` and reads as ordinary grey. Approximating them would
have collapsed three of §2.2's nine distinctions into colours already in use, in a panel
whose entire purpose is that the nine are distinguishable at a glance.

```qbsk
layer body z: 1
    color fg: "#ff7f00"
    put "M" at (4, 2)
```

**What this is not.** It is not the 256-colour palette, and it is not a three-argument
colour constructor. Both are additional ways to spell values `#rrggbb` already reaches, and
the value is in what can be SAID, not in how many ways there are to say it.

**A terminal that cannot do truecolor** receives the sequence and approximates or ignores
it, exactly as it already did for the sixteen names — which are emitted as truecolor too,
and always have been. Nothing about the emission changed; only what an author is allowed to
write.

### 15.17 An index that is a float says what to write instead

`/` returns a float whatever its operands, and §17.1 freezes that. In a language whose
commonest values are grid coordinates, that is a trap: `span / 2` reads like integer
division to anyone arriving from C, Go or Java, and QBSK hands back `1.5`.

The trap is not the semantics — it is the DISTANCE. The float is produced on one line and
reported on another, often in a different function, as:

```
a list index must be an int, got 'float'
```

which names the symptom and not the cause. Nothing in that sentence tells an author that
the arithmetic three lines up is where to look, and it cost four separate incidents in one
file while the interface layer was being written.

**A float index now says what to write:**

```
a list index must be an int, got 'float' — `/` is float division whatever its
operands, so wrap the arithmetic: int(a / b)
```

All four index sites say it — lists read, lists written, strings and tuples — because a
message written for one of them and not the others is the same defect with better odds.

**Deliberately NOT changed: `int / int` still returns a float.** §17.1 freezes the meaning
of the operators, and this is the kind of break that is worst: a program that used to run
keeps running and quietly returns different numbers. The fix is the diagnosis, not the
arithmetic.

**And `//` cannot be integer division** — it opens a line comment. Any future operator for
it has to be a character the language does not already spend.

### 15.18 `contains` answers for lists too

`contains` was string-only, and there was no way at all to ask whether a LIST held a
value. `find` and `without` are for entities; `has` is for dicts. So every program that
needed the commonest question in programming wrote it out:

```qbsk
func holds(list, value)
    for item in list
        if item == value
            return true
    return false
```

That exact function was written by hand twice in one codebase, in two modules, three weeks
apart. A rule a language makes you re-derive is a rule the language has not learned.

**`contains(haystack, needle)` now takes a string or a list.** On a string it is unchanged
— the same substring test, byte for byte. On a list it compares with the same equality `==`
uses, so it answers for ints, floats, strings and bools, and reports on a list of dicts
rather than guessing at what "the same dict" means.

**Why this is not a §17.1 break.** The freeze says a native is not *given different
semantics*. A list argument used to REPORT — `'contains' expects a str, got 'list'` — so no
program that ran can tell the difference. Widening an error into an answer cannot change
what a working program does, which is the same argument §15.15 made for the scene words.

**`x in list` was considered and not built.** `in` is already the loop keyword, so reading
it as an operator is a grammar change rather than an addition, and §17.1 promises the
grammar. A native says the same thing and costs nothing to keep true.

### 15.19 `slice` cuts strings, and `format` writes a number the way you meant it

Two ergonomics the language was missing, both found by writing a lot of QBSK rather than by
reading the spec.

**`slice` was list-only while `[]` indexed strings.** So `s[3]` answered and
`slice(s, 0, 3)` reported `'slice' expects a list, got 'str'` — an asymmetry with no reason
behind it, and the workaround was a `while` loop concatenating one character at a time. It
takes a string now, with the same clamping the list form has: out-of-range ends are pulled
in rather than reported, because a substring that runs off the end is a normal thing to ask
for and an error there would be pedantry.

**`format(x, places)` writes a fixed number of decimals.** Without it, every line that
wanted three decimals wrote `str(int(x * 1000.0))` and then had no way to put the point
back. That appears about a hundred times across one codebase's tests and log lines, and it
is wrong twice over: `int` truncates rather than rounds, so `0.0006` printed as `0` and
`2.9999` as `2999`.

```qbsk
format(3.14159, 2)      // "3.14"
format(2.0, 3)          // "2.000"
format(0.0006, 3)       // "0.001"   — rounded, not truncated
format(7, 2)            // "7.00"    — an int is a number too
```

Neither is a §17.1 break. `format` is new, and adding is not breaking. `slice` on a string
used to REPORT, so no program that ran can tell the difference — the same argument §15.18
made for `contains` and §15.15 made for the scene words.

### 15.20 A runtime error says which calls led to it

QBSK's errors carry a span and a fragment, and that is the language's best feature. What
they never carried is the ROUTE. An error four calls deep reported the innermost line and
nothing else:

```
sim.qbsk:88:24 — runtime: a list index must be an int, got 'float'
   |
88 |     return table[at]
   |            ^^^^^^^^^
```

Which is true, and useless. `table[at]` is a general-purpose accessor called from thirty
places; the question is which of the thirty, and the message answered by saying nothing.

**A runtime error now lists the calls that led to it, innermost first:**

```
sim.qbsk:88:24 — runtime: a list index must be an int, got 'float'
   |
88 |     return table[at]
   |            ^^^^^^^^^
   in lookup (sim.qbsk:88)
   from capacity (sim.qbsk:141)
   from step (sim.qbsk:512)
```

Three rules it follows:

- **The innermost frame is named even at depth one**, because "in `lookup`" is information
  when the span is inside a function the caller did not write.
- **Deep recursion is elided in the middle** — the first four frames, then how many were
  dropped, then the last two. A thousand identical lines is not a trace, it is a wall, and
  the two ends are what a reader uses.
- **Top-level code has no frame.** An error outside every function shows the span alone, as
  it always did.

**It costs two array writes per call**, into slots indexed by the depth counter the
interpreter already keeps, so nothing is allocated once a program is warm and a frame that
does not fail pays nothing else.

**Measured, A/B, back to back in one sitting (§13.1): 673 ms against 658 ms — 2.3%** on a
program of 600,000 function calls and almost nothing else. That is a real cost and not
noise, and this paragraph said "inside the noise" until the measurement was taken, which is
the mistake §13.1 exists to stop.

Kept at that price because the benchmark is the worst case by construction: it is call
saturated, while a real QBSK frame spends most of its time in the engine rather than in
dispatch. An error that names the route is worth 2% of the dispatch cost of a program that
does nothing but dispatch.

### 15.11 A program can raise its own error — `fail` (I2, I3)

`try`/`catch` has existed since L9, and every error it ever caught came from the engine.
**There was no way for a QBSK program to raise one.** So a library written in QBSK had
exactly two answers to a bad argument — return `null`, or return something wrong — and
both are the ghost feature §14 and §15 exist to remove. The doctrine those sections state,
*report rather than silently no-op*, was unavailable to programs written in the language
that states it.

Found 2026-08-19 writing anatomy module, which wanted to say
`no anatomical region 'elbow_middle'` and could only answer `null`. Every QBSK library in
this repository had the same hole: `cinematic.qbsk` and `firstperson.qbsk` validate
nothing, because until now they could not.

```
export func info(id)
    if not has(INDEX, id)
        fail("no anatomical region '" + id + "'")
    return INDEX[id]
```

A **native**, not a keyword. The 51 keywords are frozen (§17.1) and adding one could break
a program using `error` as a name, while *"adding is not breaking"* is stated of natives
exactly. It raises an ordinary runtime error, so the span points at the `fail(...)` call
and `try`/`catch` handles it like any other — which is the half that makes it a tool for
libraries rather than a louder `exit`.

Deliberately **not** an assertion taking a condition and a message. A condition is what
`if` is for, and an assertion that takes one invites the form with no message at all —
which reports that something was false instead of reporting what the author meant.

### 15.12 An entity native says when it was not given entities (I2)

Found 2026-08-19 by first spike, and it is the strongest argument §15 has for
existing: a rule stated in L9 caught a defect written before it, in a native L9 never
looked at.

`without(list, id)` and `find(list, id)` operate on ENTITIES — dicts carrying the int `id`
that `spawn` mints. Their shared helper `entityList` promised *"a list of entities"* in its
own error message and only checked that the value was a **list**, while `idOf` answers
`null` for anything that is not an entity. Both natives read that `null` as *"does not
match"*.

So `without([10, 20, 30], 1)` returned `[10, 20, 30]` — **the list unchanged, exit code 0,
no message.** The author asked to remove something and was told it worked. `find` was
worse: it answered `null`, which is exactly what it answers for an entity that died, so
the mistake arrived wearing the costume of a normal simulation event.

It was found because `without` is the name a caller reaches for when they want "remove
this element" from an ordinary list — the reading the name invites. A GOAP planner's
frontier never shrank, and the search ran to its expansion cap with no diagnostic anywhere.

The check is in `entityList`, not in the two natives, **because the defect was never in
either of them** — it was in the helper they share, and fixing it at the call sites would
have been the half-fix this project has now made three times with the cell aspect. An
empty list still passes, and an id matching nothing still passes: every entity dying is a
simulation event, and a corpse is not a bug. The message names the offending element's
INDEX and type, because §8 promises the error points at the mistake and *"expects
entities"* on a two-hundred-entity list sends the author to read all of them.

**What this does not fix, and it is a real gap:** QBSK still has no way to remove an
element at an index from a plain list. `pop` takes the last, `slice` cannot rejoin (`+` on
two lists reports, correctly), and `without` is — now visibly — for entities. Recorded in
`the roadmap 21` as a finding rather than fixed on the spot, because the planner that
found it wants swap-and-pop anyway, which is O(1) where a remove-at-index is O(n).

---

## 16. The documentation is tested (L11)

§14 and §15 removed silence from the language. This section removes it from the writing
about the language, because that turned out to be the larger surface: a review of the
three skill files found **51 false claims, 23 of them the kind that make an agent build
the wrong thing** — a skill asserting 16 natives when 77 were registered, another
describing a `terminal.ts` that never existed, a third gating on 273 tests when the suite
held 1306.

Every one of those was found by a person reading carefully. That does not scale, and it
already failed repeatedly: the same class of drift was fixed by hand in an earlier release, in §14,
in §15, and again in the skills. **Fixing an instance of drift is not the work; making
the class fail a test is.**

### 16.1 The three claims a machine can check

Not every sentence in a specification is checkable, and pretending otherwise produces a
test that blocks writing. Three kinds of claim are mechanically verifiable, and those
three are exactly the three that were repeatedly wrong:

| Claim | Verified against | Failure it prevents |
|---|---|---|
| a native exists | the live registry | documenting a function nobody wrote, or shipping one nobody documented |
| a file path exists | the filesystem | citing `docs/canvas-dsl.md`, `src/engine/terminal.ts`, `bench/ecs.md` |
| a count is current | the thing counted | "1048 tests across 42 files" when it is 1337 across 61 |

`tests/unit/docs-truth.test.ts` enforces these across `docs/*.md`, `README.md` and the
three the manual files. It is a test, not a linter: it runs in the same suite as
everything else, so drift breaks the build rather than waiting for someone to look.

### 16.2 What it deliberately does not check

- **Prose.** Whether an explanation is *good* is not a machine's call, and a test that
  tried would make the documentation worse by making it defensive.
- **Examples inside docs.** Tempting — and wrong here. A spec routinely shows syntax that
  is illegal on purpose (§14 is a catalogue of exactly that), so "every code block must
  parse" would forbid the documentation from discussing a mistake. §15's own examples
  include `sprite ... bogus_key: 5`. That is the point of them.
- **Historical statements.** A document that records what a claim *used to be* is not
  making that claim. The rule is scoped to assertions in the present tense, which is why
  the checks target specific shapes (a native call, a backticked path, a stated count)
  rather than scanning for words.

### 16.3 Why the counts live in one place

A count repeated in four documents is four things to update and three chances to forget —
and the README proved it, sitting 28% wrong for months. The test reads the real numbers
and compares; when it fails, the fix is to update the document, not the test.

The same rule the code follows (§15, invariant I1): **one source for one fact.** A number
written in a second place is not documentation, it is a copy waiting to drift.

---

## 17. v0.1 — what is frozen, and what that promises (L14)

Eight commits in this cycle carry `BREAKING CHANGE`. That was correct while the ghosts
were being removed — a language that silently ignored a named argument, dropped a
primitive written outside a layer, and let a module read the entry program's globals had
no interface worth protecting. But `package.json` has said `0.1.0` the whole time, which
means the version number was already making a promise the project was not keeping.

This section is that promise, made deliberately and narrowly. **"Stable" is not a feeling
about how polished something is; it is a statement about what will not change without a
version bump.** Everything below is either frozen, explicitly not frozen, or named as a
known gap — and the third list matters as much as the first two, because a freeze that
hides its own soft spots is worse than no freeze.

### 17.1 What v0.1 freezes

Within `0.x`, none of the following changes in a way that breaks a program that runs today:

| Frozen | Detail |
|---|---|
| **The 51 keywords** | §2.6. None is removed or repurposed; a new one is a minor bump, since it can only break a program that used the word as an identifier. **The twenty-six scene words are CONTEXTUAL** (§15.15): outside statement position every one of them is an ordinary name, which widens what parses and therefore breaks nothing |
| **Block structure** | 4-space indentation, `INDENT`/`DEDENT`, `:` for an inline single-statement block |
| **The declarative DSL** | `scene`/`layer` structure, the primitives, the three state directives (`z:`, `visible:`, `color`), `at`/`world:`, `anchor:` as a primitive property |
| **Event handlers** | `on start/tick/turn/key/resize`, the optional `when` guard, and the registration window (§7.7, §14.4) |
| **Operator meaning** | precedence (§4), `/` always returning float (§5.0), sequence repetition (§6.7), tuple arithmetic |
| **The error model** | every error carries span + fragment; suggestions where the valid set is known (§8.1) |
| **`.qba` and `.qbdata`** | the file formats, including which META keys exist (§15.9, §12) |
| **The 85 natives** | a native is not removed or given different semantics; see the exception below |
| **CLI surface** | `run`, `repl`, `lex`, `parse`, `check`, `profile`, `fmt`; `--ansi`, `--loop`, `--fps`, `--frames`, `--no-audio`, `--help`, `--version` |

**Adding is not breaking.** New natives, new primitives, new stdlib functions and new
CLI flags can land in any `0.x` release. The promise is about what *stops working*, not
about what stands still.

### 17.2 What is deliberately NOT frozen

Naming these is the honest half of the exercise:

- **`RunResult`, `SceneProgram`, and every TypeScript type.** QBSK's interface is the
  *language*; the host API is an implementation detail that Studio and the CLI happen to
  share. It will keep moving.
- **Error message wording.** The *shape* is frozen (span, fragment, suggestion when the
  set is known); the sentences are not. Tests that match on `/did you mean/` are fine;
  tests that pin a whole sentence are pinning something that was never promised.
- **The analyzer's exact findings.** `qbsk check` will report *more* over time. A program
  that runs correctly will never start failing `check` — that direction is the doctrine
  (§15.7) — but a new warning is not a breaking change.
- **Performance numbers.** §13.1 of the engine spec explains why absolute ms are not even
  comparable across sessions, let alone freezable.
- **Anything marked DESIGN.** `docs/engine.md` §17 (the ECS) specifies seven natives that
  do not exist. It is a plan, labelled as one.

### 17.3 Known gaps, stated rather than hidden

A freeze is only worth something if it admits what is soft. These are the things a v0.1
user can hit, all of them documented and none of them scheduled:

- **Integers past 2^53 lose precision silently** (§5.0). Inherited from IEEE-754 doubles;
  a grid engine's coordinates, turns and seeds live far below the line.
- **`for` over a float range rounds inward** (§5.0) — the one place a float is quietly
  accepted where an int is meant.
- **`gameTime()` is the sole camelCase native** among 85 (§6.7). Kept on purpose; the
  alternative was 141 breaking call sites for a cosmetic gain.
- **`--tokens` and `--ast` are accepted and inert.** `lex` and `parse` print
  unconditionally. Documented in §9; the flags are kept so existing invocations do not
  break, and they do nothing.
- **No formatter.** The lexer discards comments, so an AST-based `qbsk fmt` would delete
  every comment in the file. It needs comment-preserving tokens first — a real piece of
  work, not a weekend.
- **Modules cannot be circular.** Detected and reported, never silently resolved.

### 17.4 How a break would happen, if one has to

1. It is spec'd first (RULE #2), in the section that owns the behaviour.
2. The old form gets an error that *names the replacement* — the shape §14 and §15 use
   throughout, because an error that teaches the migration costs the reader one minute
   and an error that only refuses costs them an afternoon.
3. `BREAKING CHANGE` in the commit body, with what breaks and why the alternative was
   worse.
4. A minor bump within `0.x`, and every example and test updated in the same commit —
   never a deprecation period, which is a promise to maintain two languages.

**The one exception to §17.1's native freeze**: a native documented in no specification at
all may be renamed or removed, because it was never part of the interface — it was an
accident that escaped. All 80 are specced today (§15.9 closed the last five; §11.14 of the engine spec covers `plot` and `braille`), so this
exception currently applies to nothing. It exists so the rule does not have to be broken
the next time an unspecced function is discovered.

### 17.5 Why freeze now

Not because the language is finished — an earlier release has not started, and the engine's input
layer is the highest-risk work in the project. Because the *language* stopped changing
underneath the person using it, and that is a different milestone from being complete.

The five gates that make the promise checkable rather than aspirational:
**build, typecheck, lint, test, bench** — plus `docs-truth.test.ts` (§16), which fails
the build when a document starts describing a language that is not this one.

---

## 18. Properties, not cases (L15)

The suite is ~1400 tests, and every one of them is a case somebody thought of. That is
the ceiling of example-based testing: it covers the inputs a person imagined while
writing the feature, and the interesting failures are the ones nobody imagined.

`tests/unit/fuzz-frontend.test.ts` asserts **properties** instead — statements that must
hold for *every* input, checked against thousands of generated programs.

### 18.1 The four properties

| | Property | Why it is the one that matters |
|---|---|---|
| **P1** | `parse` never throws; it RETURNS errors | Every caller reads `.errors`. A throw crosses the API boundary and lands somewhere nobody is catching |
| **P2** | every reported error carries a usable span | §8's whole model. An error without a span is not an error message, it is a shrug |
| **P3** | `parse` terminates | A parser that hangs on some input is worse than one that rejects it |
| **P4** | a clean parse then runs or fails as a `QbskError` | RULE #4 stated as a property rather than as a list of known cases |

**P1 is not hypothetical, and its scar is in the source.** `parser.ts` carries a comment
recording that an unknown character typed into the Studio console threw out of `parse`,
past `evalSnippet`, past the IPC handler, and killed the Electron main process. One
character. The fix was to catch lexer errors and return them like any other syntax error;
the property is what keeps it fixed. Deleting that catch makes this file fail in under a
second, with the offending character in the output — verified by doing it.

### 18.2 The generator, and why it is seeded

Programs are built from fragments of real QBSK — declarations, DSL primitives, operators,
strings, layout — plus the characters that historically broke things: a BOM, a NUL, a
lone backslash, an unterminated `"""`, a tab, `1e999`.

**The seed is fixed on purpose.** A fuzzer that finds a different bug every run is a
fuzzer whose failures nobody can reproduce, and a red build nobody can reproduce is a red
build people learn to re-run. Change the seed deliberately to search new ground, and when
it finds something, **pin that case as its own named test** — the fuzzer's job is to
discover, the suite's job is to remember.

### 18.3 What the generator has to prove about itself

A fuzzer can pass vacuously in two ways, and both are silent:

- Generating garbage that dies at the first token proves only that the first token is
  handled. Measured instead of assumed: 2000 programs reach **29 distinct error kinds**
  and build **4030 AST nodes**.
- If nothing ever parses cleanly, P4 never executes. **60 of 2000 parse clean**, and the
  property asserts that count is above zero rather than trusting it.

Three generators would be pointless without that. The numbers are the argument that this
file tests something.

### 18.4 What it deliberately does not do

- **No shrinking.** A real fuzzing framework reduces a failing input to its minimal form.
  This one prints the source that failed and stops there, which is enough at this size and
  keeps the file dependency-free (the project has zero runtime dependencies and this is
  not the place to start).
- **No coverage target.** Chasing a percentage produces tests that exercise lines without
  asserting anything. Properties assert; that is the point.
- **The interpreter is only lightly fuzzed** (P4, 600 programs). Most random programs fail
  to parse, so reaching deep runtime behaviour needs a generator that produces *valid*
  programs — a different and larger tool, worth building when the runtime surface stops
  moving.

---

## 19. `qbsk fmt` — a checker, not a rewriter (L16)

In a language where indentation carries meaning, layout is not cosmetic: a line indented
three spaces instead of four is a different program, or no program at all. That is the
argument for a formatter, and it is a good one.

It is also why this is a **checker**. `qbsk fmt` reports layout problems with a span and
exits non-zero; it never writes to your file.

### 19.1 Why not a rewriter

The obvious design — parse, then print the AST back as source — deletes every comment in
the file. The lexer discards comments (`skipLineComment`, `skipBlockComment`); they reach
no token, no node, and no printer. `examples/` alone holds **579** of them.

A real rewriter therefore needs comment-carrying tokens or a separate CST, plus an
anchoring rule (does a comment belong to the line above, the line below, or the node it
interrupts?), plus an idempotence guarantee — `fmt(fmt(x))` must equal `fmt(x)` or the
tool fights itself in version control. That is a genuine piece of work, and it would
touch the front end immediately after §17 froze it.

A checker gets most of the value at none of that risk: it cannot corrupt a file, because
it does not open one for writing.

**This is stated as a deliberate design choice, not a stub.** If a rewriter is built
later it starts by making the lexer preserve comments — that is the prerequisite, and it
is written here so the next person does not rediscover it by deleting somebody's file.

### 19.2 What it checks

Each finding carries a span and a fragment, like every other QBSK error (§8):

| Check | Why |
|---|---|
| indentation is a multiple of 4 | §2.2's rule; three spaces is the error the language cannot see for you |
| no tabs | already a lexer error inside a block — reported here uniformly, before the program runs |
| no trailing whitespace | invisible, and it moves diffs |
| no more than one consecutive blank line | layout drift that accumulates |
| file ends in exactly one newline | the same |

It checks **layout only**. Naming, spacing inside expressions and line length are style
opinions, and a tool that enforces opinions in a language this young would be arguing
about taste while the language is still settling.

### 19.3 Usage

```bash
qbsk fmt file.qbsk        # report layout problems, exit 1 if any
qbsk fmt examples/        # every .qbsk under a directory
```

Exit code 0 means clean. There is no `--write`: see §19.1.
