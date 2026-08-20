# QBSK — a tour

This is the outside-in introduction: what a program looks like, then how to make it do
things. It assumes you can program in *something* and nothing about QBSK.

If you want the formal rules — the grammar, the precedence table, the error model — read
[`language.md`](language.md) instead. That is the specification; this is the tour.

**Every program on this page runs.** They are files in `examples/`, checked by the same
test suite as the language itself, so none of them can rot into syntax that no longer
works.

---

## 1. Hello, grid

QBSK draws on a character grid. There is no `main`, no imports, no boilerplate — running
the file *is* running the program.

```qbsk
scene Hello(width: 20, height: 3)

layer greeting z: 1
    fill "."
    text "hello" at (2, 1)
```

```
....................
..hello.............
....................
```

Three things are already visible:

- **`scene`** declares the canvas. Width and height are required; `title:` and `fps:` are
  optional and reach the host.
- **`layer`** groups what gets drawn, and `z:` decides what covers what — higher wins.
- **Indentation is structure.** Four spaces, always. The primitives belong to the layer
  because they are indented under it.

Run it with:

```bash
qbsk run examples/hello.qbsk
```

## 2. Values and variables

```qbsk
var name = "world"          // a variable
const MAX = 10              // a constant; reassigning it is an error

var count = 3               // int
var ratio = 0.5             // float — a DIFFERENT type, always
var flag = true             // bool
var items = [1, 2, 3]       // list
var scores = {"ana": 10}    // dict
var pos = (4, 2)            // tuple — the coordinate type
```

Strings interpolate with `{}`:

```qbsk
var name = "Ada"
print("hello {name}, you have {1 + 1} messages")
// hello Ada, you have 2 messages
```

**`int` and `float` never blur into each other.** `4 / 2` is `2.0`, not `2` — division
always produces a float so that `a / b` has one type regardless of the values. Where the
language needs an int, such as a grid position, a float is refused rather than truncated.
The full story is [§5.0](language.md).

## 3. Control flow

```qbsk
if score > 10
    print("high")
elif score > 5
    print("medium")
else
    print("low")

for i in 0..3               // 0, 1, 2 — the top is exclusive
    print(str(i))

for i, item in ["a", "b"]   // index and value together
    print(str(i) + ": " + item)

while lives > 0
    lives = lives - 1
```

`match` handles the multi-branch case. Each arm's pattern ends in `:`:

```qbsk
var command = "look"

match command
    "north":
        print("you go north")
    "look":
        print("you see a room")
    else:
        print("unknown")
```

## 4. Functions

```qbsk
func greet(name)
    return "hello " + name

func add(a, b)
    return a + b

print(greet("world"))
print(str(add(2, 3)))
```

Single-expression functions can be anonymous:

```qbsk
var double = func(n) n * 2
print(str(map([1, 2, 3], double)))     // [2, 4, 6]
```

## 5. Drawing

Everything that draws lives inside a layer — writing a primitive outside one is an error,
not a no-op:

```qbsk
scene Art(width: 24, height: 8)

layer background z: 0
    fill " "

layer shapes z: 5
    color fg: cyan
    box (1, 1) to (10, 5) style: double
    line (12, 1) to (22, 5)
    text "QBSK" at (14, 6)

layer marks z: 10
    color fg: bright-yellow
    put "*" at (5, 3)
```

- **`color`** is a *state directive*: it styles every primitive **below** it in the same
  layer, until another `color` replaces it. Written after its primitives, it does
  nothing — and `qbsk check` will tell you so.
- **`box`/`border`** take a `style:` of `single`, `double` or `rounded`.
- **`put`** places one glyph, **`text`** places a string.

## 6. Making it move

A scene composes once. To animate it, run the frame loop and give it handlers:

```qbsk
var x = 0

scene Move(width: 20, height: 3, fps: 30)

layer bg z: 0
    fill "."

layer dot z: 1
    put "@" at (x, 1)

on tick(dt)
    x = x + 1
    if x > 19
        x = 0

on key "space"
    x = 0
```

```bash
qbsk run examples/tour_move.qbsk --ansi --loop
```

The scene is **re-composed every frame** from the current variables. You do not erase and
redraw; you change the value and the frame follows.

Handlers are `on start`, `on tick(dt)`, `on key "name"`, `on turn(n)` and
`on resize(w, h)`, and each takes an optional guard:

```qbsk
on key "space" when lives > 0
    jump()
```

## 7. Time and animation

`gameTime()` is the loop clock in seconds. `animate` interpolates a named value:

```qbsk
// straight from the clock
var bob = int(gameTime() * 2) % 2

// or eased, over a duration
var slide = animate("hero_x", 0.0, 40.0, 2.0, "ease-out")
```

The easings are `linear`, `ease-in`, `ease-out`, `ease-in-out`, `bounce` and `elastic`.
`examples/easings.qbsk` races all six side by side.

## 8. Randomness you can reproduce

`random()` exists and is genuinely random, which makes it useless for a game you want to
test. Use a **seeded** generator instead — same seed, same world, every time:

```qbsk
var r = rng(1234)
for i in 0..5
    print(str(roll_int(r, 1, 6)))     // the same five rolls on every run
```

That is what makes a generated map testable byte for byte.

## 9. Splitting a program up

```qbsk
// lib/helpers.qbsk
export const VERSION = 1

export func clamp(n, lo, hi)
    if n < lo
        return lo
    if n > hi
        return hi
    return n
```

```qbsk
use "lib/helpers.qbsk"
print(str(helpers.clamp(15, 0, 10)))     // 10
```

A module runs in its own scope. Only `export`ed `const` and `func` are visible, and the
module cannot see the importing program's variables either — the isolation goes both ways.

## 10. Errors that point at the problem

QBSK's errors carry the line, the column, the source, and a suggestion when it can make
one:

```
demo.qbsk:2:11 — runtime: variable 'totl' is not defined — did you mean 'total'?
  |
2 | print(str(totl + 1))
  |           ^^^^
```

Two commands catch problems before you run anything:

```bash
qbsk check demo.qbsk      # undefined names, arity, dead directives
qbsk fmt demo.qbsk        # indentation, tabs, trailing whitespace
```

`check` is the one worth running often. It knows about mistakes the language cannot see
at parse time — a `color` that styles nothing, a key name no keyboard produces, a
variable that does not exist.

## 11. Where to go next

| You want | Read |
|---|---|
| The formal rules | [`language.md`](language.md) — grammar, types, precedence, error model |
| How drawing works underneath | [`engine.md`](engine.md) — buffers, diffing, ANSI |
| Sound | [`audio.md`](audio.md) |
| The editor and the agent API | [`studio.md`](studio.md) |
| Working programs | `examples/` — 35 of them, all runnable |

The examples are the best documentation the project has, because they are executed by the
test suite: `examples/turns.qbsk` for a turn-based loop, `examples/caves.qbsk` for seeded
generation, `examples/main_menu.qbsk` for a complete game shell.
