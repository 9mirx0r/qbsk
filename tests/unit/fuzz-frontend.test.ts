// Property-based fuzzing of the front end (docs/language.md §18).
//
// The suite is ~1400 cases someone thought of. This file covers the ones nobody thought
// of, by asserting PROPERTIES that must hold for every input rather than answers for
// specific ones:
//
//   P1  `parse` never throws — it RETURNS errors. A caller reads `.errors`.
//   P2  every reported error carries a usable span.
//   P3  `parse` terminates.
//   P4  a program that parses clean either runs or fails as a QBSK error.
//
// P1 is not hypothetical. `parser.ts:271` carries the scar: an unknown character typed
// into the Studio console threw out of `parse`, past evalSnippet, past the IPC handler,
// and killed the Electron main process. One character. A fuzzer would have found it in
// a second, which is the argument for this file.

import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { runQbsk } from "../../src/interp/interpreter.js";
import { QbskError } from "../../src/interp/error.js";
import { mulberry32 } from "../../src/util/random.js";

/**
 * A fixed seed, on purpose: a fuzzer that finds a different bug every run is a fuzzer
 * whose failures nobody can reproduce. Change the seed deliberately to search new
 * ground, and pin any case it finds as its own test.
 */
const SEED = 0x9b5c;

/** The alphabet a QBSK program is made of, plus the characters that break it. */
const FRAGMENTS = [
  // structure
  "scene S(width: 4, height: 2)", "layer a z: 1", "on tick(dt)", "on key \"a\"",
  "func f(a, b)", "if x > 1", "elif y", "else", "while n < 3", "for i in 0..3",
  "try", "catch e", "match v", "return", "break", "continue",
  // declarations and expressions
  "var x = 1", "const k = 2", "x = x + 1", "print(str(x))", "x += 1",
  "[1, 2, 3]", '{"a": 1}', "(1, 2)", "func(n) n * 2", "0..10",
  // DSL
  'fill "."', 'put "x" at (0, 0)', 'text "hi" world: (1, 1)', "box (0,0) to (2,2)",
  'sprite "res/hero.qba" at (0, 0) anchor: center', "tone 440 wave: square",
  "color fg: cyan", "z: 3", "visible: false", "shade radial x: 1",
  // strings and interpolation
  '"plain"', '"hi {name}"', '"{{escaped}}"', '"""', '"unterminated',
  // operators and punctuation
  "+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=", "&", "|", "^", "<<", ">>",
  "(", ")", "[", "]", "{", "}", ",", ":", ".", "..", "=",
  // whitespace and layout — the lexer's indentation stack is the interesting part
  "    ", "\t", "        ", "", "  ",
  // hostile
  "\uFEFF", "ñ", "💚", "\\", "//", "/*", "*/", "0x10", "1e999", "999999999999999999999",
  "\u0000", "\r",
];

const pick = <T>(rand: () => number, xs: readonly T[]): T =>
  xs[Math.floor(rand() * xs.length)]!;

