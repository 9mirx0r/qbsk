// L9 — the hardening (docs/language.md §15).
//
// §14 hunted named ghosts. This file pins the three INVARIANTS that close the
// categories those ghosts belonged to, so the next construct inherits the rule
// instead of waiting for the next review:
//
//   I1  every named argument belongs to a closed set
//   I2  every value a construct evaluates is either used or reported
//   I3  no host error reaches the author

import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../src/parser/parser.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples"),
);

const run = (source: string) =>
  runQbsk(source, "l9.qbsk", undefined, { baseDir: EXAMPLES });

/** A scene wrapper — most primitives only exist inside a layer (§15.2). */
const inLayer = (...lines: string[]) =>
  ["scene S(width: 12, height: 4)", "layer a z: 1", ...lines.map((l) => `    ${l}`)].join(
    "\n",
  );

// ---------------------------------------------------------------------------
// I1 — every named argument belongs to a closed set (§15.1)
// ---------------------------------------------------------------------------

describe("a named argument belongs to a closed set (§15.1)", () => {
  it("sprite rejects an unknown property and lists the real ones", () => {
    const r = run(inLayer('sprite "res/hero.qba" at (0, 0) bogus_key: 5'));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/'bogus_key:' is not a property of 'sprite'/);
    expect(r.error!.message).toMatch(/anchor/);
  });

  it("tone, shade and color reject unknown keys too — the rule is not per-primitive", () => {
    // The whole point of §15: a whitelist written for one construct and not its
    // siblings was never a fix, it was one example of a fix.
    const tone = run(inLayer("tone 440 bogus: 5"));
    expect(tone.error!.message).toMatch(/'bogus:' is not a property of 'tone'/);

    const shade = run(inLayer("shade radial bogus: 5"));
    expect(shade.error!.message).toMatch(/'bogus:' is not a property of 'shade'/);

    const color = run(inLayer("color bogus: red"));
    expect(color.error!.message).toMatch(/'bogus:' is not a property of 'color'/);
  });

  it("a near-miss gets the suggestion", () => {
    const r = run(inLayer('sprite "res/hero.qba" at (0, 0) ancho: center'));
    expect(r.error!.message).toMatch(/did you mean 'anchor:'/);
  });

  it("a repeated key is reported instead of last-one-wins", () => {
    const r = run(inLayer("tone 440 volume: 0.2 volume: 0.9"));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/repeated/);
  });

  it("an unknown box/border style is refused, not silently 'single'", () => {
    // `BORDER_STYLES[v] ?? "single"` made a typo draw a box that looked deliberate.
    const r = run(inLayer("box (0, 0) to (5, 3) style: fancy_nonexistent"));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/fancy_nonexistent/);
    expect(r.error!.message).toMatch(/single|double|rounded/);
  });

  it("every real property still works", () => {
    const r = run(
      inLayer(
        'sprite "res/walk.qba" at (0, 0) anchor: center scale: (1, 1) frames: 4 fps: 8 loop: true',
        "tone 440 wave: square duration: 0.1 volume: 0.2 loop: false",
        "color fg: cyan bg: blue",
        "box (0, 0) to (4, 2) style: double",
        'put "x" at (0, 0) depth: 2',
      ),
    );
    expect(r.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I2 — a primitive outside a layer is an error (§15.2)
// ---------------------------------------------------------------------------

describe("a primitive draws into a layer or it says so (§15.2)", () => {
  it("a bare put at the top level is an error, not a silent discard", () => {
    const r = run(['put "ghost" at (0, 0)', 'print("done")'].join("\n"));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/'put' draws into a layer/);
  });

  it("the same holds directly inside a scene body", () => {
    const r = run(
      [
        "scene S(width: 8, height: 3)",
        '    put "ghost" at (0, 0)',
        "    layer a z: 1",
        '        fill "."',
      ].join("\n"),
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/draws into a layer/);
  });

  it("world: is a coordinate space, not a licence to draw outside a layer", () => {
    const outside = run('put "TITLE" world: (2, 1)');
    expect(outside.error).not.toBeNull();

    const inside = run(
      [
        "scene S(width: 12, height: 4)",
        "layer hud z: 9 at (0, 2)",
        '    put "TITLE" world: (2, 1)',
      ].join("\n"),
    );
    expect(inside.error).toBeNull();
  });

  it("the canvas natives are untouched — they are functions, not primitives", () => {
    // `fill` is both a DSL primitive and a native. The native takes a canvas as its
    // first argument and is an ordinary call, so the layer rule must not touch it.
    const r = run(
      ["var c = canvas(6, 2)", 'fill(c, ".")', 'put(c, "x", (0, 0))'].join("\n"),
    );
    expect(r.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I2 — a named argument's value is an expression (§15.3)
// ---------------------------------------------------------------------------

describe("a named argument's value is an expression (§15.3)", () => {
  it("a variable works as a sprite frame count", () => {
    // This used to fail with "'frames' must be an int, got 'str'" because a bare
    // identifier was read as the literal string "count".
    const r = run(
      [
        "var count = 4",
        "scene S(width: 12, height: 4)",
        "layer a z: 1",
        '    sprite "res/walk.qba" at (0, 0) frames: count fps: 8 loop: true',
      ].join("\n"),
    );
    expect(r.error).toBeNull();
  });

  it("an expression works too", () => {
    const r = run(
      [
        "var n = 2",
        "scene S(width: 12, height: 4)",
        "layer a z: 1",
        '    sprite "res/walk.qba" at (0, 0) frames: n * 2',
      ].join("\n"),
    );
    expect(r.error).toBeNull();
  });

  it("anchor: and tint: still take a bare word — they are vocabularies, not values", () => {
    const r = run(
      inLayer('sprite "res/hero.qba" at (0, 0) anchor: center', "shade radial tint: blue"),
    );
    expect(r.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I3 — no host error reaches the author (§15.4)
// ---------------------------------------------------------------------------

describe("errors the host raises are still QBSK errors (§15.4)", () => {
  it("duplicate parameters report with a span", () => {
    const r = run(["func f(a, a)", "    return a", "print(str(f(1, 2)))"].join("\n"));
    expect(r.error).not.toBeNull();
    expect(r.error!.span).toBeDefined();
    expect(r.error!.span.start.line).toBe(1);
    expect(r.error!.message).toMatch(/parameter 'a'/);
  });

  it("a string repeated past the host limit reports with a span", () => {
    const r = run('var s = "a" * 999999999');
    expect(r.error).not.toBeNull();
    expect(r.error!.span.start.line).toBe(1);
    expect(r.error!.message).not.toMatch(/Invalid string length/);
  });

  it("runaway recursion reports at a documented depth, not V8's", () => {
    const r = run(
      ["func deep(n)", "    return deep(n + 1)", "print(str(deep(0)))"].join("\n"),
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/recursion|call depth/i);
    expect(r.error!.message).not.toMatch(/Maximum call stack/);
  });
});

// ---------------------------------------------------------------------------
// I2 — a module cannot see the entry program (§15.5)
// ---------------------------------------------------------------------------

describe("a module cannot see the entry program (§15.5)", () => {
  it("an entry-program global is invisible to a module", () => {
    // The probe lives in tests/fixtures, not examples/: it is deliberately a program
    // that must NOT check clean, so it has no business in a directory where every
    // file is expected to run.
    const FIXTURES = resolve(
      join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"),
    );
    const r = runQbsk(
      [
        "var entry_secret = 99",
        'use "lib/leak_probe.qbsk"',
        "print(str(leak_probe.peek()))",
      ].join("\n"),
      join(FIXTURES, "entry.qbsk"),
      undefined,
      { baseDir: FIXTURES },
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/entry_secret/);
  });

  it("shadowing a native at the top level is legal — the entry has its own scope", () => {
    const r = run(["var len = 5", "print(str(len))"].join("\n"));
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["5"]);
  });
});

// ---------------------------------------------------------------------------
// I2 — len and indexing count the same thing (§15.6)
// ---------------------------------------------------------------------------

describe("len and indexing agree on what a character is (§15.6)", () => {
  it("len counts code points, so len - 1 is the last index", () => {
    const r = run(
      ["var s = \"a💚b\"", "print(str(len(s)))", "print(s[len(s) - 1])"].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["3", "b"]);
  });

  it("plain ASCII is unaffected", () => {
    const r = run(['var s = "abc"', "print(str(len(s)))", "print(s[2])"].join("\n"));
    expect(r.out).toEqual(["3", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Smaller borders (§15.8)
// ---------------------------------------------------------------------------

describe("smaller borders, same principle (§15.8)", () => {
  it("a UTF-8 BOM is consumed, not reported as an invisible character", () => {
    const r = run("\uFEFFprint(\"ok\")");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["ok"]);
  });

  it("modulo by zero says modulo, not division", () => {
    const r = run("print(str(1 % 0))");
    expect(r.error!.message).toMatch(/modulo by zero/);
  });

  it("a parser error names indentation instead of printing 'null'", () => {
    const parsed = parse("scene G(width: 40, height: 10 title: \"x\")", "l9.qbsk");
    for (const e of parsed.errors) {
      expect(e.message).not.toMatch(/'null'/);
    }
  });

  it("spans narrow to the offending part, not the whole statement", () => {
    const r = run(inLayer('sprite 42 at (0, 0)'));
    expect(r.error).not.toBeNull();
    // The path expression starts after `sprite `, so a narrow span starts past col 5.
    expect(r.error!.span.start.col).toBeGreaterThan(5);
  });
});
