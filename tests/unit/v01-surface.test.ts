// The v0.1 surface is frozen (docs/language.md §17).
//
// Eight commits in the hardening cycle carried BREAKING CHANGE, and that was correct —
// a language that silently ignored named arguments and let modules read the entry
// program's globals had no interface worth protecting. But `package.json` said 0.1.0
// the whole time, so the version number was already promising something the project
// was not keeping.
//
// This file is what turns §17 from a paragraph into a promise: the frozen surface is
// enumerated HERE, and a change to it fails the build. Not to forbid change — §17.4
// describes exactly how a break happens — but to make it impossible by ACCIDENT.
//
// If one of these fails, the question is never "how do I make the test pass?". It is
// "is this a deliberate break, spec'd and versioned per §17.4?".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYWORDS } from "../../src/lexer/token.js";
import { createNatives } from "../../src/interp/natives.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** The 51 keywords of §2.6, written out so a removal is visible in the diff. */
const FROZEN_KEYWORDS = [
  "scene", "layer", "sprite", "box", "border", "line", "text", "tone", "shade",
  "fill", "put", "canvas", "color", "anchor", "at", "from", "to", "z", "style",
  "visible", "world", "on", "tick", "key", "resize", "start", "when",
  "if", "elif", "else", "while", "for", "in", "return", "match", "use",
  "break", "continue", "and", "or", "not", "var", "const", "func",
  "export", "as", "try", "catch", "true", "false", "null",
];

/** The 84 natives of §17.1. Adding is not breaking; removing or renaming is. */
const FROZEN_NATIVES = [
  // core
  "print", "len", "type", "str", "int", "float", "bool", "clock", "gameTime", "args", "exit",
  "fail",
  // canvas natives
  "canvas", "fill", "box", "put", "line",
  // string
  "upper", "lower", "trim", "split", "join", "replace", "contains", "starts_with", "ends_with",
  // list / dict
  "push", "pop", "sort", "reverse", "map", "filter", "reduce", "slice", "keys", "values",
  "has", "find", "without",
  // math
  "abs", "sqrt", "exp", "log", "min", "max", "round", "floor", "ceil", "sin", "cos", "tan",
  "atan2", "pi",
  "random",
  // seeded rng
  "rng", "roll_float", "roll_int",
  // persistence
  "save_state", "load_state", "list_saves",
  // animation
  "animate", "animate_done", "animate_reset",
  "timeline_wait", "timeline_step", "timeline_sequence", "timeline_parallel",
  "timeline_duration", "timeline_active", "timeline_progress",
  // sim / ecs / engine bridge
  "turn", "advance", "spawn", "path", "sight", "host", "particle", "project", "glyph", "lit",
  // subcell resolution (§11.14, an earlier release) — the first additions since the freeze.
  // "Adding is not breaking" (§17.1), but the addition is deliberate and shows up here.
  "plot", "braille",
  // orientation glyphs (§11.16, an earlier release)
  "stroke_glyph",
  // first-person wall casting (§11.21, an earlier release). The DDA is here because QBSK cannot
  // run it per column per frame; the drawing stays in QBSK, which can already say it.
  "raycast",
];

const out = (source: string): string[] => {
  const r = runQbsk(source, "v01.qbsk");
  expect(r.error).toBeNull();
  return r.out;
};

describe("the frozen keyword set (§17.1)", () => {
  it("every frozen keyword is still a keyword", () => {
    const live = new Set(Object.keys(KEYWORDS));
    const removed = FROZEN_KEYWORDS.filter((k) => !live.has(k));
    expect(removed, "removing a keyword is a BREAKING CHANGE (§17.4)").toEqual([]);
  });

  it("the count matches — a new keyword is a deliberate minor bump", () => {
    // Not a ban on adding: a new keyword can only break a program that used the word
    // as an identifier, which §17.1 calls a minor bump. This makes it visible.
    expect(Object.keys(KEYWORDS).length).toBe(FROZEN_KEYWORDS.length);
  });
});