/** A random program: fragments joined by newlines and spaces, mostly nonsense. */
function randomSource(rand: () => number): string {
  const lines = 1 + Math.floor(rand() * 8);
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const parts = 1 + Math.floor(rand() * 4);
    let line = "";
    for (let j = 0; j < parts; j += 1) {
      line += pick(rand, FRAGMENTS);
      if (rand() < 0.5) {
        line += " ";
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

describe("the parser never throws, it returns errors (§18, P1)", () => {
  it("survives 2000 random programs", () => {
    const rand = mulberry32(SEED);
    const crashes: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const source = randomSource(rand);
      try {
        parse(source, "fuzz.qbsk");
      } catch (err) {
        crashes.push(
          `${(err as Error).constructor.name}: ${(err as Error).message}\n--- source ---\n${source}`,
        );
      }
    }
    expect(crashes.slice(0, 3)).toEqual([]);
  });

  it("survives every single character on its own", () => {
    // The shape of the Studio crash: ONE character, thrown from tokenize.
    const crashes: string[] = [];
    for (let code = 0; code < 0x250; code += 1) {
      const ch = String.fromCodePoint(code);
      try {
        parse(ch, "fuzz.qbsk");
      } catch (err) {
        crashes.push(`U+${code.toString(16)}: ${(err as Error).message}`);
      }
    }
    expect(crashes.slice(0, 5)).toEqual([]);
  });

  it("survives truncation at every prefix of a real program", () => {
    // Half-typed source is what an editor sends on every keystroke.
    const program = [
      "scene S(width: 8, height: 3)",
      "layer a z: 1",
      '    put "x" at (0, 0) depth: 2',
      "on key \"a\"",
      "    print(\"hi {name}\")",
    ].join("\n");
    const crashes: string[] = [];
    for (let n = 0; n <= program.length; n += 1) {
      try {
        parse(program.slice(0, n), "fuzz.qbsk");
      } catch (err) {
        crashes.push(`prefix ${n}: ${(err as Error).message}`);
      }
    }
    expect(crashes.slice(0, 3)).toEqual([]);
  });

  it("survives deep nesting without a host stack overflow", () => {
    // Recursive descent has a real limit; it must report rather than crash.
    for (const depth of [50, 200, 500]) {
      const source = "print(" + "(".repeat(depth) + "1" + ")".repeat(depth) + ")";
      expect(() => parse(source, "fuzz.qbsk")).not.toThrow();
    }
  });
});

describe("every reported error is usable (§18, P2)", () => {
  it("2000 random programs produce only well-formed errors", () => {
    const rand = mulberry32(SEED ^ 0x1234);
    const bad: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const source = randomSource(rand);
      const result = parse(source, "fuzz.qbsk");
      for (const err of result.errors) {
        const s = err.span;
        if (
          !(err instanceof QbskError) ||
          s === undefined ||
          s.start.line < 1 ||
          s.start.col < 1 ||
          s.end.line < s.start.line ||
          err.message.length === 0 ||
          err.message.includes("undefined") ||
          err.message.includes("[object Object]")
        ) {
          bad.push(`${err.message} @ ${s?.start.line}:${s?.start.col}\n${source}`);
        }
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it("no error message leaks the word 'null' as a token name", () => {
    // §15.8 fixed this for punctuation and layout tokens; the property keeps it fixed.
    const rand = mulberry32(SEED ^ 0xabcd);
    const leaks: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const source = randomSource(rand);
      for (const err of parse(source, "fuzz.qbsk").errors) {
        if (/'null'/.test(err.message)) {
          leaks.push(`${err.message}\n--- source ---\n${source}`);
        }
      }
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });
});

describe("the parser terminates (§18, P3)", () => {
  it("2000 random programs each finish well under a second", () => {
    const rand = mulberry32(SEED ^ 0x5555);
    let worst = 0;
    let worstSource = "";
    for (let i = 0; i < 2000; i += 1) {
      const source = randomSource(rand);
      const started = performance.now();
      parse(source, "fuzz.qbsk");
      const ms = performance.now() - started;
      if (ms > worst) {
        worst = ms;
        worstSource = source;
      }
    }
    expect(worst, `slowest parse was ${worst.toFixed(1)}ms:\n${worstSource}`).toBeLessThan(
      250,
    );
  });
});

describe("a clean parse runs or fails as a QBSK error (§18, P4)", () => {
  it("never a raw host error", () => {
    // RULE #4 as a property: whatever a random program does, the failure is ours.
    const rand = mulberry32(SEED ^ 0x7777);
    const leaks: string[] = [];
    let ran = 0;
    for (let i = 0; i < 600; i += 1) {
      const source = randomSource(rand);
      if (parse(source, "fuzz.qbsk").errors.length > 0) {
        continue;
      }
      ran += 1;
      try {
        const r = runQbsk(source, "fuzz.qbsk");
        if (r.error !== null && !(r.error instanceof QbskError)) {
          leaks.push(`non-QBSK error: ${String(r.error)}\n${source}`);
        }
      } catch (err) {
        leaks.push(`threw: ${(err as Error).message}\n--- source ---\n${source}`);
      }
    }
    expect(leaks.slice(0, 3)).toEqual([]);
    // Guard the guard: if the generator stopped producing parseable programs this
    // whole property would pass vacuously.
    expect(ran, "the generator produced no parseable programs").toBeGreaterThan(0);
  });
});