describe("the frozen native set (§17.1)", () => {
  it("every frozen native is still registered", () => {
    const live = createNatives({ print: () => {} }, {}).names();
    const missing = FROZEN_NATIVES.filter((n) => !live.includes(n));
    expect(missing, "removing a native is a BREAKING CHANGE (§17.4)").toEqual([]);
  });

  it("nothing was renamed behind the list's back", () => {
    const live = createNatives({ print: () => {} }, {}).names();
    expect(live.length).toBe(FROZEN_NATIVES.length);
  });
});

describe("the frozen semantics (§17.1)", () => {
  it("division always returns float", () => {
    expect(out("print(str(4 / 2))")).toEqual(["2.0"]);
  });

  it("int arithmetic stays int", () => {
    expect(out("print(type(2 + 3))")).toEqual(["int"]);
  });

  it("sequence repetition works on strings and lists, either order", () => {
    expect(out('print("ab" * 2)\nprint(str([1] * 2))\nprint(str(2 * [1]))')).toEqual([
      "abab",
      "[1, 1]",
      "[1, 1]",
    ]);
  });

  it("tuples do vector arithmetic", () => {
    expect(out("print(str((10, 5) + (1, 0)))")).toEqual(["(11, 5)"]);
  });

  it("a range is exclusive at the top", () => {
    expect(out('var s = ""\nfor i in 0..3\n    s = s + str(i)\nprint(s)')).toEqual(["012"]);
  });

  it("string interpolation and its symmetric escape", () => {
    expect(out('var n = "Ada"\nprint("hi {n}")\nprint("{{literal}}")')).toEqual([
      "hi Ada",
      "{literal}",
    ]);
  });

  it("modules export explicitly and hide the rest", () => {
    // §9's contract, and §15.5's correction to it: what is exported is reachable,
    // what is not is not, and neither direction leaks.
    const FIXTURES = join(ROOT, "tests", "fixtures");
    const reach = runQbsk(
      [
        'use "lib/frozen_module.qbsk"',
        "print(str(frozen_module.answer))",
        "print(str(frozen_module.helper(1)))",
      ].join("\n"),
      join(FIXTURES, "entry.qbsk"),
      undefined,
      { baseDir: FIXTURES },
    );
    expect(reach.error).toBeNull();
    expect(reach.out).toEqual(["7", "43"]);

    const hidden = runQbsk(
      ['use "lib/frozen_module.qbsk"', "print(str(frozen_module.secret))"].join("\n"),
      join(FIXTURES, "entry.qbsk"),
      undefined,
      { baseDir: FIXTURES },
    );
    expect(hidden.error).not.toBeNull();
    expect(hidden.error!.message).toMatch(/no exported member 'secret'/);
  });
});

describe("the frozen error model (§17.1, §8)", () => {
  it("every error carries a span", () => {
    const r = runQbsk("print(str(nope))", "v01.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.span.start.line).toBe(1);
    expect(r.error!.span.start.col).toBeGreaterThan(0);
  });

  it("a suggestion appears where the valid set is known", () => {
    const r = runQbsk("var total = 1\nprint(str(totl))", "v01.qbsk");
    expect(r.error!.message).toMatch(/did you mean 'total'\?/);
  });
});

describe("the frozen CLI surface (§17.1)", () => {
  it("the commands and value flags are the documented ones", () => {
    // Read from the source rather than re-implemented, so this tracks the real set.
    const args = readFileSync(join(ROOT, "src", "cli", "args.ts"), "utf8");
    for (const cmd of ["run", "repl", "lex", "parse", "check", "profile", "fmt"]) {
      expect(args).toContain(`"${cmd}"`);
    }
    for (const flag of ["fps", "frames"]) {
      expect(args).toContain(`"${flag}"`);
    }
  });
});

describe("the version claim (§17)", () => {
  it("package.json and the spec agree on 0.1", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.version).toMatch(/^0\.1\./);
    const spec = readFileSync(join(ROOT, "docs", "language.md"), "utf8");
    expect(spec).toContain("## 17. v0.1 — what is frozen");
  });
});
